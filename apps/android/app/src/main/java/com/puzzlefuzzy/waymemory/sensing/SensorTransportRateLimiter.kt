package com.puzzlefuzzy.waymemory.sensing

/**
 * Bounds the diagnostic sensor stream without reducing the local fusion input.
 *
 * Android callbacks are still consumed at the registered hardware rate. This
 * policy only decides which raw snapshots are persisted/uploaded. Fused Pose
 * samples use their own 10 Hz budget, while motion events can bypass that
 * budget so that a transition such as elevator/stairs is not hidden by a
 * sampling window.
 */
internal class SensorTransportRateLimiter {
    private val lastAcceptedTimestampNs = mutableMapOf<String, Long>()

    fun shouldTransmit(
        streamKey: String,
        sensorType: String,
        timestampNs: Long,
        priority: Boolean = false,
    ): Boolean {
        val previous = lastAcceptedTimestampNs[streamKey]
        if (priority || previous == null) {
            lastAcceptedTimestampNs[streamKey] = timestampNs
            return true
        }
        if (timestampNs <= previous) return false
        val intervalNs = 1_000_000_000L / maxHz(sensorType)
        if (timestampNs - previous < intervalNs) return false
        lastAcceptedTimestampNs[streamKey] = timestampNs
        return true
    }

    fun reset() = lastAcceptedTimestampNs.clear()

    fun maxHz(sensorType: String): Int {
        val fullType = sensorType.lowercase()
        val normalized = fullType.substringAfterLast('.')
        return when {
            fullType == "fused.pose" || fullType == "arcore.visual-pose" -> POSE_HZ
            normalized in HIGH_RATE_SENSOR_TYPES -> HIGH_RATE_HZ
            normalized in MEDIUM_RATE_SENSOR_TYPES -> MEDIUM_RATE_HZ
            normalized == "pressure" -> POSE_HZ
            else -> OTHER_SENSOR_HZ
        }
    }

    companion object {
        const val HIGH_RATE_HZ = 50
        const val MEDIUM_RATE_HZ = 20
        const val POSE_HZ = 10
        const val OTHER_SENSOR_HZ = 5

        private val HIGH_RATE_SENSOR_TYPES = setOf(
            "accelerometer",
            "accelerometer_uncalibrated",
            "linear_acceleration",
            "gyroscope",
            "gyroscope_uncalibrated",
            "game_rotation_vector",
            "geomagnetic_rotation_vector",
            "rotation_vector",
        )

        private val MEDIUM_RATE_SENSOR_TYPES = setOf(
            "gravity",
            "magnetic_field",
            "magnetic_field_uncalibrated",
        )
    }
}
