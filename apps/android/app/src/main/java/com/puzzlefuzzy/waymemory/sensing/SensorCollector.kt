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

class SensorCollector(context: Context) : SensorEventListener, LocationListener {
    private val appContext = context.applicationContext
    private val sensorManager = appContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val locationManager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    private val state = MutableStateFlow(SensorUiState())
    private val readings = linkedMapOf<String, SensorReading>()
    private val uploader = SessionUploader()

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
        registerSensor(Sensor.TYPE_ACCELEROMETER, "Accelerometer", SensorManager.SENSOR_DELAY_GAME, "Sensor unavailable")
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
        // Prefer GNSS when it is enabled. Coarse-only/network updates can be thousands
        // of meters wide and are not suitable for a pedestrian route.
        val enabledProviders = locationManager.getProviders(true)
        val provider = when {
            LocationManager.GPS_PROVIDER in enabledProviders -> LocationManager.GPS_PROVIDER
            LocationManager.NETWORK_PROVIDER in enabledProviders -> LocationManager.NETWORK_PROVIDER
            else -> null
        }
        if (provider == null) {
            updateError("请打开系统定位服务")
            return
        }
        runCatching { locationManager.requestLocationUpdates(provider, 500L, 0f, this) }
            .onFailure { updateError("无法订阅精确位置服务") }
    }

    override fun onSensorChanged(event: SensorEvent) {
        val label = when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> "Accelerometer"
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
        uploader.enqueue(CollectedSample(event.timestamp, event.sensor.stringType, values))
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

    override fun onProviderEnabled(provider: String) = Unit
    override fun onProviderDisabled(provider: String) = updateError("Location provider disabled: $provider")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    private fun updateError(message: String) {
        state.value = state.value.copy(error = message)
    }
}
