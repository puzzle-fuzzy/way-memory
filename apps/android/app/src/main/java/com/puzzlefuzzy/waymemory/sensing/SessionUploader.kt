package com.puzzlefuzzy.waymemory.sensing

import android.util.Log
import android.net.Uri
import com.puzzlefuzzy.waymemory.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI as JavaUri
import java.util.concurrent.TimeUnit
import java.util.UUID

data class CollectedSample(
    val sampleId: String = UUID.randomUUID().toString(),
    val deviceTimestampNs: Long,
    val sensorType: String,
    val sensorId: Int? = null,
    val values: List<Float> = emptyList(),
    val metadata: Map<String, Any?> = emptyMap(),
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
    val provider: String? = null,
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

data class SessionLifecycleEvent(
    val resumed: Boolean,
    val latestPose: PoseEstimateSample?,
)

data class SensorInventorySample(
    val sensorType: String,
    val sensorId: Int? = null,
    val name: String,
    val vendor: String? = null,
    val version: Int? = null,
    val powerMa: Float? = null,
    val maximumRange: Float? = null,
    val resolution: Float? = null,
    val minDelayUs: Int? = null,
    val maxDelayUs: Int? = null,
    val fifoReservedEventCount: Int? = null,
    val fifoMaxEventCount: Int? = null,
    val reportingMode: Int? = null,
    val wakeUpSensor: Boolean? = null,
    val dynamicSensor: Boolean? = null,
    val transportMaxHz: Int? = null,
    val registered: Boolean,
)

internal data class SessionStartRequest(
    val deviceId: String,
    val sensorInventory: List<SensorInventorySample>,
    val client: CaptureClientSample? = null,
    val mode: String = "learning",
    val routeId: String? = null,
    val handoffToken: String? = null,
)

internal data class CaptureClientSample(
    val applicationId: String,
    val versionName: String,
    val buildType: String,
    val apiBaseUrl: String,
)

internal fun buildSessionStartRequest(
    deviceId: String,
    sensorInventory: List<SensorInventorySample>,
    client: CaptureClientSample? = null,
    mode: String = "learning",
    routeId: String? = null,
    handoffToken: String? = null,
): SessionStartRequest = SessionStartRequest(deviceId, sensorInventory, client, mode, routeId, handoffToken)

internal fun buildSensorInventoryUpdateMessage(
    sessionId: String,
    sensorInventory: List<SensorInventorySample>,
): JSONObject = JSONObject()
    .put("type", "session.sensors")
    .put("sessionId", sessionId)
    .put("sensors", sensorInventoryJson(sensorInventory))

private fun sensorInventoryJson(sensorInventory: List<SensorInventorySample>): JSONArray = JSONArray().apply {
    sensorInventory.forEach { sensor ->
        put(JSONObject().apply {
            put("sensorType", sensor.sensorType)
            sensor.sensorId?.let { put("sensorId", it) }
            put("name", sensor.name)
            sensor.vendor?.let { put("vendor", it) }
            sensor.version?.let { put("version", it) }
            sensor.powerMa?.let { put("powerMa", it) }
            sensor.maximumRange?.let { put("maximumRange", it) }
            sensor.resolution?.let { put("resolution", it) }
            sensor.minDelayUs?.let { put("minDelayUs", it) }
            sensor.maxDelayUs?.let { put("maxDelayUs", it) }
            sensor.fifoReservedEventCount?.let { put("fifoReservedEventCount", it) }
            sensor.fifoMaxEventCount?.let { put("fifoMaxEventCount", it) }
            sensor.reportingMode?.let { put("reportingMode", it) }
            sensor.wakeUpSensor?.let { put("wakeUpSensor", it) }
            sensor.dynamicSensor?.let { put("dynamicSensor", it) }
            sensor.transportMaxHz?.let { put("transportMaxHz", it) }
            put("registered", sensor.registered)
        })
    }
}

internal fun buildSamplesMessage(sessionId: String, batch: List<CollectedSample>): JSONObject = JSONObject()
    .put("type", "samples")
    .put("sessionId", sessionId)
    .put("samples", JSONArray().apply {
        // The durable queue stores one JSON object per line as text, but the
        // WebSocket contract requires an array of objects, not an array of
        // JSON-encoded strings.
        batch.forEach { put(JSONObject(CollectedSampleCodec.encode(it))) }
    })

internal fun canSendCredentialOverTransport(baseUrl: String): Boolean {
    val uri = runCatching { JavaUri(baseUrl.trim()) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase() ?: return false
    val host = uri.host?.lowercase()?.trim('[', ']') ?: return false
    return scheme == "https" || (scheme == "http" && host in setOf("localhost", "127.0.0.1", "::1", "10.0.2.2"))
}

internal fun parseSessionLifecycleEvent(message: JSONObject): SessionLifecycleEvent? {
    val type = message.optString("type")
    if (type != "session.started" && type != "session.resumed") return null
    val session = message.optJSONObject("session") ?: return null
    return SessionLifecycleEvent(
        resumed = type == "session.resumed",
        latestPose = session.optJSONObject("latestPose")?.toPoseEstimateSample(),
    )
}

private fun JSONObject.toPoseEstimateSample(): PoseEstimateSample? {
    val timestampNs = optLong("deviceTimestampNs", 0L)
    val xM = optDouble("xM", Double.NaN)
    val yM = optDouble("yM", Double.NaN)
    val zM = optDouble("zM", Double.NaN)
    val velocityXMps = optDouble("velocityXMps", Double.NaN)
    val velocityYMps = optDouble("velocityYMps", Double.NaN)
    val velocityZMps = optDouble("velocityZMps", Double.NaN)
    val accuracyM = optDouble("accuracyM", Double.NaN)
    val confidence = optDouble("confidence", Double.NaN)
    if (
        timestampNs <= 0L
        || !xM.isFinite() || !yM.isFinite() || !zM.isFinite()
        || !velocityXMps.isFinite() || !velocityYMps.isFinite() || !velocityZMps.isFinite()
        || !accuracyM.isFinite() || !confidence.isFinite()
    ) return null
    val verticalAccuracyM = if (has("verticalAccuracyM") && !isNull("verticalAccuracyM")) {
        optDouble("verticalAccuracyM", Double.NaN).takeIf(Double::isFinite)?.toFloat()
    } else {
        null
    }
    val flags = optJSONArray("sourceFlags")?.let { values ->
        List(values.length()) { index -> values.optString(index).takeIf(String::isNotBlank) }
            .filterNotNull()
    } ?: emptyList()
    return PoseEstimateSample(
        deviceTimestampNs = timestampNs,
        xM = xM.toFloat(),
        yM = yM.toFloat(),
        zM = zM.toFloat(),
        velocityXMps = velocityXMps.toFloat(),
        velocityYMps = velocityYMps.toFloat(),
        velocityZMps = velocityZMps.toFloat(),
        accuracyM = accuracyM.toFloat().coerceAtLeast(0f),
        verticalAccuracyM = verticalAccuracyM,
        confidence = confidence.toFloat().coerceIn(0f, 1f),
        source = optString("source", "fused"),
        frame = optString("frame", "local-enu"),
        sourceFlags = flags,
        motionMode = optString("motionMode", "unknown"),
        stationary = optBoolean("stationary", false),
    )
}

private fun SessionStartRequest.toJson(): JSONObject = JSONObject()
    .put("type", "session.start")
    .put("deviceId", deviceId)
    .put("mode", mode)
    .apply {
        routeId?.takeIf(String::isNotBlank)?.let { put("routeId", it) }
        handoffToken?.takeIf(String::isNotBlank)?.let { put("handoffToken", it) }
        client?.let {
            put("client", JSONObject()
                .put("applicationId", it.applicationId)
                .put("versionName", it.versionName)
                .put("buildType", it.buildType)
                .put("apiBaseUrl", it.apiBaseUrl))
        }
    }
    .put("sensors", sensorInventoryJson(sensorInventory))

class SessionUploader(
    private val baseUrl: String = BuildConfig.API_BASE_URL,
    storageDirectory: File,
    private val credentialStore: DeviceCredentialStore? = null,
    private val onSessionLifecycle: ((SessionLifecycleEvent) -> Unit)? = null,
    private val onCaptureBlocked: ((String) -> Unit)? = null,
) : WebSocketListener() {
    private val client = OkHttpClient.Builder().pingInterval(15, TimeUnit.SECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val queue = PersistentSampleQueue(storageDirectory)
    private val sessionIdFile = File(storageDirectory, "active-session.id")
    private val sessionConfigFile = File(storageDirectory, "active-session.config.json")
    private val state = MutableStateFlow(SessionSyncState(pendingSamples = queue.size()))
    @Volatile private var socket: WebSocket? = null
    private var connectionJob: Job? = null
    private var deviceId: String = "android-device"
    private var sensorInventory: List<SensorInventorySample> = emptyList()
    private var captureMode: String = "learning"
    private var captureRouteId: String? = null
    private var captureHandoffToken: String? = null
    @Volatile private var activeSessionId: String? = null
    @Volatile private var running = false
    private var nextConnectAtMs = 0L
    private var reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    private var lastQueueUiPublishMs = 0L
    @Volatile private var inFlightBatchSize = 0
    @Volatile private var inFlightSocket: WebSocket? = null

    val syncState: StateFlow<SessionSyncState> = state.asStateFlow()

    /** A force-stop can leave this marker behind; an explicit stop removes it. */
    fun hasPersistedSession(): Boolean = sessionIdFile.isFile
        && runCatching { sessionIdFile.readText().trim().isNotEmpty() }.getOrDefault(false)

    fun start(
        deviceId: String,
        sensorInventory: List<SensorInventorySample> = emptyList(),
        mode: String = "learning",
        routeId: String? = null,
        handoffToken: String? = null,
    ) {
        if (running) return
        this.deviceId = deviceId
        this.sensorInventory = sensorInventory.take(MAX_SENSOR_INVENTORY)
        activeSessionId = runCatching {
            sessionIdFile.takeIf { it.exists() }?.readText()?.trim()?.takeIf { it.isNotBlank() }
        }.getOrNull()
        val persistedConfig = readSessionConfig()
        captureMode = persistedConfig?.first ?: mode
        captureRouteId = persistedConfig?.second ?: routeId
        captureHandoffToken = persistedConfig?.third ?: handoffToken
        persistSessionConfig()
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
            state.update { current ->
                current.copy(
                    pendingSamples = queue.size(),
                    droppedSamples = current.droppedSamples + dropped,
                    lastError = if (dropped > 0) "待上传队列已满，已淘汰最旧的 $dropped 条样本" else current.lastError,
                )
            }
        }
    }

    /** Publish a bounded capability snapshot when a dynamic sensor changes state. */
    fun updateSensorInventory(sensorInventory: List<SensorInventorySample>) {
        this.sensorInventory = sensorInventory.take(MAX_SENSOR_INVENTORY)
        val sessionId = activeSessionId ?: return
        val currentSocket = socket ?: return
        currentSocket.send(buildSensorInventoryUpdateMessage(sessionId, this.sensorInventory).toString())
    }

    fun stop() {
        if (!running) return
        running = false
        connectionJob?.cancel()
        val stopSocket = socket
        val stopSessionId = activeSessionId
        if (stopSocket == null || stopSessionId == null) {
            finishStop(
                stopSocket = stopSocket,
                sessionId = stopSessionId,
                sessionFinalized = stopSessionId == null,
            )
            return
        }
        scope.launch {
            val deadlineMs = System.currentTimeMillis() + STOP_DRAIN_TIMEOUT_MS
            while (queue.size() > 0 && stopSocket === socket && System.currentTimeMillis() < deadlineMs) {
                if (inFlightBatchSize == 0) flush()
                delay(STOP_DRAIN_POLL_MS)
            }
            val drained = queue.size() == 0 && stopSocket === socket
            val stopSent = drained && stopSocket.send(
                JSONObject().put("type", "session.stop").put("sessionId", stopSessionId).toString(),
            )
            finishStop(
                stopSocket = stopSocket,
                sessionId = stopSessionId,
                sessionFinalized = stopSent,
            )
        }
    }

    /** Explicitly discards a stale, unsent capture after UI confirmation. */
    fun discardPendingCapture() {
        if (running) return
        queue.clear()
        sessionIdFile.delete()
        sessionConfigFile.delete()
        activeSessionId = null
        state.update { current ->
            current.copy(
                connected = false,
                sessionId = null,
                pendingSamples = 0,
                lastError = "已按用户确认清除未上传会话",
            )
        }
    }

    private fun finishStop(stopSocket: WebSocket?, sessionId: String?, sessionFinalized: Boolean) {
        connectionJob = null
        stopSocket?.close(1000, "session stopped")
        if (socket === stopSocket) socket = null
        inFlightBatchSize = 0
        inFlightSocket = null
        if (sessionFinalized) {
            sessionIdFile.delete()
            sessionConfigFile.delete()
            activeSessionId = null
        } else if (sessionId != null) {
            // Keep the session marker and pending queue bound together after
            // a failed drain. A later capture must resume this session rather
            // than attach old samples to a new one.
            sessionIdFile.parentFile?.mkdirs()
            sessionIdFile.writeText(sessionId)
            activeSessionId = sessionId
        }
        val stopWarning = if (!sessionFinalized && sessionId != null) {
            "网络未确认会话已停止；已保留 ${queue.size()} 条待上传样本，下次开始将继续当前会话"
        } else {
            null
        }
        state.update { current ->
            current.copy(
                connected = false,
                sessionId = if (sessionFinalized) null else sessionId,
                pendingSamples = queue.size(),
                lastError = stopWarning ?: if (queue.size() > 0) {
                    "停止采集，仍有 ${queue.size()} 条样本保存在本机，下一次采集将继续上传"
                } else {
                    current.lastError
                },
            )
        }
    }

    private fun connect() {
        if (!running || socket != null) return
        val accessToken = credentialStore?.readToken()
        if (accessToken != null && !canSendCredentialOverTransport(baseUrl)) {
            state.update { current -> current.copy(connected = false, lastError = "已阻止向非 HTTPS 服务发送设备凭据") }
            nextConnectAtMs = System.currentTimeMillis() + MAX_RECONNECT_DELAY_MS
            return
        }
        val ticket = accessToken?.let(::requestWebSocketTicket)
        val ticketQuery = ticket?.let { "&ticket=${android.net.Uri.encode(it)}" } ?: ""
        val websocketUrl = baseUrl.trimEnd('/')
            .replaceFirst("http://", "ws://")
            .replaceFirst("https://", "wss://") + "/realtime?role=device&deviceId=${android.net.Uri.encode(deviceId)}$ticketQuery"
        socket = client.newWebSocket(Request.Builder().url(websocketUrl).build(), this)
        nextConnectAtMs = System.currentTimeMillis() + reconnectDelayMs
    }

    private fun requestWebSocketTicket(accessToken: String): String? {
        if (!canSendCredentialOverTransport(baseUrl)) {
            state.update { current -> current.copy(lastError = "已阻止向非 HTTPS 服务发送设备凭据") }
            return null
        }
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/api/auth/ws-ticket")
            .header("Authorization", "Bearer $accessToken")
            .post(ByteArray(0).toRequestBody())
            .build()
        return runCatching {
            client.newCall(request).execute().use { response ->
                if (response.code == 404) return@use null
                if (!response.isSuccessful) {
                    state.update { current -> current.copy(lastError = "设备授权失败：HTTP ${response.code}") }
                    return@use null
                }
                response.body?.string()?.let { JSONObject(it).optString("ticket").takeIf(String::isNotBlank) }
            }
        }.getOrElse {
            state.update { current -> current.copy(lastError = "无法获取实时授权 ticket") }
            null
        }
    }

    fun exchangeEnrollmentCode(code: String): String? {
        if (!baseUrl.trim().startsWith("https://", ignoreCase = true)) {
            state.update { current -> current.copy(lastError = "设备配对必须使用 HTTPS 服务端") }
            return null
        }
        val request = Request.Builder()
            .url("${baseUrl.trimEnd('/')}/api/auth/enrollments/consume")
            .post(JSONObject().put("code", code.trim()).toString().toRequestBody())
            .build()
        return runCatching {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    state.update { current -> current.copy(lastError = "设备配对失败：HTTP ${response.code}") }
                    return@use null
                }
                response.body?.string()?.let { JSONObject(it).optString("deviceToken").takeIf(String::isNotBlank) }
            }
        }.getOrElse {
            state.update { current -> current.copy(lastError = "无法连接服务端完成设备配对") }
            null
        }
    }

    override fun onOpen(webSocket: WebSocket, response: Response) {
        if (!running) {
            webSocket.close(1000, "session stopped")
            return
        }
        reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
        nextConnectAtMs = 0L
        state.update { current -> current.copy(connected = true, lastError = null) }
        val message = if (activeSessionId == null) {
            sessionStartMessage()
        } else {
            JSONObject()
                .put("type", "session.resume")
                .put("sessionId", activeSessionId)
                .put("deviceId", deviceId)
                .put("sensors", sensorInventoryJson(sensorInventory))
        }
        webSocket.send(message.toString())
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        runCatching {
            val message = JSONObject(text)
            when (message.optString("type")) {
                "session.started", "session.resumed" -> {
                    val session = message.getJSONObject("session")
                    activeSessionId = session.getString("sessionId")
                    // The server resolves a one-time handoff into a normal,
                    // owner-scoped route binding. Persist only that resolved
                    // non-secret binding so a later session replacement can
                    // remain in navigation mode without retaining the raw
                    // handoff token.
                    captureMode = session.optString("mode", captureMode).takeIf { it == "learning" || it == "navigation" } ?: captureMode
                    captureRouteId = session.optString("routeId").takeIf(String::isNotBlank)
                    sessionIdFile.parentFile?.mkdirs()
                    activeSessionId?.let(sessionIdFile::writeText)
                    // The one-time navigation code is only needed until the
                    // server accepts the session start. Do not retain the raw
                    // code in the app-private recovery file after that point.
                    captureHandoffToken = null
                    persistSessionConfig()
                    state.update { current -> current.copy(sessionId = activeSessionId, lastError = null) }
                    parseSessionLifecycleEvent(message)?.let { onSessionLifecycle?.invoke(it) }
                }
                "samples.accepted" -> {
                    if (inFlightSocket === webSocket && inFlightBatchSize > 0) {
                        val acknowledged = inFlightBatchSize
                        inFlightBatchSize = 0
                        inFlightSocket = null
                        queue.acknowledge(acknowledged)
                        state.update { current ->
                            current.copy(
                                uploadedSamples = message.optLong("sampleCount", current.uploadedSamples + acknowledged),
                                pendingSamples = queue.size(),
                            )
                        }
                    }
                }
                "error" -> {
                    val error = message.optString("error")
                    if (BuildConfig.DEBUG) Log.w(TAG, "server error=$error")
                    if (error == "session_resume_failed" && queue.size() > 0 && activeSessionId != null && running) {
                        running = false
                        connectionJob?.cancel()
                        if (socket === webSocket) {
                            socket = null
                            inFlightBatchSize = 0
                            inFlightSocket = null
                        }
                        val message = "会话已过期；${queue.size()} 条旧样本已保留，请恢复网络后重试，或明确清除后开始新会话"
                        state.update { current -> current.copy(connected = false, lastError = message) }
                        onCaptureBlocked?.invoke(message)
                        webSocket.close(1000, "session resume failed")
                    } else if (error == "session_resume_failed" && activeSessionId != null && running) {
                        activeSessionId = null
                        sessionIdFile.delete()
                        state.update { current -> current.copy(sessionId = null, lastError = "会话已过期，正在建立新会话") }
                        webSocket.send(sessionStartMessage().toString())
                    } else {
                        state.update { current -> current.copy(lastError = error) }
                    }
                }
            }
        }.onFailure { error ->
            Log.w(TAG, "Invalid realtime message", error)
        }
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (socket === webSocket) {
            socket = null
            inFlightBatchSize = 0
            inFlightSocket = null
        }
        scheduleReconnect(t.message ?: "WebSocket 连接失败")
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        if (socket === webSocket) {
            socket = null
            inFlightBatchSize = 0
            inFlightSocket = null
        }
        scheduleReconnect(if (reason.isBlank()) "WebSocket 已断开" else reason)
    }

    private fun scheduleReconnect(error: String) {
        if (!running) return
        nextConnectAtMs = System.currentTimeMillis() + reconnectDelayMs
        reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(MAX_RECONNECT_DELAY_MS)
        state.update { current -> current.copy(connected = false, lastError = error) }
    }

    private fun flush() {
        val sessionId = activeSessionId ?: return
        val currentSocket = socket ?: return
        if (inFlightBatchSize > 0) return
        val batch = queue.peek(MAX_BATCH)
        if (batch.isEmpty()) return

        val payload = buildSamplesMessage(sessionId, batch)
        // Record the batch before send(). OkHttp may deliver a very fast server
        // ACK on another callback thread before send() returns to this method.
        inFlightBatchSize = batch.size
        inFlightSocket = currentSocket
        if (!currentSocket.send(payload.toString())) {
            inFlightBatchSize = 0
            inFlightSocket = null
        }
        // Keep the batch in the durable queue until the server confirms it.
        // If the process or socket dies first, the same sampleIds are replayed
        // and the server's bounded dedupe window prevents double counting.
    }

    private fun sessionStartMessage(): JSONObject = buildSessionStartRequest(
        deviceId = deviceId,
        sensorInventory = sensorInventory,
        mode = captureMode,
        routeId = captureRouteId,
        handoffToken = captureHandoffToken,
        client = CaptureClientSample(
            applicationId = "com.puzzlefuzzy.waymemory",
            versionName = BuildConfig.VERSION_NAME,
            buildType = if (BuildConfig.DEBUG) "debug" else "release",
            apiBaseUrl = baseUrl,
        ),
    ).toJson()

    private fun readSessionConfig(): Triple<String, String?, String?>? = runCatching {
        if (!sessionConfigFile.isFile) return@runCatching null
        val json = JSONObject(sessionConfigFile.readText())
        val mode = json.optString("mode", "learning").takeIf { it == "learning" || it == "navigation" } ?: "learning"
        val routeId = json.optString("routeId").takeIf(String::isNotBlank)
        val handoffToken = json.optString("handoffToken").takeIf(String::isNotBlank)
        Triple(mode, routeId, handoffToken)
    }.getOrNull()

    private fun persistSessionConfig() {
        runCatching {
            sessionConfigFile.parentFile?.mkdirs()
            sessionConfigFile.writeText(
                JSONObject()
                    .put("mode", captureMode)
                    .apply {
                        captureRouteId?.takeIf(String::isNotBlank)?.let { put("routeId", it) }
                        captureHandoffToken?.takeIf(String::isNotBlank)?.let { put("handoffToken", it) }
                    }
                    .toString(),
            )
        }
    }

    companion object {
        private const val TAG = "WayMemorySync"
        private const val MAX_BATCH = 100
        private const val MAX_SENSOR_INVENTORY = 128
        private const val FLUSH_INTERVAL_MS = 80L
        private const val QUEUE_UI_INTERVAL_MS = 250L
        private const val STOP_DRAIN_TIMEOUT_MS = 1_500L
        private const val STOP_DRAIN_POLL_MS = 20L
        private const val INITIAL_RECONNECT_DELAY_MS = 250L
        private const val MAX_RECONNECT_DELAY_MS = 10_000L
    }
}
