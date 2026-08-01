package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.CollectedSample
import com.puzzlefuzzy.waymemory.sensing.LocationSample
import com.puzzlefuzzy.waymemory.sensing.buildSamplesMessage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject

@RunWith(AndroidJUnit4::class)
class SessionUploaderPayloadInstrumentedTest {
    @Test
    fun locationProviderSurvivesTheAndroidJsonCodec() {
        val payload = buildSamplesMessage(
            sessionId = "session-gps-provider",
            batch = listOf(
                CollectedSample(
                    deviceTimestampNs = 30,
                    sensorType = "location",
                    values = emptyList(),
                    location = LocationSample(
                        lat = 31.2304,
                        lng = 121.4737,
                        accuracyM = 4f,
                        provider = "gps",
                    ),
                ),
            ),
        )

        val location = payload.getJSONArray("samples").getJSONObject(0).getJSONObject("location")
        assertEquals("gps", location.getString("provider"))
        assertEquals(31.2304, location.getDouble("lat"), 0.000001)
    }

    @Test
    fun sampleUploadUsesObjectsInsteadOfJsonStrings() {
        val payload = buildSamplesMessage(
            sessionId = "session-1",
            batch = listOf(
                CollectedSample(
                    deviceTimestampNs = 10,
                    sensorType = "android.sensor.linear_acceleration",
                    values = listOf(0.1f, 0.2f, 0.3f),
                ),
            ),
        )

        val samples = payload.getJSONArray("samples")
        assertTrue(samples.get(0) is JSONObject)
        assertEquals(10, samples.getJSONObject(0).getLong("deviceTimestampNs"))
    }

    @Test
    fun visualDiagnosticsSurviveTheQueuedPayloadCodec() {
        val payload = buildSamplesMessage(
            sessionId = "session-visual-reset",
            batch = listOf(
                CollectedSample(
                    deviceTimestampNs = 20,
                    sensorType = "arcore.visual-pose",
                    sensorId = 42,
                    values = listOf(0f, 0f, 0f),
                    metadata = mapOf(
                        "trackingState" to "tracking",
                        "trackingReset" to true,
                        "confidence" to 0.9f,
                    ),
                ),
            ),
        )

        val metadata = payload.getJSONArray("samples").getJSONObject(0).getJSONObject("metadata")
        assertEquals(42, payload.getJSONArray("samples").getJSONObject(0).getInt("sensorId"))
        assertEquals("tracking", metadata.getString("trackingState"))
        assertTrue(metadata.getBoolean("trackingReset"))
        assertEquals(0.9, metadata.getDouble("confidence"), 0.0001)
    }
}
