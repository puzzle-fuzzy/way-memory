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

    fun hasLocationPermission(): Boolean = ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_FINE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED || ContextCompat.checkSelfPermission(
        appContext,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    ) == PackageManager.PERMISSION_GRANTED

    fun start() {
        if (state.value.collecting) return

        readings.clear()
        registerSensor(Sensor.TYPE_ACCELEROMETER, "加速度计", SensorManager.SENSOR_DELAY_GAME, "设备不支持")
        registerSensor(Sensor.TYPE_GYROSCOPE, "陀螺仪", SensorManager.SENSOR_DELAY_GAME, "设备不支持")
        registerSensor(Sensor.TYPE_MAGNETIC_FIELD, "磁力计", SensorManager.SENSOR_DELAY_UI, "设备不支持")
        registerSensor(Sensor.TYPE_PRESSURE, "气压计", SensorManager.SENSOR_DELAY_UI, "设备不支持")
        registerSensor(Sensor.TYPE_ROTATION_VECTOR, "旋转向量", SensorManager.SENSOR_DELAY_GAME, "设备不支持")

        state.value = state.value.copy(
            collecting = true,
            availableSensorCount = availableSensorCount(),
            locationPermissionGranted = hasLocationPermission(),
            readings = readings.values.toList(),
            error = null,
        )

        uploader.start(Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID) ?: "android-device")

        if (hasLocationPermission()) requestLocationUpdates()
        else updateError("已启动传感器采集，但没有位置权限")
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
        readings[label] = SensorReading(label, SensorState.LIMITED, "等待数据")
        sensorManager.registerListener(this, sensor, delay)
    }

    @SuppressLint("MissingPermission")
    private fun requestLocationUpdates() {
        val providers = locationManager.getProviders(true)
        if (providers.isEmpty()) {
            updateError("系统定位服务未开启")
            return
        }
        providers.forEach { provider ->
            runCatching { locationManager.requestLocationUpdates(provider, 1_000L, 1f, this) }
                .onFailure { updateError("无法订阅 $provider 定位") }
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        val label = when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> "加速度计"
            Sensor.TYPE_GYROSCOPE -> "陀螺仪"
            Sensor.TYPE_MAGNETIC_FIELD -> "磁力计"
            Sensor.TYPE_PRESSURE -> "气压计"
            Sensor.TYPE_ROTATION_VECTOR -> "旋转向量"
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

    private fun publishSample() {
        state.value = state.value.copy(
            sampleCount = state.value.sampleCount + 1,
            lastSampleAtMs = System.currentTimeMillis(),
            readings = readings.values.toList(),
        )
    }

    override fun onLocationChanged(location: Location) {
        val accuracy = if (location.hasAccuracy()) "±%.1fm".format(location.accuracy) else "精度未知"
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
    override fun onProviderDisabled(provider: String) = updateError("定位提供方已关闭：$provider")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    private fun updateError(message: String) {
        state.value = state.value.copy(error = message)
    }
}
