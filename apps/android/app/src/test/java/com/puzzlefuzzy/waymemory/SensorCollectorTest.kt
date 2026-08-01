package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.shouldAcceptRotationSource
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SensorCollectorTest {
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
}
