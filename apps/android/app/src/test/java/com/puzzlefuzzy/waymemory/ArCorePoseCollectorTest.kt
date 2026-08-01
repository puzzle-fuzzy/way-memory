package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.arCoreDeltaToDisplayFrame
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class ArCorePoseCollectorTest {
    @Test
    fun mapsArCoreCameraAxesToDisplayFrame() {
        // ARCore camera coordinates: +X right, +Y up, -Z forward.
        // The route frame is X right, Y forward, Z up.
        assertArrayEquals(
            floatArrayOf(1f, 3f, 2f),
            arCoreDeltaToDisplayFrame(floatArrayOf(1f, 2f, -3f)),
            0f,
        )
    }

    @Test
    fun rejectsIncompleteTranslation() {
        assertThrows(IllegalArgumentException::class.java) {
            arCoreDeltaToDisplayFrame(floatArrayOf(1f, 2f))
        }
    }
}
