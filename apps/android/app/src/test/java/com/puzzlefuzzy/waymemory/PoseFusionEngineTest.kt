package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.PoseFusionEngine
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
}
