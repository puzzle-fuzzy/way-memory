package com.puzzlefuzzy.waymemory.sensing

import android.util.Log
import com.puzzlefuzzy.waymemory.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
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

data class CollectedSample(
    val deviceTimestampNs: Long,
    val sensorType: String,
    val values: List<Float> = emptyList(),
    val accuracy: Float? = null,
    val location: LocationSample? = null,
    val relativePosition: RelativePositionSample? = null,
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

data class SessionSyncState(
    val connected: Boolean = false,
    val sessionId: String? = null,
    val uploadedSamples: Long = 0,
    val pendingSamples: Int = 0,
    val lastError: String? = null,
)

class SessionUploader(
    private val baseUrl: String = BuildConfig.API_BASE_URL,
) : WebSocketListener() {
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = ConcurrentLinkedQueue<CollectedSample>()
    private val state = MutableStateFlow(SessionSyncState())
    private var socket: WebSocket? = null
    private var flushJob: Job? = null
    private var deviceId: String = "android-device"

    val syncState: StateFlow<SessionSyncState> = state.asStateFlow()

    fun start(deviceId: String) {
        if (socket != null) return
        this.deviceId = deviceId
        val websocketUrl = baseUrl
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://") + "/realtime?role=device&deviceId=$deviceId"
        state.value = SessionSyncState(lastError = null)
        socket = client.newWebSocket(
            Request.Builder().url(websocketUrl).build(),
            this,
        )
        flushJob = scope.launch {
            while (isActive) {
                flush()
                delay(FLUSH_INTERVAL_MS)
            }
        }
    }

    fun enqueue(sample: CollectedSample) {
        queue.add(sample)
        state.value = state.value.copy(pendingSamples = queue.size)
    }

    fun stop() {
        flushJob?.cancel()
        repeat(10) {
            if (queue.isEmpty()) return@repeat
            flush()
        }
        state.value.sessionId?.let { sessionId ->
            socket?.send(JSONObject().put("type", "session.stop").put("sessionId", sessionId).toString())
        }
        flushJob = null
        socket?.close(1000, "session stopped")
        socket = null
        state.value = state.value.copy(connected = false)
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        state.value = state.value.copy(connected = true, lastError = null)
        webSocket.send(
            JSONObject()
                .put("type", "session.start")
                .put("deviceId", deviceId)
                .put("mode", "learning")
                .toString(),
        )
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        runCatching {
            val message = JSONObject(text)
            when (message.optString("type")) {
                "session.started" -> state.value = state.value.copy(sessionId = message.getJSONObject("session").getString("sessionId"))
                "samples.accepted" -> state.value = state.value.copy(uploadedSamples = message.optLong("sampleCount", state.value.uploadedSamples))
                "error" -> state.value = state.value.copy(lastError = message.optString("error"))
            }
        }.onFailure { error ->
            Log.w(TAG, "Invalid realtime message", error)
        }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        socket = null
        state.value = state.value.copy(connected = false, lastError = t.message ?: "WebSocket 连接失败")
    }

    private fun flush() {
        val sessionId = state.value.sessionId ?: return
        val currentSocket = socket ?: return
        if (queue.isEmpty()) return

        val batch = ArrayList<CollectedSample>(MAX_BATCH)
        repeat(MAX_BATCH) { queue.poll()?.let(batch::add) }
        if (batch.isEmpty()) return

        val payload = JSONObject()
            .put("type", "samples")
            .put("sessionId", sessionId)
            .put("samples", JSONArray().apply { batch.forEach { put(it.toJson()) } })
        if (!currentSocket.send(payload.toString())) {
            batch.forEach(queue::add)
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
    }

    companion object {
        private const val TAG = "WayMemorySync"
        private const val MAX_BATCH = 100
        private const val FLUSH_INTERVAL_MS = 80L
    }
}
