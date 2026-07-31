package com.puzzlefuzzy.waymemory.sensing

import android.Manifest
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
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.pow
import kotlin.math.sqrt

class SensorCollector(context: Context) : SensorEventListener, LocationListener {
    private val appContext = context.applicationContext
    private val sensorManager = appContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val locationManager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val state = MutableStateFlow(SensorUiState())
    private val readings = linkedMapOf<String, SensorReading>()
    private val uploader = SessionUploader()
    private var lastPublishedLocation: Location? = null
    private val rotationMatrix = FloatArray(9)
    private val gravity = FloatArray(3)
    private val motionVelocity = FloatArray(3)
    private val motionPosition = FloatArray(3)
    private var hasRotationMatrix = false
    private var hasLinearAccelerationSensor = false
    private var gravityInitialized = false
    private var lastMotionTimestampNs = 0L
    private var lastMotionEmitTimestampNs = 0L
    private var firstPressureHpa: Float? = null
    private var barometerRelativeAltitudeM = 0f

    val uiState: StateFlow<SensorUiState> = state.asStateFlow()
    val syncState: StateFlow<SessionSyncState> = uploader.syncState

    fun availableSensorCount(): Int = sensorManager.getSensorList(Sensor.TYPE_ALL).size

    fun hasPreciseLocationPermission(): Boolean = ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    fun hasLocationPermission(): Boolean = hasPreciseLocationPermission() || ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    fun start() {
        if (state.value.collecting) return

        readings.clear()
        lastPublishedLocation = null
        resetMotionState()
        hasLinearAccelerationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) != null
        registerSensor(Sensor.TYPE_ACCELEROMETER, "Accelerometer", SensorManager.SENSOR_DELAY_GAME, "Sensor unavailable")
        registerSensor(Sensor.TYPE_LINEAR_ACCELERATION, "Linear acceleration", SensorManager.SENSOR_DELAY_GAME, "Sensor unavailable")
        registerSensor(Sensor.TYPE_GYROSCOPE, "Gyroscope", SensorManager.SENSOR_DELAY_GAME, "Sensor unavailable")
        registerSensor(Sensor.TYPE_MAGNETIC_FIELD, "Magnetometer", SensorManager.SENSOR_DELAY_UI, "Sensor unavailable")
        registerSensor(Sensor.TYPE_PRESSURE, "Barometer", SensorManager.SENSOR_DELAY_UI, "Sensor unavailable")
        registerSensor(Sensor.TYPE_ROTATION_VECTOR, "Rotation vector", SensorManager.SENSOR_DELAY_GAME, "Sensor unavailable")

        state.value = state.value.copy(
            collecting = true,
            availableSensorCount = availableSensorCount(),
            locationPermissionGranted = hasPreciseLocationPermission(),
            readings = readings.values.toList(),
            error = null,
        )

        uploader.start(Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID) ?: "android-device")

        if (hasPreciseLocationPermission()) requestLocationUpdates()
        else updateError("请允许精确位置权限，近似位置无法建立可靠行走轨迹")
    }

    fun stop() {
        sensorManager.unregisterListener(this)
        locationManager.removeUpdates(this)
        lastPublishedLocation = null
        resetMotionState()
        uploader.stop()
        state.value = state.value.copy(collecting = false)
    }

    private fun registerSensor(type: Int, label: String, delay: Int, unavailableDetail: String) {
        val sensor = sensorManager.getDefaultSensor(type)
        if (sensor == null) {
            readings[label] = SensorReading(label, SensorState.UNAVAILABLE, unavailableDetail)
            return
        }
        readings[label] = SensorReading(label, SensorState.LIMITED, "Waiting for data")
        sensorManager.registerListener(this, sensor, delay)
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
            runCatching { locationManager.requestLocationUpdates(provider, 1_000L, 0f, this) }
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
        val label = when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> "Accelerometer"
            Sensor.TYPE_LINEAR_ACCELERATION -> "Linear acceleration"
            Sensor.TYPE_GYROSCOPE -> "Gyroscope"
            Sensor.TYPE_MAGNETIC_FIELD -> "Magnetometer"
            Sensor.TYPE_PRESSURE -> "Barometer"
            Sensor.TYPE_ROTATION_VECTOR -> "Rotation vector"
            else -> return
        }
        val values = event.values.toList()
        val detail = when (event.sensor.type) {
            Sensor.TYPE_PRESSURE -> "%.1f hPa".format(values.firstOrNull() ?: 0f)
            else -> values.take(3).joinToString(prefix = "[", postfix = "]") { "%.2f".format(it) }
        }
        readings[label] = SensorReading(label, SensorState.READY, detail, values)
        when (event.sensor.type) {
            Sensor.TYPE_ROTATION_VECTOR -> updateRotationMatrix(values)
            Sensor.TYPE_PRESSURE -> updateBarometer(values.firstOrNull())
        }
        val relativePosition = when {
            event.sensor.type == Sensor.TYPE_LINEAR_ACCELERATION -> integrateMotion(event.timestamp, values)
            event.sensor.type == Sensor.TYPE_ACCELEROMETER && !hasLinearAccelerationSensor -> {
                integrateMotion(event.timestamp, removeGravity(values))
            }
            else -> null
        }
        uploader.enqueue(CollectedSample(event.timestamp, event.sensor.stringType, values, relativePosition = relativePosition))
        publishSample()
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private fun publishSample() {
        state.value = state.value.copy(
            sampleCount = state.value.sampleCount + 1,
            lastSampleAtMs = System.currentTimeMillis(),
            readings = readings.values.toList(),
        )
    }

    override fun onLocationChanged(location: Location) {
        if (!shouldPublishLocation(location)) return
        lastPublishedLocation = Location(location)
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
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    private fun updateError(message: String) {
        state.value = state.value.copy(error = message)
    }

    private fun resetMotionState() {
        rotationMatrix.fill(0f)
        gravity.fill(0f)
        motionVelocity.fill(0f)
        motionPosition.fill(0f)
        hasRotationMatrix = false
        gravityInitialized = false
        lastMotionTimestampNs = 0L
        lastMotionEmitTimestampNs = 0L
        firstPressureHpa = null
        barometerRelativeAltitudeM = 0f
    }

    private fun updateRotationMatrix(values: List<Float>) {
        if (values.size < 3) return
        SensorManager.getRotationMatrixFromVector(rotationMatrix, values.toFloatArray())
        hasRotationMatrix = true
    }

    private fun removeGravity(values: List<Float>): List<Float> {
        if (values.size < 3) return values
        if (!gravityInitialized) {
            values.take(3).forEachIndexed { index, value -> gravity[index] = value }
            gravityInitialized = true
        }
        values.take(3).forEachIndexed { index, value -> gravity[index] = gravity[index] * 0.9f + value * 0.1f }
        return values.take(3).mapIndexed { index, value -> value - gravity[index] }
    }

    private fun updateBarometer(pressureHpa: Float?) {
        if (pressureHpa == null || !pressureHpa.isFinite() || pressureHpa !in 300f..1_100f) return
        firstPressureHpa = firstPressureHpa ?: pressureHpa
        barometerRelativeAltitudeM = 44_330f * (1f - (pressureHpa / (firstPressureHpa ?: pressureHpa)).toDouble().pow(0.190294957)).toFloat()
    }

    private fun integrateMotion(timestampNs: Long, deviceAcceleration: List<Float>): RelativePositionSample? {
        if (!hasRotationMatrix || deviceAcceleration.size < 3) return null
        if (lastMotionTimestampNs == 0L) {
            lastMotionTimestampNs = timestampNs
            return null
        }
        val elapsedNs = timestampNs - lastMotionTimestampNs
        lastMotionTimestampNs = timestampNs
        if (elapsedNs <= 0L || elapsedNs > 250_000_000L) return null
        val deltaSeconds = (elapsedNs / 1_000_000_000f).coerceIn(0.005f, 0.1f)
        val deviceX = deviceAcceleration[0]
        val deviceY = deviceAcceleration[1]
        val deviceZ = deviceAcceleration[2]
        val worldAcceleration = floatArrayOf(
            rotationMatrix[0] * deviceX + rotationMatrix[1] * deviceY + rotationMatrix[2] * deviceZ,
            rotationMatrix[3] * deviceX + rotationMatrix[4] * deviceY + rotationMatrix[5] * deviceZ,
            rotationMatrix[6] * deviceX + rotationMatrix[7] * deviceY + rotationMatrix[8] * deviceZ,
        )
        val magnitude = vectorMagnitude(worldAcceleration)
        val noiseFloor = 0.12f
        val scale = if (magnitude <= noiseFloor) 0f else (magnitude - noiseFloor) / magnitude
        for (index in 0..2) {
            motionVelocity[index] += worldAcceleration[index] * scale * deltaSeconds
            motionVelocity[index] *= if (magnitude <= 0.2f) 0.65f else 0.985f
            motionVelocity[index] = motionVelocity[index].coerceIn(-15f, 15f)
            motionPosition[index] += motionVelocity[index] * deltaSeconds
        }
        if (timestampNs - lastMotionEmitTimestampNs < 100_000_000L) return null
        lastMotionEmitTimestampNs = timestampNs
        val positionMagnitude = vectorMagnitude(motionPosition)
        val fusedZ = motionPosition[2] * 0.65f + barometerRelativeAltitudeM * 0.35f
        return RelativePositionSample(
            xM = motionPosition[0],
            yM = motionPosition[1],
            zM = fusedZ,
            accuracyM = (1.5f + positionMagnitude * 0.08f + if (magnitude <= 0.2f) 0.4f else 0.8f).coerceAtMost(20f),
        )
    }

    private fun vectorMagnitude(values: FloatArray): Float =
        sqrt((values[0] * values[0] + values[1] * values[1] + values[2] * values[2]).toDouble()).toFloat()
}
