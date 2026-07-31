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
    private var lastMotionTimestampNs = 0L
    private var lastEmitTimestampNs = 0L
    private var lastPressureTimestampNs = 0L
    private var pressureReferenceHpa: Float? = null
    private var barometerAltitudeM = 0f
    private var barometerVerticalSpeedMps = 0f
    private var hasBarometer = false
    private var hasGnss = false
    private var stationaryFrames = 0
    private var movingFrames = 0
    private var elevatorEvidenceFrames = 0
    private var stairsEvidenceFrames = 0
    private var lastMotionMode = "unknown"
    private var hasVisual = false
    private var lastVisualX = 0f
    private var lastVisualY = 0f
    private var lastVisualZ = 0f
    private var visualTravelledM = 0f
    private var visualYawRadians: Float? = null
    private var visualRouteOriginX = 0f
    private var visualRouteOriginY = 0f
    private var visualAlignmentPositionX = 0f
    private var visualAlignmentPositionY = 0f
    private var visualLoopClosureEmitted = false

    fun reset() {
        position.fill(0f)
        velocity.fill(0f)
        accelerationBias.fill(0f)
        originLat = null
        originLng = null
        originAltitudeM = null
        lastGnssAccuracyM = 25f
        lastMotionTimestampNs = 0L
        lastEmitTimestampNs = 0L
        lastPressureTimestampNs = 0L
        pressureReferenceHpa = null
        barometerAltitudeM = 0f
        barometerVerticalSpeedMps = 0f
        hasBarometer = false
        hasGnss = false
        stationaryFrames = 0
        movingFrames = 0
        elevatorEvidenceFrames = 0
        stairsEvidenceFrames = 0
        lastMotionMode = "unknown"
        hasVisual = false
        lastVisualX = 0f
        lastVisualY = 0f
        lastVisualZ = 0f
        visualTravelledM = 0f
        visualYawRadians = null
        visualRouteOriginX = 0f
        visualRouteOriginY = 0f
        visualAlignmentPositionX = 0f
        visualAlignmentPositionY = 0f
        visualLoopClosureEmitted = false
    }

    fun updatePressure(pressureHpa: Float, timestampNs: Long) {
        if (!pressureHpa.isFinite() || pressureHpa !in 300f..1_100f) return
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

    fun updateGnss(
        latitude: Double,
        longitude: Double,
        accuracyM: Float?,
        altitudeM: Double?,
        timestampNs: Long,
    ): PoseUpdate? {
        if (!latitude.isFinite() || !longitude.isFinite()) return null
        if (originLat == null || originLng == null) {
            originLat = latitude
            originLng = longitude
            originAltitudeM = altitudeM
            position[0] = 0f
            position[1] = 0f
            position[2] = 0f
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
        val elapsedNs = timestampNs - lastMotionTimestampNs
        if (lastMotionTimestampNs > 0L && elapsedNs in 100_000_000L..5_000_000_000L) {
            val elapsedSeconds = elapsedNs / 1_000_000_000f
            velocity[0] = ((position[0] - previousPosition[0]) / elapsedSeconds).coerceIn(-15f, 15f)
            velocity[1] = ((position[1] - previousPosition[1]) / elapsedSeconds).coerceIn(-15f, 15f)
            velocity[2] = ((position[2] - previousPosition[2]) / elapsedSeconds).coerceIn(-5f, 5f)
        }
        lastGnssAccuracyM = measuredAccuracy
        hasGnss = true
        return buildUpdate(timestampNs, force = true)
    }

    /**
     * Correct the inertial track with ARCore's session-local metric pose.
     * ARCore has no guaranteed relationship to magnetic north, so estimate a
     * yaw alignment from the first meaningful visual/inertial displacement.
     * Until that alignment exists, no visual point is promoted to the unified
     * route; this avoids mixing two incompatible coordinate frames.
     */
    fun updateVisual(sample: VisualPoseSample): PoseUpdate? {
        if (!sample.xM.isFinite() || !sample.yM.isFinite() || !sample.zM.isFinite()) return null
        if (!hasVisual) {
            hasVisual = true
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
            if (deltaVisualDistance > 1.2f && inertialDistance > 0.3f) {
                visualYawRadians = atan2(inertialDeltaY, inertialDeltaX) - atan2(deltaVisualY, deltaVisualX)
                val rotated = rotateVisual(sample.xM, sample.yM)
                visualRouteOriginX = position[0] - rotated.first
                visualRouteOriginY = position[1] - rotated.second
            }
        }

        visualYawRadians ?: return null
        val target = rotateVisual(sample.xM, sample.yM)
        val targetX = visualRouteOriginX + target.first
        val targetY = visualRouteOriginY + target.second
        position[0] += (targetX - position[0]) * 0.58f
        position[1] += (targetY - position[1]) * 0.58f
        position[2] += (sample.zM - position[2]) * 0.58f
        velocity[0] = velocity[0] * 0.42f + (targetX - position[0]) * 0.58f
        velocity[1] = velocity[1] * 0.42f + (targetY - position[1]) * 0.58f

        return buildUpdate(sample.deviceTimestampNs, force = true, visualAligned = true)
    }

    fun updateImu(timestampNs: Long, worldAcceleration: FloatArray, angularRateMagnitude: Float): PoseUpdate? {
        if (worldAcceleration.size < 3) return null
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
        val elevatorEvidence = abs(barometerVerticalSpeedMps) > 0.25f && horizontalSpeed < 0.9f && movingFrames > 3
        if (elevatorEvidence) elevatorEvidenceFrames = min(40, elevatorEvidenceFrames + 1) else elevatorEvidenceFrames = maxOf(0, elevatorEvidenceFrames - 1)
        val stairsEvidence = abs(barometerVerticalSpeedMps) > 0.12f && horizontalSpeed >= 0.3f && movingFrames > 3 && !elevatorEvidence
        if (stairsEvidence) stairsEvidenceFrames = min(40, stairsEvidenceFrames + 1) else stairsEvidenceFrames = maxOf(0, stairsEvidenceFrames - 1)
        return buildUpdate(timestampNs, force = false)
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
            && hypot(lastVisualX.toDouble(), lastVisualY.toDouble()) <= 1.5
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
        val baseAccuracy = if (visualAligned) 0.7f else if (hasGnss) lastGnssAccuracyM else 1.5f
        val driftPenalty = if (visualAligned) 0.01f else if (hasGnss) 0.02f else 0.08f
        val accuracy = (baseAccuracy + positionMagnitude * driftPenalty + if (hasBarometer) 0.3f else 1.2f).coerceAtMost(50f)
        val sourceFlags = buildList {
            add("imu")
            if (hasGnss) add("gnss")
            if (hasBarometer) add("barometer")
            if (hasVisual) add("visual")
            if (visualAligned) add("visual-aligned")
            if (visualLoopClosure) add("loop-closure")
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
                verticalAccuracyM = if (hasBarometer) 1.5f else null,
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
}

data class PoseUpdate(
    val pose: PoseEstimateSample,
    val motionEvent: MotionEventSample?,
)
