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
        val update = engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        assertNotNull(update)
        assertEquals("stationary", update?.pose?.motionMode)
        assertEquals(0f, update?.pose?.velocityXMps)
        assertEquals("fused", update?.pose?.source)
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
    fun visualReturnEmitsLoopCandidateWithoutSnappingRoute() {
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
        assertEquals("loop-candidate", returned?.motionEvent?.type)
    }
}
