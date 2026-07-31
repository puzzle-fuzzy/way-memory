package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.PoseFusionEngine
import com.puzzlefuzzy.waymemory.sensing.VisualPoseSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PoseFusionEngineTest {
    @Test
    fun stationaryUpdatesZeroVelocityAndExposesFusedPose() {
        val engine = PoseFusionEngine()
        engine.updatePressure(1013.25f, 1_000_000_000L)
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_400_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        val update = engine.updateImu(1_600_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        assertNotNull(update)
        assertEquals("stationary", update?.pose?.motionMode)
        assertEquals(0f, update?.pose?.velocityXMps)
        assertEquals("fused", update?.pose?.source)
    }

    @Test
    fun gnssVelocityIsEstimatedFromSuccessiveFixes() {
        val engine = PoseFusionEngine()
        val first = engine.updateGnss(31.230000, 121.470000, 4f, null, 1_000_000_000L)
        val second = engine.updateGnss(31.230010, 121.470000, 4f, null, 2_000_000_000L)

        assertNotNull(first)
        assertTrue((second?.pose?.velocityYMps ?: 0f) > 0.3f)
        assertTrue(second?.pose?.sourceFlags?.contains("gnss") == true)
    }

    @Test
    fun lateGnssAltitudeEstablishesAContinuousRelativeHeightReference() {
        val engine = PoseFusionEngine()
        engine.updateGnss(31.230000, 121.470000, 5f, null, 1_000_000_000L)
        engine.updateGnss(31.230000, 121.470000, 5f, 100.0, 2_000_000_000L)
        val afterAltitudeMoves = engine.updateGnss(31.230000, 121.470000, 5f, 101.0, 3_000_000_000L)

        assertTrue((afterAltitudeMoves?.pose?.zM ?: 0f) > 0.1f)
    }

    @Test
    fun staleGnssLowersConfidenceInsteadOfClaimingFreshPosition() {
        val engine = PoseFusionEngine()
        val fresh = engine.updateGnss(31.230000, 121.470000, 4f, null, 1_000_000_000L)
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(8_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        val stale = engine.updateImu(8_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)

        assertTrue(fresh != null)
        assertTrue(stale?.pose?.sourceFlags?.contains("gnss-stale") == true)
        assertTrue(stale?.pose?.sourceFlags?.contains("gnss") != true)
        assertTrue((stale?.pose?.accuracyM ?: 0f) > (fresh?.pose?.accuracyM ?: 0f))
    }

    @Test
    fun outOfOrderImuSampleCannotRewindTheFusionClock() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_300_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_150_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        val afterOutOfOrder = engine.updateImu(1_400_000_000L, floatArrayOf(0f, 0f, 0f), 0f)

        assertNotNull(afterOutOfOrder)
        assertEquals(1_400_000_000L, afterOutOfOrder?.pose?.deviceTimestampNs)
    }

    @Test
    fun stepAidedPositionAddsWalkingDisplacementInTheCurrentHeading() {
        val engine = PoseFusionEngine()
        val first = engine.updateStep(1_000_000_000L, 0f)
        val second = engine.updateStep(2_000_000_000L, 0f)

        assertTrue((first?.pose?.yM ?: 0f) > 0.2f)
        assertTrue((second?.pose?.yM ?: 0f) > (first?.pose?.yM ?: 0f))
        assertTrue(second?.pose?.sourceFlags?.contains("step-pdr") == true)
    }

    @Test
    fun sustainedPressureChangeProducesElevatorCandidate() {
        val engine = PoseFusionEngine()
        var elevatorEvent = false
        var timestampNs = 1_000_000_000L
        engine.updatePressure(1013.25f, timestampNs)
        engine.updateImu(timestampNs, floatArrayOf(0.3f, 0f, 0f), 0.05f)
        repeat(12) {
            timestampNs += 200_000_000L
            engine.updatePressure(1013.25f - (it + 1) * 0.08f, timestampNs)
            val update = engine.updateImu(timestampNs, floatArrayOf(0.3f, 0f, 0f), 0.05f)
            if (update?.motionEvent?.type == "elevator-candidate") elevatorEvent = true
        }
        assertTrue(elevatorEvent)
    }

    @Test
    fun sustainedVerticalMotionWithHorizontalTravelProducesStairsEvent() {
        val engine = PoseFusionEngine()
        var stairsEvent = false
        val observedModes = mutableSetOf<String>()
        var timestampNs = 1_000_000_000L
        engine.updatePressure(1013.25f, timestampNs)
        engine.updateImu(timestampNs, floatArrayOf(0.4f, 0f, 0f), 0.05f)
        repeat(30) {
            timestampNs += 200_000_000L
            engine.updatePressure(1013.25f - (it + 1) * 0.015f, timestampNs)
            val update = engine.updateImu(timestampNs, floatArrayOf(0.4f, 0f, 0f), 0.05f)
            update?.let { observedModes += it.pose.motionMode }
            if (update?.motionEvent?.type == "stairs-enter") stairsEvent = true
        }
        assertTrue(stairsEvent)
        assertTrue(observedModes.contains("stairs"))
    }

    @Test
    fun visualPoseIsPromotedOnlyAfterFrameAlignment() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        val firstVisual = engine.updateVisual(VisualPoseSample(1_100_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        assertEquals(null, firstVisual)

        var timestampNs = 1_200_000_000L
        repeat(12) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
        }
        val aligned = engine.updateVisual(VisualPoseSample(timestampNs + 100_000_000L, 1.5f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        assertNotNull(aligned)
        assertTrue(aligned?.pose?.sourceFlags?.contains("visual-aligned") == true)
        assertEquals("local-enu", aligned?.pose?.frame)
    }

    @Test
    fun visualAlignmentUsesCumulativeDisplacementAcrossSmallFrames() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))

        var timestampNs = 1_200_000_000L
        var visualX = 0f
        repeat(14) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
            visualX += 0.1f
            engine.updateVisual(VisualPoseSample(timestampNs + 10_000_000L, visualX, 0f, 0f, 0.15f, 0.9f, "tracking"))
        }

        val aligned = engine.updateVisual(VisualPoseSample(timestampNs + 20_000_000L, 1.5f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        assertNotNull(aligned)
        assertTrue(aligned?.pose?.sourceFlags?.contains("visual-aligned") == true)
    }

    @Test
    fun visualReturnEmitsLoopClosureEvidence() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        var timestampNs = 1_200_000_000L
        repeat(15) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
        }
        engine.updateVisual(VisualPoseSample(timestampNs + 100_000_000L, 4f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        engine.updateVisual(VisualPoseSample(timestampNs + 200_000_000L, 8f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        val returned = engine.updateVisual(VisualPoseSample(timestampNs + 300_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        assertEquals("loop-closed", returned?.motionEvent?.type)
        assertTrue(returned?.pose?.sourceFlags?.contains("loop-closure") == true)
    }

    @Test
    fun visualReturnUsesTheInitialVisualOriginInsteadOfWorldZero() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 10f, 20f, 3f, 0.15f, 0.9f, "tracking"))
        var timestampNs = 1_200_000_000L
        repeat(14) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
        }
        engine.updateVisual(VisualPoseSample(timestampNs + 100_000_000L, 12f, 20f, 3f, 0.15f, 0.9f, "tracking"))
        engine.updateVisual(VisualPoseSample(timestampNs + 200_000_000L, 18f, 20f, 3f, 0.15f, 0.9f, "tracking"))
        val returned = engine.updateVisual(VisualPoseSample(timestampNs + 300_000_000L, 10f, 20f, 3f, 0.15f, 0.9f, "tracking"))
        assertEquals("loop-closed", returned?.motionEvent?.type)
    }
}
