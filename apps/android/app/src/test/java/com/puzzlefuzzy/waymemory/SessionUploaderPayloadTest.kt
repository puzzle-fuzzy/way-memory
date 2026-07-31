package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.SensorInventorySample
import com.puzzlefuzzy.waymemory.sensing.SessionUploader
import com.puzzlefuzzy.waymemory.sensing.buildSessionStartRequest
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test
    fun persistedSessionMarkerOnlyRequestsResumeWhenItContainsAnId() {
        val directory = Files.createTempDirectory("way-memory-resume").toFile()
        try {
            val uploader = SessionUploader(storageDirectory = directory)
            assertFalse(uploader.hasPersistedSession())
            java.io.File(directory, "active-session.id").writeText("session-1")
            assertTrue(uploader.hasPersistedSession())
            java.io.File(directory, "active-session.id").writeText("  ")
            assertFalse(uploader.hasPersistedSession())
        } finally {
            directory.deleteRecursively()
        }
    }
}
