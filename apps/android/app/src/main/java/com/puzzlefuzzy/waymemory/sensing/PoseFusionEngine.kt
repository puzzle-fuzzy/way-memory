package com.puzzlefuzzy.waymemory.sensing

import java.util.UUID
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.atan2
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt
import kotlin.math.cos
import kotlin.math.sin

/**
 * Small, deterministic on-device fusion layer for the MVP.
 *
 * It deliberately exposes uncertainty and source flags. The output is a
 * fused pose, not a promise of absolute accuracy. ARCore can be added as
 * another correction source without changing the wire contract.
 */
class PoseFusionEngine {
    private val position = FloatArray(3)
    private val velocity = FloatArray(3)
    private val accelerationBias = FloatArray(3)

    private var originLat: Double? = null
    private var originLng: Double? = null
    private var originAltitudeM: Double? = null
    private var lastGnssAccuracyM = 25f
    private var lastGnssTimestampNs = 0L
    private var lastGnssTargetEastM = 0f
    private var lastGnssTargetNorthM = 0f
    private var lastGnssTargetAltitudeM = 0f
    private var lastMotionTimestampNs = 0L
    private var lastEmitTimestampNs = 0L
    private var lastPressureTimestampNs = 0L
    private var pressureReferenceHpa: Float? = null
    private var barometerAltitudeM = 0f
    private var barometerVerticalSpeedMps = 0f
    private var lastStepTimestampNs = 0L
    private var stepTrackX = 0f
    private var stepTrackY = 0f
    private var hasStepTrack = false
    private var stepCount = 0L
    private var hasBarometer = false
    private var hasGnss = false
    private var hasImu = false
    private var stationaryFrames = 0
    private var movingFrames = 0
    private var elevatorEvidenceFrames = 0
    private var stairsEvidenceFrames = 0
    private var lastMotionMode = "unknown"
    private var hasVisual = false
    private var visualOriginX = 0f
    private var visualOriginY = 0f
    private var lastVisualX = 0f
    private var lastVisualY = 0f
    private var lastVisualZ = 0f
    private var lastVisualTimestampNs = 0L
    private var lastVisualAccuracyM = 0.7f
    private var visualTravelledM = 0f
    private var visualYawRadians: Float? = null
    private var visualRouteOriginX = 0f
    private var visualRouteOriginY = 0f
    private var visualAlignmentPositionX = 0f
    private var visualAlignmentPositionY = 0f
    private var visualLoopClosureEmitted = false

    @Synchronized
    fun reset() {
        position.fill(0f)
        velocity.fill(0f)
        accelerationBias.fill(0f)
        originLat = null
        originLng = null
        originAltitudeM = null
        lastGnssAccuracyM = 25f
        lastGnssTimestampNs = 0L
        lastGnssTargetEastM = 0f
        lastGnssTargetNorthM = 0f
        lastGnssTargetAltitudeM = 0f
        lastMotionTimestampNs = 0L
        lastEmitTimestampNs = 0L
        lastPressureTimestampNs = 0L
        pressureReferenceHpa = null
        barometerAltitudeM = 0f
        barometerVerticalSpeedMps = 0f
        lastStepTimestampNs = 0L
        stepTrackX = 0f
        stepTrackY = 0f
        hasStepTrack = false
        stepCount = 0L
        hasBarometer = false
        hasGnss = false
        hasImu = false
        stationaryFrames = 0
        movingFrames = 0
        elevatorEvidenceFrames = 0
        stairsEvidenceFrames = 0
        lastMotionMode = "unknown"
        hasVisual = false
        visualOriginX = 0f
        visualOriginY = 0f
        lastVisualX = 0f
        lastVisualY = 0f
        lastVisualZ = 0f
        lastVisualTimestampNs = 0L
        lastVisualAccuracyM = 0.7f
        visualTravelledM = 0f
        visualYawRadians = null
        visualRouteOriginX = 0f
        visualRouteOriginY = 0f
        visualAlignmentPositionX = 0f
        visualAlignmentPositionY = 0f
        visualLoopClosureEmitted = false
    }

    @Synchronized
    fun updatePressure(pressureHpa: Float, timestampNs: Long) {
        if (!pressureHpa.isFinite() || pressureHpa !in 300f..1_100f) return
        if (timestampNs <= 0L || (lastPressureTimestampNs > 0L && timestampNs <= lastPressureTimestampNs)) return
        val reference = pressureReferenceHpa ?: pressureHpa.also { pressureReferenceHpa = it }
        val rawAltitude = (44_330.0 * (1.0 - (pressureHpa / reference).toDouble().pow(0.190294957))).toFloat()
        val previousAltitude = barometerAltitudeM
        barometerAltitudeM = if (!hasBarometer) rawAltitude else barometerAltitudeM * 0.86f + rawAltitude * 0.14f
        val elapsedNs = timestampNs - lastPressureTimestampNs
        if (lastPressureTimestampNs > 0L && elapsedNs in 50_000_000L..2_000_000_000L) {
            val elapsedSeconds = elapsedNs / 1_000_000_000f
            val speed = (barometerAltitudeM - previousAltitude) / elapsedSeconds
            barometerVerticalSpeedMps = barometerVerticalSpeedMps * 0.72f + speed.coerceIn(-5f, 5f) * 0.28f
        }
        lastPressureTimestampNs = timestampNs
        hasBarometer = true
    }

    @Synchronized
    fun updateGnss(
        latitude: Double,
        longitude: Double,
        accuracyM: Float?,
        altitudeM: Double?,
        timestampNs: Long,
    ): PoseUpdate? {
        if (!latitude.isFinite() || !longitude.isFinite()) return null
        if (timestampNs <= 0L || (lastGnssTimestampNs > 0L && timestampNs <= lastGnssTimestampNs)) return null
        if (originLat == null || originLng == null) {
            originLat = latitude
            originLng = longitude
            originAltitudeM = altitudeM
            position[0] = 0f
            position[1] = 0f
            position[2] = 0f
        }

        // A first GNSS fix may not contain altitude. If a later fix does, use
        // the current relative estimate as the bridge so the z-axis does not
        // jump back to an unrelated zero when the altitude reference appears.
        if (originAltitudeM == null && altitudeM != null) {
            val currentRelativeAltitude = if (hasBarometer) barometerAltitudeM else position[2]
            originAltitudeM = altitudeM - currentRelativeAltitude.toDouble()
        }

        val latitudeRadians = (originLat ?: latitude) * Math.PI / 180.0
        val targetEast = ((longitude - (originLng ?: longitude)) * Math.PI / 180.0 * 6_371_000.0 * kotlin.math.cos(latitudeRadians)).toFloat()
        val targetNorth = ((latitude - (originLat ?: latitude)) * Math.PI / 180.0 * 6_371_000.0).toFloat()
        val targetAltitude = when {
            altitudeM != null && originAltitudeM != null -> (altitudeM - (originAltitudeM ?: altitudeM)).toFloat()
            hasBarometer -> barometerAltitudeM
            else -> position[2]
        }
        val measuredAccuracy = (accuracyM ?: 25f).coerceIn(1f, 100f)
        val gain = when {
            measuredAccuracy <= 5f -> 0.55f
            measuredAccuracy <= 15f -> 0.32f
            else -> 0.15f
        }
        val previousPosition = position.copyOf()
        position[0] += (targetEast - position[0]) * gain
        position[1] += (targetNorth - position[1]) * gain
        position[2] += (targetAltitude - position[2]) * (gain * 0.7f)
        if (hasStepTrack) {
            stepTrackX += position[0] - previousPosition[0]
            stepTrackY += position[1] - previousPosition[1]
        }

        val elapsedGnssNs = timestampNs - lastGnssTimestampNs
        if (lastGnssTimestampNs > 0L && elapsedGnssNs in 100_000_000L..5_000_000_000L) {
            val elapsedSeconds = elapsedGnssNs / 1_000_000_000f
            val gnssVelocity = floatArrayOf(
                (targetEast - lastGnssTargetEastM) / elapsedSeconds,
                (targetNorth - lastGnssTargetNorthM) / elapsedSeconds,
                (targetAltitude - lastGnssTargetAltitudeM) / elapsedSeconds,
            )
            val recentImu = lastMotionTimestampNs > 0L
                && timestampNs >= lastMotionTimestampNs
                && timestampNs - lastMotionTimestampNs <= 500_000_000L
            val gain = if (recentImu) 0.18f else 0.55f
            for (index in 0..2) {
                val limit = if (index == 2) 5f else 15f
                velocity[index] = (velocity[index] * (1f - gain) + gnssVelocity[index] * gain).coerceIn(-limit, limit)
            }
        }
        lastGnssAccuracyM = measuredAccuracy
        hasGnss = true
        lastGnssTimestampNs = timestampNs
        lastGnssTargetEastM = targetEast
        lastGnssTargetNorthM = targetNorth
        lastGnssTargetAltitudeM = targetAltitude
        return buildUpdate(timestampNs, force = true)
    }

    /**
     * Correct the inertial track with ARCore's session-local metric pose.
     * ARCore has no guaranteed relationship to magnetic north, so estimate a
     * yaw alignment from the first meaningful visual/inertial displacement.
     * Until that alignment exists, no visual point is promoted to the unified
     * route; this avoids mixing two incompatible coordinate frames.
     */
    @Synchronized
    fun updateVisual(sample: VisualPoseSample): PoseUpdate? {
        if (!sample.xM.isFinite() || !sample.yM.isFinite() || !sample.zM.isFinite()) return null
        if (sample.deviceTimestampNs <= 0L || (lastVisualTimestampNs > 0L && sample.deviceTimestampNs <= lastVisualTimestampNs)) return null
        val previousVisualTimestampNs = lastVisualTimestampNs
        lastVisualTimestampNs = sample.deviceTimestampNs
        lastVisualAccuracyM = sample.accuracyM.takeIf { it.isFinite() }?.coerceIn(0.5f, 5f) ?: 1.5f
        if (!hasVisual) {
            hasVisual = true
            visualOriginX = sample.xM
            visualOriginY = sample.yM
            lastVisualX = sample.xM
            lastVisualY = sample.yM
            lastVisualZ = sample.zM
            visualAlignmentPositionX = position[0]
            visualAlignmentPositionY = position[1]
            return null
        }

        val deltaVisualX = sample.xM - lastVisualX
        val deltaVisualY = sample.yM - lastVisualY
        val deltaVisualDistance = hypot(deltaVisualX.toDouble(), deltaVisualY.toDouble()).toFloat()
        visualTravelledM += deltaVisualDistance
        lastVisualX = sample.xM
        lastVisualY = sample.yM
        lastVisualZ = sample.zM

        if (visualYawRadians == null) {
            val inertialDeltaX = position[0] - visualAlignmentPositionX
            val inertialDeltaY = position[1] - visualAlignmentPositionY
            val inertialDistance = hypot(inertialDeltaX.toDouble(), inertialDeltaY.toDouble()).toFloat()
            val visualDeltaFromOriginX = sample.xM - visualOriginX
            val visualDeltaFromOriginY = sample.yM - visualOriginY
            val visualDistanceFromOrigin = hypot(
                visualDeltaFromOriginX.toDouble(),
                visualDeltaFromOriginY.toDouble(),
            ).toFloat()
            // Use the cumulative displacement from the first visual frame.
            // A normal ARCore frame moves only a few centimetres, so a
            // single-frame threshold would never align during slow walking.
            if (visualDistanceFromOrigin > 1.2f && inertialDistance > 0.3f) {
                visualYawRadians = atan2(inertialDeltaY, inertialDeltaX) - atan2(visualDeltaFromOriginY, visualDeltaFromOriginX)
                val rotated = rotateVisual(visualOriginX, visualOriginY)
                visualRouteOriginX = position[0] - rotated.first
                visualRouteOriginY = position[1] - rotated.second
            }
        }

        visualYawRadians ?: return null
        val target = rotateVisual(sample.xM, sample.yM)
        val targetX = visualRouteOriginX + target.first
        val targetY = visualRouteOriginY + target.second
        val previousPosition = position.copyOf()
        position[0] += (targetX - position[0]) * 0.58f
        position[1] += (targetY - position[1]) * 0.58f
        position[2] += (sample.zM - position[2]) * 0.58f
        if (hasStepTrack) {
            stepTrackX += position[0] - previousPosition[0]
            stepTrackY += position[1] - previousPosition[1]
        }
        val visualElapsedNs = sample.deviceTimestampNs - previousVisualTimestampNs
        if (previousVisualTimestampNs > 0L && visualElapsedNs in 10_000_000L..1_000_000_000L) {
            val elapsedSeconds = visualElapsedNs / 1_000_000_000f
            val measuredVelocity = floatArrayOf(
                (targetX - previousPosition[0]) / elapsedSeconds,
                (targetY - previousPosition[1]) / elapsedSeconds,
                (sample.zM - previousPosition[2]) / elapsedSeconds,
            )
            for (index in 0..2) {
                val limit = if (index == 2) 5f else 15f
                velocity[index] = (velocity[index] * 0.42f + measuredVelocity[index] * 0.58f).coerceIn(-limit, limit)
            }
        }

        return buildUpdate(sample.deviceTimestampNs, force = true, visualAligned = true)
    }

    @Synchronized
    fun updateImu(timestampNs: Long, worldAcceleration: FloatArray, angularRateMagnitude: Float): PoseUpdate? {
        if (worldAcceleration.size < 3) return null
        if (timestampNs <= 0L || (lastMotionTimestampNs > 0L && timestampNs <= lastMotionTimestampNs)) return null
        hasImu = true
        if (lastMotionTimestampNs == 0L) {
            lastMotionTimestampNs = timestampNs
            return null
        }
        val elapsedNs = timestampNs - lastMotionTimestampNs
        lastMotionTimestampNs = timestampNs
        if (elapsedNs !in 5_000_000L..250_000_000L) return null
        val deltaSeconds = (elapsedNs / 1_000_000_000f).coerceIn(0.005f, 0.1f)
        val accelerationMagnitude = magnitude(worldAcceleration)
        val stationaryNow = accelerationMagnitude < 0.14f && angularRateMagnitude < 0.14f && abs(barometerVerticalSpeedMps) < 0.12f

        if (stationaryNow) {
            stationaryFrames += 1
            movingFrames = 0
            for (index in 0..2) {
                accelerationBias[index] = accelerationBias[index] * 0.98f + worldAcceleration[index] * 0.02f
                velocity[index] *= 0.25f
            }
            velocity.fill(0f)
        } else {
            stationaryFrames = 0
            movingFrames += 1
            for (index in 0..2) {
                val correctedAcceleration = (worldAcceleration[index] - accelerationBias[index]).let { value ->
                    if (abs(value) < 0.08f) 0f else value
                }
                velocity[index] = (velocity[index] + correctedAcceleration * deltaSeconds) * 0.992f
                velocity[index] = velocity[index].coerceIn(-15f, 15f)
                position[index] += velocity[index] * deltaSeconds
            }
        }

        if (hasBarometer) {
            position[2] = position[2] * 0.78f + barometerAltitudeM * 0.22f
        }

        val horizontalSpeed = hypot(velocity[0].toDouble(), velocity[1].toDouble()).toFloat()
        updateMotionEvidence(horizontalSpeed)
        return buildUpdate(timestampNs, force = false)
    }

    /**
     * Step-aided pedestrian dead reckoning. The step track is kept separate
     * from the inertial position and blended toward it, so a step event does
     * not double-count an acceleration pulse that was already integrated.
     * Heading is measured clockwise from north; local ENU therefore uses
     * sin(heading) for east and cos(heading) for north.
     */
    @Synchronized
    fun updateStep(timestampNs: Long, headingRadians: Float, steps: Int = 1): PoseUpdate? {
        if (
            timestampNs <= 0L
            || !headingRadians.isFinite()
            || steps <= 0
            || (lastStepTimestampNs > 0L && timestampNs <= lastStepTimestampNs)
        ) return null

        if (!hasStepTrack) {
            stepTrackX = position[0]
            stepTrackY = position[1]
            hasStepTrack = true
        }

        val stepCountDelta = steps.coerceAtMost(MAX_STEPS_PER_EVENT)
        val distanceM = STEP_LENGTH_M * stepCountDelta
        val previousStepX = stepTrackX
        val previousStepY = stepTrackY
        stepTrackX += sin(headingRadians) * distanceM
        stepTrackY += cos(headingRadians) * distanceM
        val fusionGain = when {
            isFresh(timestampNs, lastGnssTimestampNs, GNSS_FRESHNESS_NS) -> 0.25f
            isFresh(timestampNs, lastVisualTimestampNs, VISUAL_FRESHNESS_NS) -> 0.25f
            else -> 0.55f
        }
        position[0] += (stepTrackX - position[0]) * fusionGain
        position[1] += (stepTrackY - position[1]) * fusionGain

        val elapsedNs = timestampNs - lastStepTimestampNs
        if (lastStepTimestampNs > 0L && elapsedNs in 250_000_000L..3_000_000_000L) {
            val elapsedSeconds = elapsedNs / 1_000_000_000f
            val measuredEastMps = (stepTrackX - previousStepX) / elapsedSeconds
            val measuredNorthMps = (stepTrackY - previousStepY) / elapsedSeconds
            velocity[0] = velocity[0] * 0.45f + measuredEastMps * 0.55f
            velocity[1] = velocity[1] * 0.45f + measuredNorthMps * 0.55f
        }
        stationaryFrames = 0
        movingFrames = min(40, movingFrames + stepCountDelta)
        stepCount += stepCountDelta.toLong()
        lastStepTimestampNs = timestampNs
        updateMotionEvidence(hypot(velocity[0].toDouble(), velocity[1].toDouble()).toFloat())
        return buildUpdate(timestampNs, force = true)
    }

    private fun updateMotionEvidence(horizontalSpeed: Float) {
        val elevatorEvidence = abs(barometerVerticalSpeedMps) > 0.25f && horizontalSpeed < 0.9f && movingFrames > 3
        // Exit evidence must decay faster than it accumulates. Otherwise a
        // short low-horizontal-speed phase at the bottom of a staircase can
        // keep the route classified as an elevator for several seconds.
        if (elevatorEvidence) elevatorEvidenceFrames = min(40, elevatorEvidenceFrames + 1) else elevatorEvidenceFrames = maxOf(0, elevatorEvidenceFrames - 3)
        val stairsEvidence = abs(barometerVerticalSpeedMps) > 0.12f && horizontalSpeed >= 0.3f && movingFrames > 3 && !elevatorEvidence
        if (stairsEvidence) stairsEvidenceFrames = min(40, stairsEvidenceFrames + 1) else stairsEvidenceFrames = maxOf(0, stairsEvidenceFrames - 2)
    }

    private fun buildUpdate(timestampNs: Long, force: Boolean, visualAligned: Boolean = false): PoseUpdate? {
        if (!force && timestampNs - lastEmitTimestampNs < 100_000_000L) return null
        lastEmitTimestampNs = timestampNs
        val horizontalSpeed = hypot(velocity[0].toDouble(), velocity[1].toDouble()).toFloat()
        val stationaryNow = stationaryFrames >= 3
        val motionMode = when {
            elevatorEvidenceFrames >= 5 -> "elevator"
            stairsEvidenceFrames >= 5 -> "stairs"
            stationaryNow -> "stationary"
            horizontalSpeed >= 0.12f || movingFrames >= 3 -> "walking"
            else -> "unknown"
        }
        val visualLoopClosure = visualAligned
            && !visualLoopClosureEmitted
            && visualTravelledM >= 8f
            && hypot(
                (lastVisualX - visualOriginX).toDouble(),
                (lastVisualY - visualOriginY).toDouble(),
            ) <= 1.5
        if (visualLoopClosure) visualLoopClosureEmitted = true
        val event = when {
            visualLoopClosure -> MotionEventSample(
                eventId = UUID.randomUUID().toString(),
                deviceTimestampNs = timestampNs,
                type = "loop-closed",
                confidence = 0.72f,
                details = mapOf("visualTravelledM" to visualTravelledM),
            )
            motionMode != lastMotionMode && motionMode == "elevator" -> MotionEventSample(
                eventId = UUID.randomUUID().toString(),
                deviceTimestampNs = timestampNs,
                type = "elevator-candidate",
                confidence = (0.55f + elevatorEvidenceFrames / 40f).coerceAtMost(0.92f),
                details = mapOf("barometerVerticalSpeedMps" to barometerVerticalSpeedMps),
            )
            motionMode != lastMotionMode && motionMode == "stairs" -> MotionEventSample(
                eventId = UUID.randomUUID().toString(),
                deviceTimestampNs = timestampNs,
                type = "stairs-enter",
                confidence = (0.52f + stairsEvidenceFrames / 40f).coerceAtMost(0.88f),
                details = mapOf(
                    "barometerVerticalSpeedMps" to barometerVerticalSpeedMps,
                    "horizontalSpeedMps" to horizontalSpeed,
                ),
            )
            lastMotionMode == "elevator" && motionMode != "elevator" -> MotionEventSample(
                eventId = UUID.randomUUID().toString(),
                deviceTimestampNs = timestampNs,
                type = "elevator-exit",
                confidence = 0.72f,
            )
            lastMotionMode == "stairs" && motionMode != "stairs" -> MotionEventSample(
                eventId = UUID.randomUUID().toString(),
                deviceTimestampNs = timestampNs,
                type = "stairs-exit",
                confidence = 0.7f,
            )
            motionMode != lastMotionMode && motionMode == "stationary" -> MotionEventSample(
                eventId = UUID.randomUUID().toString(),
                deviceTimestampNs = timestampNs,
                type = "stationary-enter",
                confidence = 0.84f,
            )
            lastMotionMode == "stationary" && motionMode != "stationary" -> MotionEventSample(
                eventId = UUID.randomUUID().toString(),
                deviceTimestampNs = timestampNs,
                type = "stationary-exit",
                confidence = 0.78f,
            )
            else -> null
        }
        lastMotionMode = motionMode

        val positionMagnitude = magnitude(position)
        val gnssFresh = isFresh(timestampNs, lastGnssTimestampNs, GNSS_FRESHNESS_NS)
        val pressureFresh = isFresh(timestampNs, lastPressureTimestampNs, PRESSURE_FRESHNESS_NS)
        val visualFresh = isFresh(timestampNs, lastVisualTimestampNs, VISUAL_FRESHNESS_NS)
        val stepFresh = isFresh(timestampNs, lastStepTimestampNs, STEP_FRESHNESS_NS)
        val gnssAgeSeconds = ageSeconds(timestampNs, lastGnssTimestampNs)
        val baseAccuracy = when {
            visualAligned -> lastVisualAccuracyM
            gnssFresh -> lastGnssAccuracyM
            hasGnss -> (lastGnssAccuracyM + gnssAgeSeconds * 0.8f).coerceAtMost(35f)
            else -> 2.5f
        }
        val driftPenalty = when {
            visualAligned -> 0.01f
            gnssFresh -> 0.02f
            else -> 0.12f
        }
        val accuracy = (baseAccuracy + positionMagnitude * driftPenalty + if (pressureFresh) 0.3f else 1.2f).coerceAtMost(50f)
        val sourceFlags = buildList {
            if (hasImu) add("imu")
            if (gnssFresh) add("gnss") else if (hasGnss) add("gnss-stale")
            if (pressureFresh) add("barometer") else if (hasBarometer) add("barometer-stale")
            if (visualFresh) add("visual") else if (hasVisual) add("visual-stale")
            if (stepFresh) add("step-pdr") else if (hasStepTrack) add("step-pdr-stale")
            if (visualAligned) add("visual-aligned")
            if (visualLoopClosure) add("loop-closure")
            if (isEmpty()) add("unknown")
        }
        val confidence = (1f - accuracy / 50f).coerceIn(0.05f, 0.98f)
        return PoseUpdate(
            pose = PoseEstimateSample(
                deviceTimestampNs = timestampNs,
                xM = position[0],
                yM = position[1],
                zM = position[2],
                velocityXMps = velocity[0],
                velocityYMps = velocity[1],
                velocityZMps = velocity[2],
                accuracyM = accuracy,
                verticalAccuracyM = if (pressureFresh) 1.5f else null,
                confidence = confidence,
                source = "fused",
                frame = "local-enu",
                sourceFlags = sourceFlags,
                motionMode = motionMode,
                stationary = stationaryNow,
            ),
            motionEvent = event,
        )
    }

    private fun rotateVisual(x: Float, y: Float): Pair<Float, Float> {
        val yaw = visualYawRadians ?: 0f
        val east = x * cos(yaw) - y * sin(yaw)
        val north = x * sin(yaw) + y * cos(yaw)
        return east to north
    }

    private fun magnitude(values: FloatArray): Float =
        sqrt(values[0] * values[0] + values[1] * values[1] + values[2] * values[2])

    private fun isFresh(nowTimestampNs: Long, previousTimestampNs: Long, maxAgeNs: Long): Boolean =
        previousTimestampNs > 0L
            && nowTimestampNs >= previousTimestampNs
            && nowTimestampNs - previousTimestampNs <= maxAgeNs

    private fun ageSeconds(nowTimestampNs: Long, previousTimestampNs: Long): Float =
        if (previousTimestampNs <= 0L || nowTimestampNs < previousTimestampNs) 30f
        else ((nowTimestampNs - previousTimestampNs) / 1_000_000_000f).coerceAtMost(30f)

    companion object {
        private const val GNSS_FRESHNESS_NS = 5_000_000_000L
        private const val PRESSURE_FRESHNESS_NS = 3_000_000_000L
        private const val VISUAL_FRESHNESS_NS = 750_000_000L
        private const val STEP_FRESHNESS_NS = 3_000_000_000L
        private const val STEP_LENGTH_M = 0.65f
        private const val MAX_STEPS_PER_EVENT = 8
    }
}

data class PoseUpdate(
    val pose: PoseEstimateSample,
    val motionEvent: MotionEventSample?,
)
