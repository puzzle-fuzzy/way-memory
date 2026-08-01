package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.SensorInventorySample
import com.puzzlefuzzy.waymemory.sensing.SessionUploader
import com.puzzlefuzzy.waymemory.sensing.buildSessionStartRequest
import com.puzzlefuzzy.waymemory.sensing.canSendCredentialOverTransport
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionUploaderPayloadTest {
    @Test
    fun deviceCredentialsRequireHttpsExceptForLocalDevelopmentEndpoints() {
        assertTrue(canSendCredentialOverTransport("https://way-memory.yxswy.com"))
        assertTrue(canSendCredentialOverTransport("http://127.0.0.1:8787"))
        assertTrue(canSendCredentialOverTransport("http://10.0.2.2:8787"))
        assertFalse(canSendCredentialOverTransport("http://101.35.246.159"))
        assertFalse(canSendCredentialOverTransport("ws://way-memory.yxswy.com"))
    }

    @Test
    fun replacementSessionStartRetainsSensorInventoryAndTransportBudget() {
        val request = buildSessionStartRequest(
            deviceId = "device-1",
            sensorInventory = listOf(
                SensorInventorySample(
                    sensorType = "android.sensor.accelerometer",
                    sensorId = 7,
                    name = "Accelerometer",
                    maximumRange = 39.2f,
                    resolution = 0.01f,
                    fifoReservedEventCount = 16,
                    fifoMaxEventCount = 128,
                    wakeUpSensor = false,
                    dynamicSensor = false,
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
        assertEquals(7, request.sensorInventory[0].sensorId)
        assertEquals(39.2f, request.sensorInventory[0].maximumRange)
        assertEquals(0.01f, request.sensorInventory[0].resolution)
        assertEquals(16, request.sensorInventory[0].fifoReservedEventCount)
        assertEquals(128, request.sensorInventory[0].fifoMaxEventCount)
        assertEquals(false, request.sensorInventory[0].wakeUpSensor)
        assertEquals(false, request.sensorInventory[0].dynamicSensor)
        assertEquals(50, request.sensorInventory[0].transportMaxHz)
        assertEquals(false, request.sensorInventory[1].registered)
    }

    @Test
    fun navigationSessionStartRetainsRouteBinding() {
        val request = buildSessionStartRequest(
            deviceId = "device-navigation",
            sensorInventory = emptyList(),
            mode = "navigation",
            routeId = "route-verified",
        )

        assertEquals("navigation", request.mode)
        assertEquals("route-verified", request.routeId)
    }

    @Test
    fun navigationHandoffIsCarriedOnlyOnTheSessionStartMessage() {
        val request = buildSessionStartRequest(
            deviceId = "device-navigation",
            sensorInventory = emptyList(),
            mode = "navigation",
            handoffToken = "wm_nav_one_time",
        )

        assertEquals("navigation", request.mode)
        assertEquals("wm_nav_one_time", request.handoffToken)
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
