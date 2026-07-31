package com.puzzlefuzzy.waymemory.sensing

enum class SensorState {
    READY,
    LIMITED,
    UNAVAILABLE,
}

data class SensorReading(
    val label: String,
    val state: SensorState,
    val detail: String,
    val values: List<Float> = emptyList(),
)

data class SensorUiState(
    val collecting: Boolean = false,
    val deviceCredentialConfigured: Boolean = false,
    val locationPermissionGranted: Boolean = false,
    val availableSensorCount: Int = 0,
    val sampleCount: Long = 0,
    val lastSampleAtMs: Long? = null,
    val poseText: String = "等待统一 Pose",
    val motionMode: String = "unknown",
    val poseAccuracyM: Float? = null,
    val visualTracking: VisualTrackingStatus = VisualTrackingStatus(),
    val locationText: String = "等待定位",
    val readings: List<SensorReading> = emptyList(),
    val error: String? = null,
)
