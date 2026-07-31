package com.puzzlefuzzy.waymemory.sensing

import android.util.Log
import com.puzzlefuzzy.waymemory.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.TimeUnit

data class CollectedSample(
    val deviceTimestampNs: Long,
    val sensorType: String,
    val values: List<Float> = emptyList(),
    val sensorAccuracy: Int? = null,
    val accuracy: Float? = null,
    val location: LocationSample? = null,
    val relativePosition: RelativePositionSample? = null,
    val pose: PoseEstimateSample? = null,
    val motionEvent: MotionEventSample? = null,
)

data class LocationSample(
    val lat: Double,
    val lng: Double,
    val accuracyM: Float? = null,
    val altitudeM: Double? = null,
)

data class RelativePositionSample(
    val xM: Float,
    val yM: Float,
    val zM: Float,
    val accuracyM: Float,
)

data class PoseEstimateSample(
    val deviceTimestampNs: Long,
    val xM: Float,
    val yM: Float,
    val zM: Float,
    val velocityXMps: Float,
    val velocityYMps: Float,
    val velocityZMps: Float,
    val accuracyM: Float,
    val verticalAccuracyM: Float? = null,
    val confidence: Float,
    val source: String,
    val frame: String = "local-enu",
    val sourceFlags: List<String>,
    val motionMode: String,
    val stationary: Boolean,
)

data class MotionEventSample(
    val eventId: String,
    val deviceTimestampNs: Long,
    val type: String,
    val confidence: Float,
    val details: Map<String, Any?> = emptyMap(),
)

data class SessionSyncState(
    val connected: Boolean = false,
    val sessionId: String? = null,
    val uploadedSamples: Long = 0,
    val pendingSamples: Int = 0,
    val droppedSamples: Long = 0,
    val lastError: String? = null,
)

class SessionUploader(
    private val baseUrl: String = BuildConfig.API_BASE_URL,
) : WebSocketListener() {
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = ConcurrentLinkedDeque<CollectedSample>()
    private val state = MutableStateFlow(SessionSyncState())
    private var socket: WebSocket? = null
    private var connectionJob: Job? = null
    private var deviceId: String = "android-device"
    private var activeSessionId: String? = null
    private var running = false
    private var nextConnectAtMs = 0L
    private var reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    private var lastQueueUiPublishMs = 0L

    val syncState: StateFlow<SessionSyncState> = state.asStateFlow()

    fun start(deviceId: String) {
        if (running) return
        this.deviceId = deviceId
        activeSessionId = null
        running = true
        nextConnectAtMs = 0L
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
        lastQueueUiPublishMs = 0L
        state.value = SessionSyncState(lastError = null)
        connectionJob = scope.launch {
            while (isActive && running) {
                if (socket == null && System.currentTimeMillis() >= nextConnectAtMs) connect()
                flush()
                delay(FLUSH_INTERVAL_MS)
            }
        }
    }

    fun enqueue(sample: CollectedSample) {
        if (!running) return
        queue.addLast(sample)
        var dropped = 0L
        while (queue.size > MAX_PENDING_SAMPLES) {
            if (queue.pollFirst() == null) break
            dropped += 1
        }
        val nowMs = System.currentTimeMillis()
        if (dropped > 0 || nowMs - lastQueueUiPublishMs >= QUEUE_UI_INTERVAL_MS) {
            lastQueueUiPublishMs = nowMs
            state.value = state.value.copy(
                pendingSamples = queue.size,
                droppedSamples = state.value.droppedSamples + dropped,
                lastError = if (dropped > 0) "网络不可用，已丢弃最旧的 $dropped 条原始样本" else state.value.lastError,
            )
        }
    }

    fun stop() {
        running = false
        connectionJob?.cancel()
        repeat(10) {
            if (queue.isEmpty()) return@repeat
            flush()
        }
        activeSessionId?.let { sessionId ->
            socket?.send(JSONObject().put("type", "session.stop").put("sessionId", sessionId).toString())
        }
        val unsent = queue.size
        queue.clear()
        connectionJob = null
        socket?.close(1000, "session stopped")
        socket = null
        activeSessionId = null
        state.value = state.value.copy(
            connected = false,
            sessionId = null,
            pendingSamples = 0,
            droppedSamples = state.value.droppedSamples + unsent,
            lastError = if (unsent > 0) "停止采集时仍有 $unsent 条样本未上传" else state.value.lastError,
        )
    }

    private fun connect() {
        if (!running || socket != null) return
        val websocketUrl = baseUrl
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://") + "/realtime?role=device&deviceId=$deviceId"
        socket = client.newWebSocket(Request.Builder().url(websocketUrl).build(), this)
        nextConnectAtMs = System.currentTimeMillis() + reconnectDelayMs
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        if (!running) {
            webSocket.close(1000, "session stopped")
            return
        }
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
        nextConnectAtMs = 0L
        state.value = state.value.copy(connected = true, lastError = null)
        val message = if (activeSessionId == null) {
            JSONObject()
                .put("type", "session.start")
                .put("deviceId", deviceId)
                .put("mode", "learning")
        } else {
            JSONObject()
                .put("type", "session.resume")
                .put("sessionId", activeSessionId)
                .put("deviceId", deviceId)
        }
        webSocket.send(message.toString())
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        runCatching {
            val message = JSONObject(text)
            when (message.optString("type")) {
                "session.started", "session.resumed" -> {
                    activeSessionId = message.getJSONObject("session").getString("sessionId")
                    state.value = state.value.copy(sessionId = activeSessionId, lastError = null)
                }
                "samples.accepted" -> state.value = state.value.copy(uploadedSamples = message.optLong("sampleCount", state.value.uploadedSamples))
                "error" -> {
                    val error = message.optString("error")
                    if (error == "session_resume_failed" && activeSessionId != null && running) {
                        activeSessionId = null
                        state.value = state.value.copy(sessionId = null, lastError = "会话已过期，正在建立新会话")
                        webSocket.send(
                            JSONObject()
                                .put("type", "session.start")
                                .put("deviceId", deviceId)
                                .put("mode", "learning")
                                .toString(),
                        )
                    } else {
                        state.value = state.value.copy(lastError = error)
                    }
                }
            }
        }.onFailure { error ->
            Log.w(TAG, "Invalid realtime message", error)
        }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (socket === webSocket) socket = null
        scheduleReconnect(t.message ?: "WebSocket 连接失败")
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        if (socket === webSocket) socket = null
        scheduleReconnect(if (reason.isBlank()) "WebSocket 已断开" else reason)
    }

    private fun scheduleReconnect(error: String) {
        if (!running) return
        nextConnectAtMs = System.currentTimeMillis() + reconnectDelayMs
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(MAX_RECONNECT_DELAY_MS)
        state.value = state.value.copy(connected = false, lastError = error)
    }

    private fun flush() {
        val sessionId = activeSessionId ?: return
        val currentSocket = socket ?: return
        if (queue.isEmpty()) return

        val batch = ArrayList<CollectedSample>(MAX_BATCH)
        repeat(MAX_BATCH) { queue.pollFirst()?.let(batch::add) }
        if (batch.isEmpty()) return

        val payload = JSONObject()
            .put("type", "samples")
            .put("sessionId", sessionId)
            .put("samples", JSONArray().apply { batch.forEach { put(it.toJson()) } })
        if (!currentSocket.send(payload.toString())) {
            batch.asReversed().forEach(queue::addFirst)
        } else {
            state.value = state.value.copy(
                uploadedSamples = state.value.uploadedSamples + batch.size,
                pendingSamples = queue.size,
            )
        }
    }

    private fun CollectedSample.toJson(): JSONObject = JSONObject().apply {
        put("deviceTimestampNs", deviceTimestampNs)
        put("sensorType", sensorType)
        put("values", JSONArray(values))
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

    companion object {
        private const val TAG = "WayMemorySync"
        private const val MAX_BATCH = 100
        private const val MAX_PENDING_SAMPLES = 4_096
        private const val FLUSH_INTERVAL_MS = 80L
        private const val QUEUE_UI_INTERVAL_MS = 250L
        private const val INITIAL_RECONNECT_DELAY_MS = 250L
        private const val MAX_RECONNECT_DELAY_MS = 10_000L
    }
}
