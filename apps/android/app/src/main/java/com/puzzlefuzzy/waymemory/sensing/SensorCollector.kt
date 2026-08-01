package com.puzzlefuzzy.waymemory.sensing

import android.Manifest
import android.app.Activity
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import kotlin.math.sqrt

private const val ROTATION_SOURCE_FRESHNESS_NS = 750_000_000L

/** Transform a device-frame acceleration vector into the rotation matrix's world frame. */
internal fun transformDeviceAcceleration(
    rotationMatrix: FloatArray,
    deviceAcceleration: List<Float>,
): FloatArray? {
    if (rotationMatrix.size < 9 || deviceAcceleration.size < 3) return null
    if (rotationMatrix.take(9).any { !it.isFinite() } || deviceAcceleration.take(3).any { !it.isFinite() }) return null
    return floatArrayOf(
        rotationMatrix[0] * deviceAcceleration[0] + rotationMatrix[1] * deviceAcceleration[1] + rotationMatrix[2] * deviceAcceleration[2],
        rotationMatrix[3] * deviceAcceleration[0] + rotationMatrix[4] * deviceAcceleration[1] + rotationMatrix[5] * deviceAcceleration[2],
        rotationMatrix[6] * deviceAcceleration[0] + rotationMatrix[7] * deviceAcceleration[1] + rotationMatrix[8] * deviceAcceleration[2],
    )
}

/**
 * Decide whether a rotation-vector callback may replace the currently selected
 * source. The rule is pure so callback ordering and source failover can be
 * regression-tested without constructing Android framework services.
 */
internal fun shouldAcceptRotationSource(
    currentPriority: Int,
    currentTimestampNs: Long,
    incomingPriority: Int,
    incomingTimestampNs: Long,
    freshnessNs: Long = ROTATION_SOURCE_FRESHNESS_NS,
): Boolean {
    if (incomingPriority <= 0 || incomingTimestampNs <= 0L) return false
    val currentFresh = currentPriority > 0
        && incomingTimestampNs >= currentTimestampNs
        && incomingTimestampNs - currentTimestampNs <= freshnessNs
    if (incomingPriority < currentPriority && currentFresh) return false
    if (incomingPriority <= currentPriority && incomingTimestampNs <= currentTimestampNs) return false
    return true
}

/**
 * Network location is useful as a diagnostic/fallback only. When a GPS
 * provider exists, allowing a network fix to establish the route origin can
 * create a false jump when the first satellite fix arrives later.
 */
internal fun isPrimaryLocationProvider(provider: String?): Boolean =
    provider?.equals("gps", ignoreCase = true) == true

/**
 * A raw accelerometer minus a lagging gravity estimate is not trustworthy
 * during a fast hand rotation. A device-provided linear-acceleration stream
 * has already removed gravity and is handled by a separate path.
 */
internal fun canUseAccelerometerFallbackDuringRotation(
    angularRateMagnitude: Float,
    maxAngularRateRadPerSecond: Float = 1.25f,
): Boolean = angularRateMagnitude.isFinite() && angularRateMagnitude <= maxAngularRateRadPerSecond

internal fun buildVisualStatusSample(status: VisualTrackingStatus, timestampNs: Long): CollectedSample? {
    if (timestampNs <= 0L) return null
    return CollectedSample(
        deviceTimestampNs = timestampNs,
        sensorType = "arcore.visual-status",
        values = emptyList(),
        metadata = buildMap {
            put("available", status.available)
            put("active", status.active)
            put("trackingState", status.trackingState.take(64))
            status.failureReason?.takeIf(String::isNotBlank)?.let { put("failureReason", it.take(128)) }
            put("detail", status.detail.take(256))
        },
    )
}

class SensorCollector(context: Context) : SensorEventListener, LocationListener {
    private val appContext = context.applicationContext
    private val sensorManager = appContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val locationManager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val credentialStore = DeviceCredentialStore(appContext)
    private val state = MutableStateFlow(SensorUiState(deviceCredentialConfigured = credentialStore.hasToken()))
    private val readings = linkedMapOf<String, SensorReading>()
    private val sensorInventory = mutableListOf<SensorInventorySample>()
    private val registeredSensorKeys = mutableSetOf<String>()
    private val poseFusion = PoseFusionEngine()
    private var sensorThread: HandlerThread? = null
    private var sensorHandler: Handler? = null
    private val uploader = SessionUploader(
        storageDirectory = File(appContext.filesDir, "capture-queue"),
        credentialStore = credentialStore,
        onSessionLifecycle = ::onSessionLifecycle,
        onCaptureBlocked = ::onCaptureBlocked,
    )
    private val transportLimiter = SensorTransportRateLimiter()
    private val visualCollector = ArCorePoseCollector(
        appContext = appContext,
        onPose = ::onVisualPose,
        onStatus = ::onVisualStatus,
    )
    private var lastPublishedLocation: Location? = null
    private val rotationMatrix = FloatArray(9)
    private val gravity = FloatArray(3)
    private val magneticField = FloatArray(3)
    private var hasRotationMatrix = false
    private var hasRotationVector = false
    private var rotationSourcePriority = 0
    private var rotationSourceTimestampNs = 0L
    private var hasMagneticField = false
    private var hasLinearAccelerationSensor = false
    private var stepDetectorRegistered = false
    private val dynamicSensorCallback = object : SensorManager.DynamicSensorCallback() {
        override fun onDynamicSensorConnected(sensor: Sensor) {
            if (!state.value.collecting) return
            val handler = sensorHandler ?: return
            registerSensor(sensor, handler)
            state.value = state.value.copy(
                availableSensorCount = availableSensorCount(),
                readings = readings.values.toList(),
            )
        }

        override fun onDynamicSensorDisconnected(sensor: Sensor) {
            if (!state.value.collecting) return
            val key = sensorKey(sensor)
            registeredSensorKeys.remove(key)
            readings[key]?.let { reading ->
                readings[key] = reading.copy(
                    state = SensorState.UNAVAILABLE,
                    detail = "Dynamic sensor disconnected",
                )
            }
            val inventoryIndex = sensorInventory.indexOfFirst {
                it.sensorType == sensorWireType(sensor) && it.sensorId == sensor.id.takeIf { id -> id >= 0 }
            }
            if (inventoryIndex >= 0) {
                sensorInventory[inventoryIndex] = sensorInventory[inventoryIndex].copy(registered = false)
            }
            state.value = state.value.copy(
                availableSensorCount = availableSensorCount(),
                readings = readings.values.toList(),
            )
        }
    }
    private var lastStepCounter: Float? = null
    private var gravityInitialized = false
    private var lastLinearAccelerationTimestampNs = 0L
    private var angularRateMagnitude = 0f
    private var totalCollectedSamples = 0L
    private var lastSensorUiPublishMs = 0L
    private var lastPoseUiPublishMs = 0L
    private var lastVisualStatusKey: String? = null
    @Volatile private var fusionReady = true

    val uiState: StateFlow<SensorUiState> = state.asStateFlow()
    val syncState: StateFlow<SessionSyncState> = uploader.syncState

    fun hasResumableCapture(): Boolean = uploader.hasPersistedSession()

    fun deviceCredential(): String? = credentialStore.readToken()

    fun saveDeviceCredential(token: String): Boolean {
        val saved = credentialStore.saveToken(token)
        state.value = state.value.copy(
            deviceCredentialConfigured = credentialStore.hasToken(),
            error = if (saved) null else "设备凭据为空或长度无效",
        )
        return saved
    }

    fun exchangePairingCode(code: String): Boolean {
        val token = uploader.exchangeEnrollmentCode(code) ?: return false
        return saveDeviceCredential(token)
    }

    fun clearDeviceCredential() {
        credentialStore.clear()
        state.value = state.value.copy(deviceCredentialConfigured = false)
    }

    fun discardPendingCapture() {
        if (state.value.collecting) return
        uploader.discardPendingCapture()
        state.value = state.value.copy(error = null)
    }

    fun availableSensorCount(): Int = discoveredSensors().size

    fun hasPreciseLocationPermission(): Boolean = ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    fun hasLocationPermission(): Boolean = hasPreciseLocationPermission() || ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    fun start(activity: Activity? = null, mode: String = "learning", routeId: String? = null, handoffToken: String? = null) {
        if (state.value.collecting) return

        val recoveringSession = uploader.hasPersistedSession()
        readings.clear()
        sensorInventory.clear()
        registeredSensorKeys.clear()
        lastPublishedLocation = null
        totalCollectedSamples = 0L
        lastSensorUiPublishMs = 0L
        lastPoseUiPublishMs = 0L
        lastVisualStatusKey = null
        transportLimiter.reset()
        stepDetectorRegistered = false
        lastStepCounter = null
        resetMotionState()
        // A resumed session must wait for the server's last pose before any
        // local fused sample is created. Raw samples remain queued during this
        // short handshake, so no sensor data is lost.
        fusionReady = !recoveringSession
        val callbackHandler = ensureSensorHandler()
        hasLinearAccelerationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) != null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            runCatching { sensorManager.registerDynamicSensorCallback(dynamicSensorCallback, callbackHandler) }
        }
        discoveredSensors().forEach { sensor ->
            registerSensor(sensor, callbackHandler)
        }

        state.value = state.value.copy(
            collecting = true,
            availableSensorCount = availableSensorCount(),
            locationPermissionGranted = hasPreciseLocationPermission(),
            sampleCount = 0,
            lastSampleAtMs = null,
            readings = readings.values.toList(),
            error = null,
        )

        uploader.start(
            deviceId = Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID) ?: "android-device",
            sensorInventory = sensorInventory.toList(),
            mode = mode,
            routeId = routeId,
            handoffToken = handoffToken,
        )
        activity?.let(visualCollector::start)

        if (hasPreciseLocationPermission()) requestLocationUpdates()
        else updateError("请允许精确位置权限，近似位置无法建立可靠行走轨迹")
    }

    fun stop() {
        sensorManager.unregisterListener(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            runCatching { sensorManager.unregisterDynamicSensorCallback(dynamicSensorCallback) }
        }
        locationManager.removeUpdates(this)
        sensorThread?.quitSafely()
        sensorThread = null
        sensorHandler = null
        lastPublishedLocation = null
        lastVisualStatusKey = null
        resetMotionState()
        fusionReady = true
        visualCollector.stop()
        uploader.stop()
        state.value = state.value.copy(collecting = false)
    }

    private fun ensureSensorHandler(): Handler {
        sensorHandler?.let { return it }
        val thread = HandlerThread("way-memory-sensors").also { it.start() }
        val handler = Handler(thread.looper)
        sensorThread = thread
        sensorHandler = handler
        return handler
    }

    private fun registerSensor(sensor: Sensor, callbackHandler: Handler) {
        if (!registeredSensorKeys.add(sensorKey(sensor))) return
        val key = sensorKey(sensor)
        val label = sensorLabel(sensor)
        val delay = when (sensor.type) {
            Sensor.TYPE_ACCELEROMETER,
            Sensor.TYPE_GRAVITY,
            Sensor.TYPE_LINEAR_ACCELERATION,
            Sensor.TYPE_GYROSCOPE,
            Sensor.TYPE_GAME_ROTATION_VECTOR,
            Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR,
            Sensor.TYPE_ROTATION_VECTOR -> SensorManager.SENSOR_DELAY_GAME
            else -> SensorManager.SENSOR_DELAY_NORMAL
        }
        val registered = runCatching {
            sensorManager.registerListener(this, sensor, delay, callbackHandler)
        }.getOrDefault(false)
        if (sensor.type == Sensor.TYPE_STEP_DETECTOR && registered) stepDetectorRegistered = true
        val inventoryEntry = SensorInventorySample(
            sensorType = sensorWireType(sensor),
            sensorId = sensor.id.takeIf { it >= 0 },
            name = sensor.name.take(128),
            vendor = sensor.vendor.takeIf { it.isNotBlank() }?.take(128),
            version = sensor.version,
            powerMa = sensor.power.takeIf { it.isFinite() && it >= 0f },
            maximumRange = sensor.maximumRange.takeIf { it.isFinite() && it >= 0f },
            resolution = sensor.resolution.takeIf { it.isFinite() && it >= 0f },
            minDelayUs = sensor.minDelay.takeIf { it >= 0 },
            maxDelayUs = sensor.maxDelay.takeIf { it >= 0 },
            fifoReservedEventCount = sensor.fifoReservedEventCount.takeIf { it >= 0 },
            fifoMaxEventCount = sensor.fifoMaxEventCount.takeIf { it >= 0 },
            reportingMode = sensor.reportingMode,
            wakeUpSensor = sensor.isWakeUpSensor,
            dynamicSensor = sensor.isDynamicSensor,
            transportMaxHz = transportLimiter.maxHz(sensorWireType(sensor)),
            registered = registered,
        )
        val inventoryIndex = sensorInventory.indexOfFirst {
            it.sensorType == inventoryEntry.sensorType && it.sensorId == inventoryEntry.sensorId
        }
        if (inventoryIndex >= 0) sensorInventory[inventoryIndex] = inventoryEntry else sensorInventory += inventoryEntry
        readings[key] = if (registered) {
            SensorReading(label, SensorState.LIMITED, "Waiting for data")
        } else {
            SensorReading(label, SensorState.UNAVAILABLE, "Registration denied by device or permission")
        }
    }

    private fun discoveredSensors(): List<Sensor> {
        val sensors = sensorManager.getSensorList(Sensor.TYPE_ALL).toMutableList()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            sensors += sensorManager.getDynamicSensorList(Sensor.TYPE_ALL)
        }
        return sensors.distinctBy(::sensorKey)
    }

    @SuppressLint("MissingPermission")
    private fun requestLocationUpdates() {
        // Subscribe to both providers. GNSS is preferred by the filtering below, while
        // network can provide an initial fix when the phone is indoors or GNSS is still
        // warming up. The server still validates every emitted location sample.
        val providers = locationManager.getProviders(true)
            .filter { it == LocationManager.GPS_PROVIDER || it == LocationManager.NETWORK_PROVIDER }
        if (providers.isEmpty()) {
            updateError("请打开系统定位服务")
            return
        }
        var subscribed = 0
        providers.forEach { provider ->
            runCatching {
                locationManager.requestLocationUpdates(
                    provider,
                    1_000L,
                    0f,
                    this,
                    sensorHandler?.looper ?: Looper.getMainLooper(),
                )
            }
                .onSuccess { subscribed += 1 }
        }
        if (subscribed == 0) {
            updateError("无法订阅系统定位服务")
            return
        }

        val nowNs = SystemClock.elapsedRealtimeNanos()
        providers.mapNotNull { provider ->
            runCatching { locationManager.getLastKnownLocation(provider) }.getOrNull()
        }.filter { isPrimaryLocationProvider(it.provider) }
            .maxByOrNull { it.elapsedRealtimeNanos }
            ?.takeIf { it.elapsedRealtimeNanos > 0 && nowNs - it.elapsedRealtimeNanos <= 30_000_000_000L }
            ?.let(::onLocationChanged)
    }

    override fun onSensorChanged(event: SensorEvent) {
        val label = sensorLabel(event.sensor)
        val key = sensorKey(event.sensor)
        val values = event.values.toList()
        val detail = when (event.sensor.type) {
            Sensor.TYPE_PRESSURE -> "%.1f hPa".format(values.firstOrNull() ?: 0f)
            else -> values.take(3).joinToString(prefix = "[", postfix = "]") { "%.2f".format(it) }
        }
        readings[key] = SensorReading(label, SensorState.READY, detail, values)
        val wireType = sensorWireType(event.sensor)
        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GRAVITY -> updateGravity(values, event.timestamp)
            Sensor.TYPE_MAGNETIC_FIELD -> updateMagneticField(values, event.timestamp)
            Sensor.TYPE_GYROSCOPE -> updateAngularRate(values)
            Sensor.TYPE_GAME_ROTATION_VECTOR,
            Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR,
            Sensor.TYPE_ROTATION_VECTOR -> updateRotationMatrix(values, event.sensor.type, event.timestamp)
            Sensor.TYPE_PRESSURE -> if (fusionReady) updateBarometer(values.firstOrNull(), event.timestamp)
        }
        val poseUpdate = if (!fusionReady) {
            null
        } else {
            when {
                event.sensor.type == Sensor.TYPE_STEP_DETECTOR -> {
                    integrateSteps(event.timestamp, 1)
                }
                event.sensor.type == Sensor.TYPE_STEP_COUNTER -> {
                    val counter = values.firstOrNull()?.takeIf { it.isFinite() }
                    val previous = lastStepCounter
                    lastStepCounter = counter
                    if (!stepDetectorRegistered && counter != null && previous != null) {
                        val delta = (counter - previous).toInt().coerceIn(0, MAX_COUNTER_STEP_DELTA)
                        delta.takeIf { it > 0 }?.let { integrateSteps(event.timestamp, it) }
                    } else {
                        null
                    }
                }
                event.sensor.type == Sensor.TYPE_LINEAR_ACCELERATION -> {
                    lastLinearAccelerationTimestampNs = event.timestamp
                    integrateMotion(event.timestamp, values)
                }
                event.sensor.type == Sensor.TYPE_ACCELEROMETER && (
                    !hasLinearAccelerationSensor
                        || lastLinearAccelerationTimestampNs == 0L
                        || event.timestamp - lastLinearAccelerationTimestampNs > 300_000_000L
                ) && canUseAccelerometerFallbackDuringRotation(angularRateMagnitude) -> {
                    integrateMotion(event.timestamp, removeGravity(values))
                }
                else -> null
            }
        }
        val rawAccepted = transportLimiter.shouldTransmit(
            streamKey = key,
            sensorType = wireType,
            timestampNs = event.timestamp,
        )
        val poseAccepted = poseUpdate?.let { update ->
            transportLimiter.shouldTransmit(
                streamKey = POSE_TRANSPORT_KEY,
                sensorType = "fused.pose",
                timestampNs = update.pose.deviceTimestampNs,
                priority = update.motionEvent != null,
            )
        } == true
        if (rawAccepted) {
            uploader.enqueue(
                CollectedSample(
                    deviceTimestampNs = event.timestamp,
                    sensorType = wireType,
                    sensorId = event.sensor.id.takeIf { it >= 0 },
                    values = values,
                    sensorAccuracy = event.accuracy.takeIf { it >= 0 },
                    relativePosition = if (poseAccepted) poseUpdate?.pose?.toRelativePosition() else null,
                    pose = if (poseAccepted) poseUpdate?.pose else null,
                    motionEvent = if (poseAccepted) poseUpdate?.motionEvent else null,
                ),
            )
        } else if (poseAccepted) {
            enqueuePose(poseUpdate!!)
        }
        poseUpdate?.let(::publishPose)
        publishSample()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun publishPose(update: PoseUpdate) {
        val nowMs = System.currentTimeMillis()
        if (update.motionEvent == null && nowMs - lastPoseUiPublishMs < POSE_UI_INTERVAL_MS) return
        lastPoseUiPublishMs = nowMs
        val pose = update.pose
        state.value = state.value.copy(
            poseText = "x %.2f · y %.2f · z %.2f · ±%.1fm".format(pose.xM, pose.yM, pose.zM, pose.accuracyM),
            motionMode = pose.motionMode,
            poseAccuracyM = pose.accuracyM,
        )
    }

    fun createVisualView(context: Context) = visualCollector.createView(context)

    fun onHostResume(activity: Activity) {
        if (state.value.collecting) visualCollector.onHostResume(activity)
    }

    fun onHostPause() {
        visualCollector.onHostPause()
    }

    fun hasCameraPermission(): Boolean = ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.CAMERA,
    ) == PackageManager.PERMISSION_GRANTED

    private fun onVisualStatus(status: VisualTrackingStatus) {
        state.value = state.value.copy(visualTracking = status)
        if (!state.value.collecting) return
        val key = listOf(status.available, status.active, status.trackingState, status.failureReason, status.detail).joinToString("|")
        if (key == lastVisualStatusKey) return
        lastVisualStatusKey = key
        buildVisualStatusSample(status, SystemClock.elapsedRealtimeNanos())?.let(uploader::enqueue)
    }

    private fun onVisualPose(sample: VisualPoseSample) {
        val poseUpdate = if (fusionReady) poseFusion.updateVisual(sample) else null
        val rawAccepted = transportLimiter.shouldTransmit(
            streamKey = VISUAL_TRANSPORT_KEY,
            sensorType = "arcore.visual-pose",
            timestampNs = sample.deviceTimestampNs,
        )
        val poseAccepted = poseUpdate?.let { update ->
            transportLimiter.shouldTransmit(
                streamKey = POSE_TRANSPORT_KEY,
                sensorType = "fused.pose",
                timestampNs = update.pose.deviceTimestampNs,
                priority = update.motionEvent != null,
            )
        } == true
        if (rawAccepted) {
            uploader.enqueue(
                CollectedSample(
                    deviceTimestampNs = sample.deviceTimestampNs,
                    sensorType = "arcore.visual-pose",
                    values = listOf(sample.xM, sample.yM, sample.zM),
                    accuracy = sample.accuracyM,
                    metadata = buildMap {
                        put("trackingState", sample.trackingState)
                        put("confidence", sample.confidence)
                        put("trackingReset", sample.trackingReset)
                        sample.failureReason?.let { put("failureReason", it) }
                    },
                    pose = if (poseAccepted) poseUpdate?.pose else null,
                    motionEvent = if (poseAccepted) poseUpdate?.motionEvent else null,
                ),
            )
        } else if (poseAccepted) {
            enqueuePose(poseUpdate!!)
        }
        poseUpdate?.let(::publishPose)
    }

    private fun enqueuePose(update: PoseUpdate) {
        val pose = update.pose
        uploader.enqueue(
            CollectedSample(
                deviceTimestampNs = pose.deviceTimestampNs,
                sensorType = "fused.pose",
                values = listOf(pose.xM, pose.yM, pose.zM),
                accuracy = pose.accuracyM,
                relativePosition = pose.toRelativePosition(),
                pose = pose,
                motionEvent = update.motionEvent,
            ),
        )
    }

    private fun publishSample() {
        totalCollectedSamples += 1
        val nowMs = System.currentTimeMillis()
        if (nowMs - lastSensorUiPublishMs < SENSOR_UI_INTERVAL_MS) return
        lastSensorUiPublishMs = nowMs
        state.value = state.value.copy(
            sampleCount = totalCollectedSamples,
            lastSampleAtMs = nowMs,
            readings = readings.values.toList(),
        )
    }

    override fun onLocationChanged(location: Location) {
        if (!isPrimaryLocationProvider(location.provider)) {
            enqueueNetworkLocationDiagnostic(location)
            return
        }
        if (!shouldPublishLocation(location)) return
        lastPublishedLocation = Location(location)
        val timestampNs = location.elapsedRealtimeNanos.takeIf { it > 0L }
            ?: SystemClock.elapsedRealtimeNanos()
        val poseUpdate = if (fusionReady) {
            poseFusion.updateGnss(
                latitude = location.latitude,
                longitude = location.longitude,
                accuracyM = location.accuracy.takeIf { location.hasAccuracy() },
                altitudeM = location.altitude.takeIf { location.hasAltitude() },
                timestampNs = timestampNs,
            )
        } else {
            null
        }
        val accuracy = if (location.hasAccuracy()) "±%.1fm".format(location.accuracy) else "accuracy unknown"
        state.value = state.value.copy(
            locationText = "%.6f, %.6f · %s".format(location.latitude, location.longitude, accuracy),
            lastSampleAtMs = System.currentTimeMillis(),
        )
        uploader.enqueue(
            CollectedSample(
                deviceTimestampNs = timestampNs,
                sensorType = "location",
                location = LocationSample(
                    lat = location.latitude,
                    lng = location.longitude,
                    accuracyM = location.accuracy.takeIf { location.hasAccuracy() },
                    altitudeM = location.altitude.takeIf { location.hasAltitude() },
                    provider = location.provider,
                ),
                relativePosition = poseUpdate?.pose?.toRelativePosition(),
                pose = poseUpdate?.pose,
                motionEvent = poseUpdate?.motionEvent,
            ),
        )
        poseUpdate?.let(::publishPose)
    }

    private fun enqueueNetworkLocationDiagnostic(location: Location) {
        if (!location.latitude.isFinite() || !location.longitude.isFinite()) return
        val accuracy = location.accuracy.takeIf { location.hasAccuracy() && it.isFinite() && it >= 0f }
        uploader.enqueue(
            CollectedSample(
                deviceTimestampNs = location.elapsedRealtimeNanos.takeIf { it > 0L }
                    ?: SystemClock.elapsedRealtimeNanos(),
                sensorType = "location.network",
                values = listOf(
                    location.latitude.toFloat(),
                    location.longitude.toFloat(),
                    accuracy ?: -1f,
                ),
                metadata = mapOf(
                    "provider" to (location.provider ?: "network"),
                    "primary" to false,
                ),
            ),
        )
    }

    private fun shouldPublishLocation(location: Location): Boolean {
        val previous = lastPublishedLocation ?: return true
        val currentTimestampNs = location.elapsedRealtimeNanos
        val previousTimestampNs = previous.elapsedRealtimeNanos
        if (currentTimestampNs > 0 && previousTimestampNs > 0 && currentTimestampNs <= previousTimestampNs) return false

        val elapsedNs = if (currentTimestampNs > 0 && previousTimestampNs > 0) {
            currentTimestampNs - previousTimestampNs
        } else {
            Long.MAX_VALUE
        }
        val distance = FloatArray(1)
        Location.distanceBetween(
            previous.latitude,
            previous.longitude,
            location.latitude,
            location.longitude,
            distance,
        )
        if (distance[0] <= 0.5f && elapsedNs <= 2_000_000_000L) return false

        val previousAccuracy = previous.accuracy.takeIf { previous.hasAccuracy() } ?: Float.MAX_VALUE
        val currentAccuracy = location.accuracy.takeIf { location.hasAccuracy() } ?: Float.MAX_VALUE
        if (previous.provider == LocationManager.GPS_PROVIDER && location.provider != LocationManager.GPS_PROVIDER && currentAccuracy > previousAccuracy * 2 && elapsedNs <= 5_000_000_000L) {
            return false
        }
        return true
    }

    override fun onProviderEnabled(provider: String) = Unit
    override fun onProviderDisabled(provider: String) = updateError("Location provider disabled: $provider")
    @Deprecated("Required by the legacy LocationListener contract")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    private fun updateError(message: String) {
        state.value = state.value.copy(error = message)
    }

    private fun resetMotionState() {
        rotationMatrix.fill(0f)
        gravity.fill(0f)
        magneticField.fill(0f)
        hasRotationMatrix = false
        hasRotationVector = false
        rotationSourcePriority = 0
        rotationSourceTimestampNs = 0L
        hasMagneticField = false
        gravityInitialized = false
        lastLinearAccelerationTimestampNs = 0L
        angularRateMagnitude = 0f
        lastStepCounter = null
        poseFusion.reset()
    }

    private fun onSessionLifecycle(event: SessionLifecycleEvent) {
        if (event.resumed) {
            event.latestPose?.let(poseFusion::seedFromPose)
        }
        // For a new session there is no durable anchor to apply. For a
        // resumed session seedFromPose has already completed on this callback
        // thread before fusionReady becomes visible to sensor callbacks.
        fusionReady = true
    }

    private fun onCaptureBlocked(message: String) {
        sensorManager.unregisterListener(this)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            runCatching { sensorManager.unregisterDynamicSensorCallback(dynamicSensorCallback) }
        }
        locationManager.removeUpdates(this)
        sensorThread?.quitSafely()
        sensorThread = null
        sensorHandler = null
        visualCollector.stop()
        lastVisualStatusKey = null
        resetMotionState()
        fusionReady = true
        state.value = state.value.copy(collecting = false, error = message)
    }

    private fun updateRotationMatrix(values: List<Float>, sensorType: Int, timestampNs: Long) {
        if (values.size < 3) return
        if (timestampNs <= 0L) return
        val priority = rotationSourcePriority(sensorType)
        if (!shouldAcceptRotationSource(rotationSourcePriority, rotationSourceTimestampNs, priority, timestampNs)) return
        SensorManager.getRotationMatrixFromVector(rotationMatrix, values.toFloatArray())
        hasRotationMatrix = true
        hasRotationVector = true
        rotationSourcePriority = priority
        rotationSourceTimestampNs = timestampNs
    }

    private fun updateGravity(values: List<Float>, timestampNs: Long) {
        if (values.size < 3) return
        if (!gravityInitialized) {
            values.take(3).forEachIndexed { index, value -> gravity[index] = value }
            gravityInitialized = true
        } else {
            values.take(3).forEachIndexed { index, value -> gravity[index] = gravity[index] * 0.9f + value * 0.1f }
        }
        updateFallbackRotationMatrix(timestampNs)
    }

    private fun updateMagneticField(values: List<Float>, timestampNs: Long) {
        if (values.size < 3) return
        if (!hasMagneticField) {
            values.take(3).forEachIndexed { index, value -> magneticField[index] = value }
            hasMagneticField = true
        } else {
            values.take(3).forEachIndexed { index, value -> magneticField[index] = magneticField[index] * 0.8f + value * 0.2f }
        }
        updateFallbackRotationMatrix(timestampNs)
    }

    private fun updateAngularRate(values: List<Float>) {
        if (values.size < 3) return
        val currentMagnitude = sqrt((values[0] * values[0] + values[1] * values[1] + values[2] * values[2]).toDouble()).toFloat()
        angularRateMagnitude = angularRateMagnitude * 0.75f + currentMagnitude * 0.25f
    }

    private fun updateFallbackRotationMatrix(timestampNs: Long) {
        if (
            !gravityInitialized
            || !hasMagneticField
            || (
                hasRotationVector
                && rotationSourcePriority > 0
                && timestampNs >= rotationSourceTimestampNs
                && timestampNs - rotationSourceTimestampNs <= ROTATION_SOURCE_FRESHNESS_NS
            )
        ) return
        hasRotationMatrix = SensorManager.getRotationMatrix(rotationMatrix, null, gravity, magneticField)
        hasRotationVector = false
        rotationSourcePriority = 0
    }

    private fun rotationSourcePriority(sensorType: Int): Int = when (sensorType) {
        Sensor.TYPE_ROTATION_VECTOR -> 3
        Sensor.TYPE_GAME_ROTATION_VECTOR -> 2
        Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR -> 1
        else -> 0
    }

    private fun removeGravity(values: List<Float>): List<Float> {
        if (values.size < 3) return values
        return values.take(3).mapIndexed { index, value -> value - gravity[index] }
    }

    private fun updateBarometer(pressureHpa: Float?, timestampNs: Long) {
        if (pressureHpa == null || !pressureHpa.isFinite() || pressureHpa !in 300f..1_100f) return
        poseFusion.updatePressure(pressureHpa, timestampNs)
    }

    private fun sensorKey(sensor: Sensor): String = "${sensor.stringType.ifBlank { "type-${sensor.type}" }}:${sensor.id}"

    private fun sensorLabel(sensor: Sensor): String = "${sensor.name} · ${sensor.stringType.ifBlank { "type-${sensor.type}" }} #${sensor.id}"

    private fun sensorWireType(sensor: Sensor): String = sensor.stringType
        .ifBlank { "android.sensor.type-${sensor.type}" }
        .take(64)

    private fun integrateMotion(timestampNs: Long, deviceAcceleration: List<Float>): PoseUpdate? {
        if (!hasRotationMatrix) return null
        val worldAcceleration = transformDeviceAcceleration(rotationMatrix, deviceAcceleration) ?: return null
        return poseFusion.updateImu(timestampNs, worldAcceleration, angularRateMagnitude)
    }

    private fun integrateSteps(timestampNs: Long, steps: Int): PoseUpdate? {
        if (!hasRotationMatrix) return null
        val orientation = FloatArray(3)
        SensorManager.getOrientation(rotationMatrix, orientation)
        val heading = orientation.firstOrNull()?.takeIf { it.isFinite() } ?: return null
        return poseFusion.updateStep(timestampNs, heading, steps)
    }

    private fun PoseEstimateSample.toRelativePosition() = RelativePositionSample(
        xM = xM,
        yM = yM,
        zM = zM,
        accuracyM = accuracyM,
    )

    companion object {
        private const val POSE_TRANSPORT_KEY = "fused.pose"
        private const val VISUAL_TRANSPORT_KEY = "arcore.visual-pose"
        private const val MAX_COUNTER_STEP_DELTA = 8
        private const val SENSOR_UI_INTERVAL_MS = 100L
        private const val POSE_UI_INTERVAL_MS = 50L
    }
}
