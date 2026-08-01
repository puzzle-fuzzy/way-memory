package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.shouldAcceptRotationSource
import com.puzzlefuzzy.waymemory.sensing.isPrimaryLocationProvider
import com.puzzlefuzzy.waymemory.sensing.canUseAccelerometerFallbackDuringRotation
import com.puzzlefuzzy.waymemory.sensing.transformDeviceAcceleration
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SensorCollectorTest {
    @Test
    fun networkFixIsDiagnosticWhenGpsProviderExists() {
        assertTrue(isPrimaryLocationProvider("gps"))
        assertFalse(isPrimaryLocationProvider("network"))
        assertFalse(isPrimaryLocationProvider(null))
    }

    @Test
    fun accelerometerFallbackIsBlockedDuringFastRotation() {
        assertTrue(canUseAccelerometerFallbackDuringRotation(0.8f))
        assertFalse(canUseAccelerometerFallbackDuringRotation(1.3f))
        assertFalse(canUseAccelerometerFallbackDuringRotation(Float.NaN))
    }

    @Test
    fun transformsAccelerationWithTheWorldRotationMatrix() {
        assertArrayEquals(
            floatArrayOf(0f, 1f, 0f),
            transformDeviceAcceleration(
                floatArrayOf(0f, -1f, 0f, 1f, 0f, 0f, 0f, 0f, 1f),
                listOf(1f, 0f, 0f),
            ),
            0f,
        )
    }

    @Test
    fun rejectsInvalidAccelerationFrames() {
        assertNull(transformDeviceAcceleration(FloatArray(9), listOf(1f, Float.NaN, 3f)))
        assertNull(transformDeviceAcceleration(FloatArray(8), listOf(1f, 2f, 3f)))
    }

    @Test
    fun lowerPrioritySourceCannotReplaceFreshPreferredSource() {
        assertFalse(
            shouldAcceptRotationSource(
                currentPriority = 3,
                currentTimestampNs = 1_000_000_000L,
                incomingPriority = 2,
                incomingTimestampNs = 1_400_000_000L,
            ),
        )
    }

    @Test
    fun higherPrioritySourceMayReplaceFreshLowerPrioritySource() {
        assertTrue(
            shouldAcceptRotationSource(
                currentPriority = 2,
                currentTimestampNs = 1_000_000_000L,
                incomingPriority = 3,
                incomingTimestampNs = 1_100_000_000L,
            ),
        )
    }

    @Test
    fun lowerPrioritySourceTakesOverAfterPreferredSourceIsStale() {
        assertTrue(
            shouldAcceptRotationSource(
                currentPriority = 3,
                currentTimestampNs = 1_000_000_000L,
                incomingPriority = 2,
                incomingTimestampNs = 1_800_000_001L,
            ),
        )
    }

    @Test
    fun samePriorityOutOfOrderCallbackIsRejected() {
        assertFalse(
            shouldAcceptRotationSource(
                currentPriority = 2,
                currentTimestampNs = 2_000_000_000L,
                incomingPriority = 2,
                incomingTimestampNs = 1_900_000_000L,
            ),
        )
    }
}
