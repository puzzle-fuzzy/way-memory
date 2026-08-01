package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.CollectedSample
import com.puzzlefuzzy.waymemory.sensing.PersistentSampleQueue
import com.puzzlefuzzy.waymemory.sensing.SampleCodec
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PersistentSampleQueueTest {
    @Test
    fun boundedQueueRecoversAndAcknowledgesSamplesAfterReopen() {
        val directory = Files.createTempDirectory("way-memory-queue").toFile()
        try {
            val first = sample(1, "accelerometer")
            val second = sample(2, "gyroscope")
            val third = sample(3, "arcore.visual-pose")
            PersistentSampleQueue(directory, maxSamples = 2, codec = TestCodec).use { queue ->
                assertEquals(0, queue.add(first))
                assertEquals(0, queue.add(second))
                assertEquals(1, queue.add(third))
                assertEquals(listOf(second, third), queue.peek(10))
                queue.acknowledge(1)
                assertEquals(listOf(third), queue.peek(10))
            }

            PersistentSampleQueue(directory, maxSamples = 2, codec = TestCodec).use { reopened ->
                assertEquals(1, reopened.size())
                val recovered = reopened.peek(1).single()
                assertEquals(third.deviceTimestampNs, recovered.deviceTimestampNs)
                assertEquals(third.sensorType, recovered.sensorType)
                reopened.acknowledge(1)
                assertEquals(0, reopened.size())
            }
            PersistentSampleQueue(directory, maxSamples = 2, codec = TestCodec).use { queue ->
                queue.add(first)
                queue.clear()
                assertEquals(0, queue.size())
            }
            PersistentSampleQueue(directory, maxSamples = 2, codec = TestCodec).use { cleared ->
                assertEquals(0, cleared.size())
            }
            assertTrue(directory.exists())
        } finally {
            directory.deleteRecursively()
        }
    }

    private fun sample(timestampNs: Long, sensorType: String) = CollectedSample(
        deviceTimestampNs = timestampNs,
        sensorType = sensorType,
        values = listOf(1.0f, -2.0f, 3.0f),
    )

    private object TestCodec : SampleCodec {
        override fun encode(sample: CollectedSample): String = "${sample.deviceTimestampNs}|${sample.sensorType}"

        override fun decode(encoded: String): CollectedSample? {
            val separator = encoded.indexOf('|')
            if (separator <= 0) return null
            return CollectedSample(
                deviceTimestampNs = encoded.substring(0, separator).toLongOrNull() ?: return null,
                sensorType = encoded.substring(separator + 1),
            )
        }
    }
}
