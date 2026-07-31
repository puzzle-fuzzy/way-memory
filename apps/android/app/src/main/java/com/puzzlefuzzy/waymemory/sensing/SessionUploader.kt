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
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.UUID

data class CollectedSample(
    val sampleId: String = UUID.randomUUID().toString(),
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

data class SensorInventorySample(
    val sensorType: String,
    val name: String,
    val vendor: String? = null,
    val version: Int? = null,
    val powerMa: Float? = null,
    val minDelayUs: Int? = null,
    val maxDelayUs: Int? = null,
    val reportingMode: Int? = null,
    val registered: Boolean,
)

class SessionUploader(
    private val baseUrl: String = BuildConfig.API_BASE_URL,
    storageDirectory: File,
) : WebSocketListener() {
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = PersistentSampleQueue(storageDirectory)
    private val sessionIdFile = File(storageDirectory, "active-session.id")
    private val state = MutableStateFlow(SessionSyncState(pendingSamples = queue.size()))
    private var socket: WebSocket? = null
    private var connectionJob: Job? = null
    private var deviceId: String = "android-device"
    private var sensorInventory: List<SensorInventorySample> = emptyList()
    private var activeSessionId: String? = null
    private var running = false
    private var nextConnectAtMs = 0L
    private var reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    private var lastQueueUiPublishMs = 0L

    val syncState: StateFlow<SessionSyncState> = state.asStateFlow()

    fun start(deviceId: String, sensorInventory: List<SensorInventorySample> = emptyList()) {
        if (running) return
        this.deviceId = deviceId
        this.sensorInventory = sensorInventory.take(MAX_SENSOR_INVENTORY)
        activeSessionId = runCatching {
            sessionIdFile.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.isNotBlank() }
        }.getOrNull()
        running = true
        nextConnectAtMs = 0L
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
        lastQueueUiPublishMs = 0L
        state.value = SessionSyncState(
            pendingSamples = queue.size(),
            lastError = null,
            sessionId = activeSessionId,
        )
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
        val dropped = queue.add(sample).toLong()
        val nowMs = System.currentTimeMillis()
        if (dropped > 0 || nowMs - lastQueueUiPublishMs >= QUEUE_UI_INTERVAL_MS) {
            lastQueueUiPublishMs = nowMs
            state.value = state.value.copy(
                pendingSamples = queue.size(),
                droppedSamples = state.value.droppedSamples + dropped,
                lastError = if (dropped > 0) "待上传队列已满，已淘汰最旧的 $dropped 条样本" else state.value.lastError,
            )
        }
    }

    fun stop() {
        running = false
        connectionJob?.cancel()
        repeat(10) {
            if (queue.size() == 0) return@repeat
            flush()
        }
        activeSessionId?.let { sessionId ->
            socket?.send(JSONObject().put("type", "session.stop").put("sessionId", sessionId).toString())
        }
        connectionJob = null
        socket?.close(1000, "session stopped")
        socket = null
        sessionIdFile.delete()
        activeSessionId = null
        state.value = state.value.copy(
            connected = false,
            sessionId = null,
            pendingSamples = queue.size(),
            lastError = if (queue.size() > 0) {
                "停止采集，仍有 ${queue.size()} 条样本保存在本机，下一次采集将继续上传"
            } else {
                state.value.lastError
            },
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
                .put("sensors", JSONArray().apply {
                    sensorInventory.forEach { sensor ->
                        put(JSONObject().apply {
                            put("sensorType", sensor.sensorType)
                            put("name", sensor.name)
                            sensor.vendor?.let { put("vendor", it) }
                            sensor.version?.let { put("version", it) }
                            sensor.powerMa?.let { put("powerMa", it) }
                            sensor.minDelayUs?.let { put("minDelayUs", it) }
                            sensor.maxDelayUs?.let { put("maxDelayUs", it) }
                            sensor.reportingMode?.let { put("reportingMode", it) }
                            put("registered", sensor.registered)
                        })
                    }
                })
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
                    sessionIdFile.parentFile?.mkdirs()
                    activeSessionId?.let(sessionIdFile::writeText)
                    state.value = state.value.copy(sessionId = activeSessionId, lastError = null)
                }
                "samples.accepted" -> state.value = state.value.copy(
                    uploadedSamples = message.optLong("sampleCount", state.value.uploadedSamples),
                )
                "error" -> {
                    val error = message.optString("error")
                    if (error == "session_resume_failed" && activeSessionId != null && running) {
                        activeSessionId = null
                        sessionIdFile.delete()
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
        val batch = queue.peek(MAX_BATCH)
        if (batch.isEmpty()) return

        val payload = JSONObject()
            .put("type", "samples")
            .put("sessionId", sessionId)
            .put("samples", JSONArray().apply { batch.forEach { put(CollectedSampleCodec.encode(it)) } })
        if (currentSocket.send(payload.toString())) {
            // OkHttp accepted the frame. If the process dies before the cursor
            // advances, the batch is sent again on recovery; duplicate delivery
            // is safer than losing a route segment.
            queue.acknowledge(batch.size)
            state.value = state.value.copy(
                uploadedSamples = state.value.uploadedSamples + batch.size,
                pendingSamples = queue.size(),
            )
        }
    }

    companion object {
        private const val TAG = "WayMemorySync"
        private const val MAX_BATCH = 100
        private const val MAX_SENSOR_INVENTORY = 128
        private const val FLUSH_INTERVAL_MS = 80L
        private const val QUEUE_UI_INTERVAL_MS = 250L
        private const val INITIAL_RECONNECT_DELAY_MS = 250L
        private const val MAX_RECONNECT_DELAY_MS = 10_000L
    }
}
