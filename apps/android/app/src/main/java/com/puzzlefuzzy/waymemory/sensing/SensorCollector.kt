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
    private var hasMagneticField = false
    private var hasLinearAccelerationSensor = false
    private var stepDetectorRegistered = false
    private var lastStepCounter: Float? = null
    private var gravityInitialized = false
    private var lastLinearAccelerationTimestampNs = 0L
    private var angularRateMagnitude = 0f
    private var totalCollectedSamples = 0L
    private var lastSensorUiPublishMs = 0L
    private var lastPoseUiPublishMs = 0L
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

    fun clearDeviceCredential() {
        credentialStore.clear()
        state.value = state.value.copy(deviceCredentialConfigured = false)
    }

    fun availableSensorCount(): Int = sensorManager.getSensorList(Sensor.TYPE_ALL).size

    fun hasPreciseLocationPermission(): Boolean = ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    fun hasLocationPermission(): Boolean = hasPreciseLocationPermission() || ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    fun start(activity: Activity? = null) {
        if (state.value.collecting) return

        val recoveringSession = uploader.hasPersistedSession()
        readings.clear()
        sensorInventory.clear()
        registeredSensorKeys.clear()
        lastPublishedLocation = null
        totalCollectedSamples = 0L
        lastSensorUiPublishMs = 0L
        lastPoseUiPublishMs = 0L
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
        sensorManager.getSensorList(Sensor.TYPE_ALL).forEach { sensor ->
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
        )
        activity?.let(visualCollector::start)

        if (hasPreciseLocationPermission()) requestLocationUpdates()
        else updateError("请允许精确位置权限，近似位置无法建立可靠行走轨迹")
    }

    fun stop() {
        sensorManager.unregisterListener(this)
        locationManager.removeUpdates(this)
        sensorThread?.quitSafely()
        sensorThread = null
        sensorHandler = null
        lastPublishedLocation = null
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
        sensorInventory += SensorInventorySample(
            sensorType = sensorWireType(sensor),
            name = sensor.name.take(128),
            vendor = sensor.vendor.takeIf { it.isNotBlank() }?.take(128),
            version = sensor.version,
            powerMa = sensor.power.takeIf { it.isFinite() && it >= 0f },
            minDelayUs = sensor.minDelay.takeIf { it >= 0 },
            maxDelayUs = sensor.maxDelay.takeIf { it >= 0 },
            reportingMode = sensor.reportingMode,
            transportMaxHz = transportLimiter.maxHz(sensorWireType(sensor)),
            registered = registered,
        )
        readings[key] = if (registered) {
            SensorReading(label, SensorState.LIMITED, "Waiting for data")
        } else {
            SensorReading(label, SensorState.UNAVAILABLE, "Registration denied by device or permission")
        }
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
        }.maxByOrNull { it.elapsedRealtimeNanos }
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
            Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GRAVITY -> updateGravity(values)
            Sensor.TYPE_MAGNETIC_FIELD -> updateMagneticField(values)
            Sensor.TYPE_GYROSCOPE -> updateAngularRate(values)
            Sensor.TYPE_GAME_ROTATION_VECTOR,
            Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR,
            Sensor.TYPE_ROTATION_VECTOR -> updateRotationMatrix(values)
            Sensor.TYPE_PRESSURE -> if (fusionReady) updateBarometer(values.firstOrNull())
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
                ) -> {
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
        if (!shouldPublishLocation(location)) return
        lastPublishedLocation = Location(location)
        val poseUpdate = if (fusionReady) {
            poseFusion.updateGnss(
                latitude = location.latitude,
                longitude = location.longitude,
                accuracyM = location.accuracy.takeIf { location.hasAccuracy() },
                altitudeM = location.altitude.takeIf { location.hasAltitude() },
                timestampNs = SystemClock.elapsedRealtimeNanos(),
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
                deviceTimestampNs = SystemClock.elapsedRealtimeNanos(),
                sensorType = "location",
                location = LocationSample(
                    lat = location.latitude,
                    lng = location.longitude,
                    accuracyM = location.accuracy.takeIf { location.hasAccuracy() },
                    altitudeM = location.altitude.takeIf { location.hasAltitude() },
                ),
                relativePosition = poseUpdate?.pose?.toRelativePosition(),
                pose = poseUpdate?.pose,
                motionEvent = poseUpdate?.motionEvent,
            ),
        )
        poseUpdate?.let(::publishPose)
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

    private fun updateRotationMatrix(values: List<Float>) {
        if (values.size < 3) return
        SensorManager.getRotationMatrixFromVector(rotationMatrix, values.toFloatArray())
        hasRotationMatrix = true
        hasRotationVector = true
    }

    private fun updateGravity(values: List<Float>) {
        if (values.size < 3) return
        if (!gravityInitialized) {
            values.take(3).forEachIndexed { index, value -> gravity[index] = value }
            gravityInitialized = true
        } else {
            values.take(3).forEachIndexed { index, value -> gravity[index] = gravity[index] * 0.9f + value * 0.1f }
        }
        updateFallbackRotationMatrix()
    }

    private fun updateMagneticField(values: List<Float>) {
        if (values.size < 3) return
        if (!hasMagneticField) {
            values.take(3).forEachIndexed { index, value -> magneticField[index] = value }
            hasMagneticField = true
        } else {
            values.take(3).forEachIndexed { index, value -> magneticField[index] = magneticField[index] * 0.8f + value * 0.2f }
        }
        updateFallbackRotationMatrix()
    }

    private fun updateAngularRate(values: List<Float>) {
        if (values.size < 3) return
        val currentMagnitude = sqrt((values[0] * values[0] + values[1] * values[1] + values[2] * values[2]).toDouble()).toFloat()
        angularRateMagnitude = angularRateMagnitude * 0.75f + currentMagnitude * 0.25f
    }

    private fun updateFallbackRotationMatrix() {
        if (hasRotationVector || !gravityInitialized || !hasMagneticField) return
        hasRotationMatrix = SensorManager.getRotationMatrix(rotationMatrix, null, gravity, magneticField)
    }

    private fun removeGravity(values: List<Float>): List<Float> {
        if (values.size < 3) return values
        return values.take(3).mapIndexed { index, value -> value - gravity[index] }
    }

    private fun updateBarometer(pressureHpa: Float?) {
        if (pressureHpa == null || !pressureHpa.isFinite() || pressureHpa !in 300f..1_100f) return
        poseFusion.updatePressure(pressureHpa, SystemClock.elapsedRealtimeNanos())
    }

    private fun sensorKey(sensor: Sensor): String = "${sensor.stringType.ifBlank { "type-${sensor.type}" }}:${sensor.id}"

    private fun sensorLabel(sensor: Sensor): String = "${sensor.name} · ${sensor.stringType.ifBlank { "type-${sensor.type}" }} #${sensor.id}"

    private fun sensorWireType(sensor: Sensor): String = sensor.stringType
        .ifBlank { "android.sensor.type-${sensor.type}" }
        .take(64)

    private fun integrateMotion(timestampNs: Long, deviceAcceleration: List<Float>): PoseUpdate? {
        if (!hasRotationMatrix || deviceAcceleration.size < 3) return null
        val worldAcceleration = floatArrayOf(
            rotationMatrix[0] * deviceAcceleration[0] + rotationMatrix[1] * deviceAcceleration[1] + rotationMatrix[2] * deviceAcceleration[2],
            rotationMatrix[3] * deviceAcceleration[0] + rotationMatrix[4] * deviceAcceleration[1] + rotationMatrix[5] * deviceAcceleration[2],
            rotationMatrix[6] * deviceAcceleration[0] + rotationMatrix[7] * deviceAcceleration[1] + rotationMatrix[8] * deviceAcceleration[2],
        )
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
