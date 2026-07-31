package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.SensorTransportRateLimiter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SensorTransportRateLimiterTest {
    @Test
    fun knownMotionSensorsAreCappedWithoutDroppingTheFirstSample() {
        val limiter = SensorTransportRateLimiter()

        assertTrue(limiter.shouldTransmit("accelerometer:1", "android.sensor.accelerometer", 1_000_000_000L))
        assertFalse(limiter.shouldTransmit("accelerometer:1", "android.sensor.accelerometer", 1_010_000_000L))
        assertTrue(limiter.shouldTransmit("accelerometer:1", "android.sensor.accelerometer", 1_020_000_000L))
        assertEquals(50, limiter.maxHz("android.sensor.accelerometer"))
    }

    @Test
    fun unknownSensorsUseALowerBoundedBudgetAndRemainIndependent() {
        val limiter = SensorTransportRateLimiter()

        assertTrue(limiter.shouldTransmit("temperature:1", "android.sensor.temperature", 1_000_000_000L))
        assertFalse(limiter.shouldTransmit("temperature:1", "android.sensor.temperature", 1_199_000_000L))
        assertTrue(limiter.shouldTransmit("temperature:1", "android.sensor.temperature", 1_200_000_000L))
        assertTrue(limiter.shouldTransmit("temperature:2", "android.sensor.temperature", 1_001_000_000L))
        assertEquals(5, limiter.maxHz("android.sensor.temperature"))
    }

    @Test
    fun priorityEventBypassesPoseWindowAndBecomesTheNewBaseline() {
        val limiter = SensorTransportRateLimiter()

        assertTrue(limiter.shouldTransmit("fused.pose", "fused.pose", 1_000_000_000L))
        assertFalse(limiter.shouldTransmit("fused.pose", "fused.pose", 1_001_000_000L))
        assertTrue(limiter.shouldTransmit("fused.pose", "fused.pose", 1_002_000_000L, priority = true))
        assertFalse(limiter.shouldTransmit("fused.pose", "fused.pose", 1_003_000_000L))
        assertTrue(limiter.shouldTransmit("fused.pose", "fused.pose", 1_102_000_000L))
    }
}
