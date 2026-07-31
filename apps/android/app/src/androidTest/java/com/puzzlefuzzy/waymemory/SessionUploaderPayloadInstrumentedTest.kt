package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.CollectedSample
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
}
