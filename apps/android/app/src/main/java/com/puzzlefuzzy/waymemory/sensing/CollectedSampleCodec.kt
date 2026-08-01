package com.puzzlefuzzy.waymemory.sensing

import org.json.JSONArray
import org.json.JSONObject

/**
 * The on-device queue uses the same JSON shape as the WebSocket payload.
 * Keeping this codec separate makes recovery deterministic and avoids a second
 * persistence model that could silently omit pose or event fields.
 */
internal interface SampleCodec {
    fun encode(sample: CollectedSample): String
    fun decode(encoded: String): CollectedSample?
}

internal object CollectedSampleCodec : SampleCodec {
    override fun encode(sample: CollectedSample): String = sample.toJsonObject().toString()

    override fun decode(encoded: String): CollectedSample? = runCatching {
        JSONObject(encoded).toCollectedSample()
    }.getOrNull()

    private fun CollectedSample.toJsonObject(): JSONObject = JSONObject().apply {
        put("sampleId", sampleId)
        put("deviceTimestampNs", deviceTimestampNs)
        put("sensorType", sensorType)
        put("values", JSONArray(values))
        if (metadata.isNotEmpty()) {
            put("metadata", JSONObject().apply {
                metadata.forEach { (key, value) ->
                    if (value is Number || value is String || value is Boolean) put(key, value)
                }
            })
        }
        sensorAccuracy?.let { put("sensorAccuracy", it) }
        accuracy?.let { put("accuracy", it) }
        location?.let {
            put("location", JSONObject().apply {
                put("lat", it.lat)
                put("lng", it.lng)
                it.accuracyM?.let { value -> put("accuracyM", value) }
                it.altitudeM?.let { value -> put("altitudeM", value) }
            })
        }
        relativePosition?.let {
            put("relativePosition", JSONObject().apply {
                put("xM", it.xM)
                put("yM", it.yM)
                put("zM", it.zM)
                put("accuracyM", it.accuracyM)
            })
        }
        pose?.let {
            put("pose", JSONObject().apply {
                put("deviceTimestampNs", it.deviceTimestampNs)
                put("xM", it.xM)
                put("yM", it.yM)
                put("zM", it.zM)
                put("velocityXMps", it.velocityXMps)
                put("velocityYMps", it.velocityYMps)
                put("velocityZMps", it.velocityZMps)
                put("accuracyM", it.accuracyM)
                it.verticalAccuracyM?.let { value -> put("verticalAccuracyM", value) }
                put("confidence", it.confidence)
                put("source", it.source)
                put("frame", it.frame)
                put("sourceFlags", JSONArray(it.sourceFlags))
                put("motionMode", it.motionMode)
                put("stationary", it.stationary)
            })
        }
        motionEvent?.let {
            put("motionEvent", JSONObject().apply {
                put("eventId", it.eventId)
                put("deviceTimestampNs", it.deviceTimestampNs)
                put("type", it.type)
                put("confidence", it.confidence)
                if (it.details.isNotEmpty()) {
                    put("details", JSONObject().apply {
                        it.details.forEach { (key, value) -> value?.let { item -> put(key, item) } }
                    })
                }
            })
        }
    }

    private fun JSONObject.toCollectedSample(): CollectedSample = CollectedSample(
        sampleId = optString("sampleId").takeIf { it.isNotBlank() } ?: java.util.UUID.randomUUID().toString(),
        deviceTimestampNs = getLong("deviceTimestampNs"),
        sensorType = getString("sensorType"),
        values = optJSONArray("values").toFloatList(),
        metadata = optJSONObject("metadata")?.toAnyMap() ?: emptyMap(),
        sensorAccuracy = optIntOrNull("sensorAccuracy"),
        accuracy = optFloatOrNull("accuracy"),
        location = optJSONObject("location")?.let {
            LocationSample(
                lat = it.getDouble("lat"),
                lng = it.getDouble("lng"),
                accuracyM = it.optFloatOrNull("accuracyM"),
                altitudeM = it.optDoubleOrNull("altitudeM"),
            )
        },
        relativePosition = optJSONObject("relativePosition")?.let {
            RelativePositionSample(
                xM = it.getDouble("xM").toFloat(),
                yM = it.getDouble("yM").toFloat(),
                zM = it.getDouble("zM").toFloat(),
                accuracyM = it.getDouble("accuracyM").toFloat(),
            )
        },
        pose = optJSONObject("pose")?.let {
            PoseEstimateSample(
                deviceTimestampNs = it.getLong("deviceTimestampNs"),
                xM = it.getDouble("xM").toFloat(),
                yM = it.getDouble("yM").toFloat(),
                zM = it.getDouble("zM").toFloat(),
                velocityXMps = it.getDouble("velocityXMps").toFloat(),
                velocityYMps = it.getDouble("velocityYMps").toFloat(),
                velocityZMps = it.getDouble("velocityZMps").toFloat(),
                accuracyM = it.getDouble("accuracyM").toFloat(),
                verticalAccuracyM = it.optFloatOrNull("verticalAccuracyM"),
                confidence = it.getDouble("confidence").toFloat(),
                source = it.getString("source"),
                frame = it.optString("frame", "local-enu"),
                sourceFlags = it.optJSONArray("sourceFlags").toStringList(),
                motionMode = it.optString("motionMode", "unknown"),
                stationary = it.optBoolean("stationary", false),
            )
        },
        motionEvent = optJSONObject("motionEvent")?.let {
            MotionEventSample(
                eventId = it.getString("eventId"),
                deviceTimestampNs = it.getLong("deviceTimestampNs"),
                type = it.getString("type"),
                confidence = it.getDouble("confidence").toFloat(),
                details = it.optJSONObject("details")?.toAnyMap() ?: emptyMap(),
            )
        },
    )

    private fun JSONArray?.toFloatList(): List<Float> = if (this == null) {
        emptyList()
    } else {
        List(length()) { index -> getDouble(index).toFloat() }
    }

    private fun JSONArray?.toStringList(): List<String> = if (this == null) {
        emptyList()
    } else {
        List(length()) { index -> getString(index) }
    }

    private fun JSONObject.toAnyMap(): Map<String, Any?> = keys().asSequence().associateWith { key ->
        opt(key).takeUnless { it === JSONObject.NULL }
    }

    private fun JSONObject.optIntOrNull(key: String): Int? = if (has(key) && !isNull(key)) optInt(key) else null

    private fun JSONObject.optFloatOrNull(key: String): Float? = if (has(key) && !isNull(key)) optDouble(key).toFloat() else null

    private fun JSONObject.optDoubleOrNull(key: String): Double? = if (has(key) && !isNull(key)) optDouble(key) else null
}
