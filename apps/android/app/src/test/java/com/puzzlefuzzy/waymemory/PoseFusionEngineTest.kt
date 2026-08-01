package com.puzzlefuzzy.waymemory

import com.puzzlefuzzy.waymemory.sensing.PoseFusionEngine
import com.puzzlefuzzy.waymemory.sensing.VisualPoseSample
import com.puzzlefuzzy.waymemory.sensing.arCoreDeltaToDisplayFrame
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PoseFusionEngineTest {
    @Test
    fun arCoreAxesMapToDisplayFrameWithoutSwappingHeight() {
        assertArrayEquals(
            floatArrayOf(2f, 3f, 4f),
            arCoreDeltaToDisplayFrame(floatArrayOf(2f, 4f, -3f)),
            0.0001f,
        )
    }

    @Test
    fun stationaryUpdatesZeroVelocityAndExposesFusedPose() {
        val engine = PoseFusionEngine()
        engine.updatePressure(1013.25f, 1_000_000_000L)
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_400_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        val update = engine.updateImu(1_600_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        assertNotNull(update)
        assertEquals("stationary", update?.pose?.motionMode)
        assertEquals(0f, update?.pose?.velocityXMps)
        assertEquals("fused", update?.pose?.source)
    }

    @Test
    fun inertialOnlyPoseIsMarkedRelativeAndDoesNotClaimGnssAccuracy() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        val update = engine.updateImu(1_200_000_000L, floatArrayOf(0.4f, 0f, 0f), 0f)

        assertNotNull(update)
        assertTrue(update?.pose?.sourceFlags?.contains("relative-only") == true)
        assertTrue("inertial-only Pose is overconfident", (update?.pose?.accuracyM ?: 0f) >= 12f)
    }

    @Test
    fun stableBarometerDoesNotEraseShortVerticalInertialMotion() {
        val engine = PoseFusionEngine()
        var timestampNs = 1_000_000_000L
        engine.updatePressure(1013.25f, timestampNs)
        engine.updateImu(timestampNs, floatArrayOf(0f, 0f, 0f), 0f)

        var last: com.puzzlefuzzy.waymemory.sensing.PoseUpdate? = null
        repeat(20) {
            timestampNs += 100_000_000L
            // The pressure remains unchanged while the phone is lifted. The
            // inertial vertical displacement must remain visible meanwhile.
            engine.updatePressure(1013.25f, timestampNs)
            last = engine.updateImu(timestampNs, floatArrayOf(0f, 0f, 2f), 0f)
        }

        assertNotNull(last)
        assertTrue(
            "stable pressure erased a real short vertical movement",
            (last?.pose?.zM ?: 0f) > 0.4f,
        )
    }

    @Test
    fun gnssVelocityIsEstimatedFromSuccessiveFixes() {
        val engine = PoseFusionEngine()
        val first = engine.updateGnss(31.230000, 121.470000, 4f, null, 1_000_000_000L)
        val second = engine.updateGnss(31.230010, 121.470000, 4f, null, 2_000_000_000L)

        assertNotNull(first)
        assertTrue((second?.pose?.velocityYMps ?: 0f) > 0.3f)
        assertTrue(second?.pose?.sourceFlags?.contains("gnss") == true)
    }

    @Test
    fun implausibleGnssJumpDoesNotTeleportTheFusedPose() {
        val engine = PoseFusionEngine()
        val first = engine.updateGnss(31.230000, 121.470000, 4f, null, 1_000_000_000L)
        val rejected = engine.updateGnss(31.240000, 121.470000, 4f, null, 2_000_000_000L)

        assertNotNull(first)
        assertNotNull(rejected)
        assertTrue(rejected?.pose?.sourceFlags?.contains("gnss-rejected") == true)
        assertTrue(kotlin.math.abs(rejected?.pose?.xM ?: 1f) < 1f)
        assertTrue(kotlin.math.abs(rejected?.pose?.yM ?: 1f) < 1f)
    }

    @Test
    fun lateGnssAltitudeEstablishesAContinuousRelativeHeightReference() {
        val engine = PoseFusionEngine()
        engine.updateGnss(31.230000, 121.470000, 5f, null, 1_000_000_000L)
        engine.updateGnss(31.230000, 121.470000, 5f, 100.0, 2_000_000_000L)
        val afterAltitudeMoves = engine.updateGnss(31.230000, 121.470000, 5f, 101.0, 3_000_000_000L)

        assertTrue((afterAltitudeMoves?.pose?.zM ?: 0f) > 0.1f)
    }

    @Test
    fun staleGnssLowersConfidenceInsteadOfClaimingFreshPosition() {
        val engine = PoseFusionEngine()
        val fresh = engine.updateGnss(31.230000, 121.470000, 4f, null, 1_000_000_000L)
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(8_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        val stale = engine.updateImu(8_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)

        assertTrue(fresh != null)
        assertTrue(stale?.pose?.sourceFlags?.contains("gnss-stale") == true)
        assertTrue(stale?.pose?.sourceFlags?.contains("gnss") != true)
        assertTrue((stale?.pose?.accuracyM ?: 0f) > (fresh?.pose?.accuracyM ?: 0f))
    }

    @Test
    fun outOfOrderImuSampleCannotRewindTheFusionClock() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_300_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateImu(1_150_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        val afterOutOfOrder = engine.updateImu(1_400_000_000L, floatArrayOf(0f, 0f, 0f), 0f)

        assertNotNull(afterOutOfOrder)
        assertEquals(1_400_000_000L, afterOutOfOrder?.pose?.deviceTimestampNs)
    }

    @Test
    fun recoveredPoseSeedsTheExistingCoordinateFrame() {
        val engine = PoseFusionEngine()
        engine.seedFromPose(
            com.puzzlefuzzy.waymemory.sensing.PoseEstimateSample(
                deviceTimestampNs = 10_000_000_000L,
                xM = 12.5f,
                yM = -4.25f,
                zM = 2.75f,
                velocityXMps = 0.4f,
                velocityYMps = -0.2f,
                velocityZMps = 0.1f,
                accuracyM = 1.2f,
                confidence = 0.9f,
                source = "fused",
                sourceFlags = listOf("imu", "recovered-anchor"),
                motionMode = "walking",
                stationary = false,
            ),
        )

        val afterRecovery = engine.updateImu(
            10_200_000_000L,
            floatArrayOf(0f, 0f, 0f),
            angularRateMagnitude = 0f,
        )

        assertNotNull(afterRecovery)
        assertTrue((afterRecovery?.pose?.xM ?: 0f) > 12f)
        assertTrue((afterRecovery?.pose?.yM ?: 0f) < -4f)
        assertTrue((afterRecovery?.pose?.zM ?: 0f) > 2.5f)
        assertTrue(afterRecovery?.pose?.sourceFlags?.contains("recovered-anchor") == true)
    }

    @Test
    fun firstGnssFixDoesNotResetARecoveredRouteToZero() {
        val engine = PoseFusionEngine()
        engine.seedFromPose(
            com.puzzlefuzzy.waymemory.sensing.PoseEstimateSample(
                deviceTimestampNs = 10_000_000_000L,
                xM = 12f,
                yM = 3f,
                zM = 1f,
                velocityXMps = 0f,
                velocityYMps = 0f,
                velocityZMps = 0f,
                accuracyM = 1f,
                confidence = 0.95f,
                source = "fused",
                sourceFlags = listOf("imu"),
                motionMode = "stationary",
                stationary = true,
            ),
        )

        val firstFix = engine.updateGnss(31.230000, 121.470000, 4f, 100.0, 10_500_000_000L)

        assertNotNull(firstFix)
        assertTrue((firstFix?.pose?.xM ?: 0f) > 10f)
        assertTrue((firstFix?.pose?.yM ?: 0f) > 2f)
        assertTrue((firstFix?.pose?.zM ?: 0f) > 0.8f)
    }

    @Test
    fun pureRotationKeepsTranslationAtTheOrigin() {
        val engine = PoseFusionEngine()
        var timestampNs = 1_000_000_000L
        engine.updateImu(timestampNs, floatArrayOf(0f, 0f, 0f), 0f)
        var last: com.puzzlefuzzy.waymemory.sensing.PoseUpdate? = null
        repeat(30) {
            timestampNs += 100_000_000L
            last = engine.updateImu(timestampNs, floatArrayOf(0f, 0f, 0f), 1.8f)
        }

        assertNotNull(last)
        assertEquals("stationary", last?.pose?.motionMode)
        assertTrue(kotlin.math.abs(last?.pose?.xM ?: 1f) < 0.01f)
        assertTrue(kotlin.math.abs(last?.pose?.yM ?: 1f) < 0.01f)
        assertTrue(kotlin.math.abs(last?.pose?.zM ?: 1f) < 0.01f)
    }

    @Test
    fun stepAidedPositionAddsWalkingDisplacementInTheCurrentHeading() {
        val engine = PoseFusionEngine()
        val first = engine.updateStep(1_000_000_000L, 0f)
        val second = engine.updateStep(2_000_000_000L, 0f)

        assertTrue((first?.pose?.yM ?: 0f) > 0.2f)
        assertTrue((second?.pose?.yM ?: 0f) > (first?.pose?.yM ?: 0f))
        assertTrue(second?.pose?.sourceFlags?.contains("step-pdr") == true)
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
    fun pressureChangeWhilePhoneIsHeldStillProducesElevatorCandidate() {
        val engine = PoseFusionEngine()
        var elevatorEvent = false
        var timestampNs = 1_000_000_000L
        val baselinePressure = 1013.25f
        engine.updatePressure(baselinePressure, timestampNs)
        repeat(24) {
            timestampNs += 200_000_000L
            engine.updatePressure(baselinePressure - (it + 1) * 0.08f, timestampNs)
            val update = engine.updateImu(timestampNs, floatArrayOf(0f, 0f, 0f), 0.02f)
            if (update?.motionEvent?.type == "elevator-candidate") elevatorEvent = true
        }

        assertTrue(elevatorEvent)
    }

    @Test
    fun elevatorEvidenceDecaysAndEmitsAnExitEvent() {
        val engine = PoseFusionEngine()
        var elevatorExit = false
        var timestampNs = 1_000_000_000L
        val baselinePressure = 1013.25f
        engine.updatePressure(baselinePressure, timestampNs)
        engine.updateImu(timestampNs, floatArrayOf(0.3f, 0f, 0f), 0.05f)
        repeat(12) {
            timestampNs += 200_000_000L
            engine.updatePressure(baselinePressure - (it + 1) * 0.08f, timestampNs)
            engine.updateImu(timestampNs, floatArrayOf(0.3f, 0f, 0f), 0.05f)
        }

        repeat(40) {
            timestampNs += 200_000_000L
            engine.updatePressure(baselinePressure - 0.96f, timestampNs)
            val update = engine.updateImu(timestampNs, floatArrayOf(0f, 0f, 0f), 0f)
            if (update?.motionEvent?.type == "elevator-exit") elevatorExit = true
        }

        assertTrue(elevatorExit)
    }

    @Test
    fun sustainedVerticalMotionWithHorizontalTravelProducesStairsEvent() {
        val engine = PoseFusionEngine()
        var stairsEvent = false
        val observedModes = mutableSetOf<String>()
        var timestampNs = 1_000_000_000L
        engine.updatePressure(1013.25f, timestampNs)
        engine.updateImu(timestampNs, floatArrayOf(0.4f, 0f, 0f), 0.05f)
        repeat(30) {
            timestampNs += 200_000_000L
            engine.updatePressure(1013.25f - (it + 1) * 0.015f, timestampNs)
            val update = engine.updateImu(timestampNs, floatArrayOf(0.4f, 0f, 0f), 0.05f)
            update?.let { observedModes += it.pose.motionMode }
            if (update?.motionEvent?.type == "stairs-enter") stairsEvent = true
        }
        assertTrue(stairsEvent)
        assertTrue(observedModes.contains("stairs"))
    }

    @Test
    fun stairsEvidenceDecaysAndEmitsAnExitEvent() {
        val engine = PoseFusionEngine()
        var stairsExit = false
        var timestampNs = 1_000_000_000L
        val baselinePressure = 1013.25f
        engine.updatePressure(baselinePressure, timestampNs)
        engine.updateImu(timestampNs, floatArrayOf(0.4f, 0f, 0f), 0.05f)
        repeat(30) {
            timestampNs += 200_000_000L
            engine.updatePressure(baselinePressure - (it + 1) * 0.015f, timestampNs)
            engine.updateImu(timestampNs, floatArrayOf(0.4f, 0f, 0f), 0.05f)
        }

        repeat(40) {
            timestampNs += 200_000_000L
            engine.updatePressure(baselinePressure - 0.45f, timestampNs)
            val update = engine.updateImu(timestampNs, floatArrayOf(0f, 0f, 0f), 0f)
            if (update?.motionEvent?.type == "stairs-exit") stairsExit = true
        }

        assertTrue(stairsExit)
    }

    @Test
    fun directSpecialModeTransitionPreservesExitAndEntryEvents() {
        val engine = PoseFusionEngine()
        val observedEvents = mutableListOf<String>()
        var timestampNs = 1_000_000_000L
        val baselinePressure = 1013.25f
        engine.updatePressure(baselinePressure, timestampNs)
        repeat(14) {
            timestampNs += 200_000_000L
            engine.updatePressure(baselinePressure - (it + 1) * 0.08f, timestampNs)
            engine.updateImu(timestampNs, floatArrayOf(0f, 0f, 0f), 0f)
        }

        repeat(30) {
            timestampNs += 200_000_000L
            engine.updatePressure(baselinePressure - 1.12f - (it + 1) * 0.04f, timestampNs)
            engine.updateImu(timestampNs, floatArrayOf(2.0f, 0f, 0f), 0f)?.motionEvent?.type?.let(observedEvents::add)
        }

        assertTrue(observedEvents.contains("elevator-exit"))
        assertTrue(observedEvents.contains("stairs-enter"))
        assertTrue(observedEvents.indexOf("elevator-exit") < observedEvents.indexOf("stairs-enter"))
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
        assertTrue(aligned?.pose?.sourceFlags?.contains("visual-reset") != true)
        assertEquals("local-enu", aligned?.pose?.frame)
    }

    @Test
    fun visualConfidenceWidensTheFusedUncertainty() {
        fun alignedPose(confidence: Float): com.puzzlefuzzy.waymemory.sensing.PoseUpdate? {
            val engine = PoseFusionEngine()
            engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
            engine.updateVisual(VisualPoseSample(1_100_000_000L, 0f, 0f, 0f, 1f, confidence, "tracking"))

            var timestampNs = 1_200_000_000L
            repeat(12) {
                timestampNs += 100_000_000L
                engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
            }
            return engine.updateVisual(VisualPoseSample(timestampNs + 100_000_000L, 1.5f, 0f, 0f, 1f, confidence, "tracking"))
        }

        val highConfidence = alignedPose(0.95f)
        val lowConfidence = alignedPose(0.20f)
        assertNotNull(highConfidence)
        assertNotNull(lowConfidence)
        assertTrue(
            "low-confidence visual correction must expose wider uncertainty",
            (lowConfidence?.pose?.accuracyM ?: 0f) > (highConfidence?.pose?.accuracyM ?: 0f),
        )
    }

    @Test
    fun nonTrackingVisualFrameCannotMoveTheUnifiedRoute() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 0f, 0f, 0f, 1f, 0.9f, "tracking"))

        var timestampNs = 1_200_000_000L
        repeat(12) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
        }
        val aligned = engine.updateVisual(VisualPoseSample(timestampNs + 100_000_000L, 1.5f, 0f, 0f, 1f, 0.9f, "tracking"))
        assertNotNull(aligned)

        val stable = engine.updateImu(timestampNs + 200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        assertNotNull(stable)
        val paused = engine.updateVisual(VisualPoseSample(timestampNs + 300_000_000L, 40f, -20f, 5f, 0.5f, 1f, "paused"))
        assertEquals(null, paused)
        val recoveredVisual = engine.updateVisual(VisualPoseSample(timestampNs + 400_000_000L, 40f, -20f, 5f, 0.5f, 1f, "tracking"))
        assertEquals(null, recoveredVisual)
        val next = engine.updateImu(timestampNs + 400_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        assertNotNull(next)
        assertTrue(next?.pose?.sourceFlags?.contains("visual-reset") == true)
        assertTrue("paused visual frame created a false movement", kotlin.math.abs((next?.pose?.xM ?: 0f) - (stable?.pose?.xM ?: 0f)) < 0.01f)
        assertTrue("paused visual frame created a false movement", kotlin.math.abs((next?.pose?.yM ?: 0f) - (stable?.pose?.yM ?: 0f)) < 0.01f)
    }

    @Test
    fun visualAlignmentUsesCumulativeDisplacementAcrossSmallFrames() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))

        var timestampNs = 1_200_000_000L
        var visualX = 0f
        repeat(14) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
            visualX += 0.1f
            engine.updateVisual(VisualPoseSample(timestampNs + 10_000_000L, visualX, 0f, 0f, 0.15f, 0.9f, "tracking"))
        }

        val aligned = engine.updateVisual(VisualPoseSample(timestampNs + 20_000_000L, 1.5f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        assertNotNull(aligned)
        assertTrue(aligned?.pose?.sourceFlags?.contains("visual-aligned") == true)
    }

    @Test
    fun visualAlignmentStartsForSubMeterTranslation() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))

        var timestampNs = 1_200_000_000L
        var visualX = 0f
        var aligned: com.puzzlefuzzy.waymemory.sensing.PoseUpdate? = null
        repeat(8) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
            visualX += 0.05f
            aligned = engine.updateVisual(VisualPoseSample(timestampNs + 10_000_000L, visualX, 0f, 0f, 0.15f, 0.9f, "tracking")) ?: aligned
        }

        assertTrue("sub-meter visual movement did not align", aligned?.pose?.sourceFlags?.contains("visual-aligned") == true)
    }

    @Test
    fun visualReturnEmitsLoopClosureEvidence() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        var timestampNs = 1_200_000_000L
        repeat(15) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
        }
        engine.updateVisual(VisualPoseSample(timestampNs + 1_000_000_000L, 4f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        engine.updateVisual(VisualPoseSample(timestampNs + 1_800_000_000L, 8f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        val returned = engine.updateVisual(VisualPoseSample(timestampNs + 2_600_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        assertEquals("loop-closed", returned?.motionEvent?.type)
        assertTrue(returned?.pose?.sourceFlags?.contains("loop-closure") == true)
    }

    @Test
    fun visualReturnUsesTheInitialVisualOriginInsteadOfWorldZero() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 10f, 20f, 3f, 0.15f, 0.9f, "tracking"))
        var timestampNs = 1_200_000_000L
        repeat(14) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
        }
        engine.updateVisual(VisualPoseSample(timestampNs + 1_000_000_000L, 12f, 20f, 3f, 0.15f, 0.9f, "tracking"))
        engine.updateVisual(VisualPoseSample(timestampNs + 2_000_000_000L, 18f, 20f, 3f, 0.15f, 0.9f, "tracking"))
        val returned = engine.updateVisual(VisualPoseSample(timestampNs + 3_000_000_000L, 10f, 20f, 3f, 0.15f, 0.9f, "tracking"))
        assertEquals("loop-closed", returned?.motionEvent?.type)
    }

    @Test
    fun visualTrackingResetReanchorsWithoutPromotingTheResetFrame() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)

        val resetFrame = engine.updateVisual(
            VisualPoseSample(
                deviceTimestampNs = 1_100_000_000L,
                xM = 40f,
                yM = -12f,
                zM = 3f,
                accuracyM = 0.15f,
                confidence = 0.9f,
                trackingState = "tracking",
                trackingReset = true,
            ),
        )
        assertEquals(null, resetFrame)

        val nextPose = engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        assertTrue(nextPose?.pose?.sourceFlags?.contains("visual-reset") == true)
        assertTrue(kotlin.math.abs(nextPose?.pose?.xM ?: 1f) < 0.01f)
        assertTrue(kotlin.math.abs(nextPose?.pose?.yM ?: 1f) < 0.01f)
    }

    @Test
    fun visualRealignmentPreservesExistingVerticalRouteAnchor() {
        val engine = PoseFusionEngine()
        engine.seedFromPose(
            com.puzzlefuzzy.waymemory.sensing.PoseEstimateSample(
                deviceTimestampNs = 1_000_000_000L,
                xM = 4f,
                yM = 0f,
                zM = 7.5f,
                velocityXMps = 0f,
                velocityYMps = 0f,
                velocityZMps = 0f,
                accuracyM = 1f,
                confidence = 0.9f,
                source = "fused",
                sourceFlags = listOf("imu", "barometer"),
                motionMode = "stairs",
                stationary = false,
            ),
        )
        engine.updateVisual(VisualPoseSample(1_100_000_000L, 10f, 20f, 2f, 0.15f, 0.9f, "tracking"))

        var timestampNs = 1_200_000_000L
        repeat(14) {
            timestampNs += 100_000_000L
            engine.updateImu(timestampNs, floatArrayOf(1.0f, 0f, 0f), 0.05f)
        }
        val aligned = engine.updateVisual(VisualPoseSample(timestampNs + 100_000_000L, 11.5f, 20f, 2f, 0.15f, 0.9f, "tracking"))

        assertNotNull(aligned)
        assertTrue(aligned?.pose?.sourceFlags?.contains("visual-aligned") == true)
        assertTrue("visual realignment snapped the vertical route anchor", (aligned?.pose?.zM ?: 0f) > 5f)
    }

    @Test
    fun implausibleVisualJumpIsRejectedAndReanchored() {
        val engine = PoseFusionEngine()
        engine.updateImu(1_000_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        engine.updateVisual(VisualPoseSample(1_000_000_000L, 0f, 0f, 0f, 0.15f, 0.9f, "tracking"))
        val rejected = engine.updateVisual(VisualPoseSample(1_100_000_000L, 20f, 0f, 0f, 0.15f, 0.9f, "tracking"))

        assertEquals(null, rejected)
        val afterReset = engine.updateImu(1_200_000_000L, floatArrayOf(0f, 0f, 0f), 0f)
        assertTrue(afterReset?.pose?.sourceFlags?.contains("visual-reset") == true)
    }
}
