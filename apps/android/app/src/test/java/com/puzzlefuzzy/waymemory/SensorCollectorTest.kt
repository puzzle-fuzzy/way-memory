package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.shouldAcceptRotationSource
import com.puzzlefuzzy.waymemory.sensing.isPrimaryLocationProvider
import com.puzzlefuzzy.waymemory.sensing.canUseAccelerometerFallbackDuringRotation
import com.puzzlefuzzy.waymemory.sensing.buildVisualStatusSample
import com.puzzlefuzzy.waymemory.sensing.buildSessionLifecycleSample
import com.puzzlefuzzy.waymemory.sensing.SessionLifecycleEvent
import com.puzzlefuzzy.waymemory.sensing.PoseEstimateSample
import com.puzzlefuzzy.waymemory.sensing.transformDeviceAcceleration
import com.puzzlefuzzy.waymemory.sensing.VisualTrackingStatus
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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

    @Test
    fun visualTrackingStatusIsRetainedAsDiagnosticMetadataOnly() {
        val sample = buildVisualStatusSample(
            VisualTrackingStatus(
                available = true,
                active = true,
                trackingState = "paused",
                failureReason = "INSUFFICIENT_FEATURES",
                detail = "等待视觉特征",
            ),
            3_000_000_000L,
        )

        assertEquals("arcore.visual-status", sample?.sensorType)
        assertTrue(sample?.pose == null)
        assertTrue(sample?.relativePosition == null)
        assertEquals(true, sample?.metadata?.get("available"))
        assertEquals("paused", sample?.metadata?.get("trackingState"))
        assertEquals("INSUFFICIENT_FEATURES", sample?.metadata?.get("failureReason"))
    }

    @Test
    fun sessionResumeIsRetainedAsBoundedDiagnosticMetadata() {
        val sample = buildSessionLifecycleSample(
            SessionLifecycleEvent(
                resumed = true,
                latestPose = PoseEstimateSample(
                    deviceTimestampNs = 2_000_000_000L,
                    xM = 1f,
                    yM = 2f,
                    zM = 3f,
                    velocityXMps = 0f,
                    velocityYMps = 0f,
                    velocityZMps = 0f,
                    accuracyM = 1f,
                    confidence = 0.8f,
                    source = "fused",
                    sourceFlags = listOf("recovered-anchor"),
                    motionMode = "walking",
                    stationary = false,
                ),
            ),
            3_000_000_000L,
        )

        assertEquals("way-memory.session-resumed", sample?.sensorType)
        assertTrue(sample?.pose == null)
        assertEquals(true, sample?.metadata?.get("resumed"))
        assertEquals(2_000_000_000L, sample?.metadata?.get("latestPoseTimestampNs"))
    }
}
