package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.SensorInventorySample
import com.puzzlefuzzy.waymemory.sensing.buildSessionStartRequest
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionUploaderPayloadTest {
    @Test
    fun replacementSessionStartRetainsSensorInventoryAndTransportBudget() {
        val request = buildSessionStartRequest(
            deviceId = "device-1",
            sensorInventory = listOf(
                SensorInventorySample(
                    sensorType = "android.sensor.accelerometer",
                    name = "Accelerometer",
                    transportMaxHz = 50,
                    registered = true,
                ),
                SensorInventorySample(
                    sensorType = "android.sensor.step_detector",
                    name = "Step detector",
                    transportMaxHz = 5,
                    registered = false,
                ),
            ),
        )

        assertEquals("device-1", request.deviceId)
        assertEquals(2, request.sensorInventory.size)
        assertEquals(50, request.sensorInventory[0].transportMaxHz)
        assertEquals(false, request.sensorInventory[1].registered)
    }
}
