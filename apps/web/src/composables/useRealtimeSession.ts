import type { ObservationSession, SessionDelta } from "@way-memory/contracts";
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { LiveConnection } from "../types";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function endpoint(path: string) {
  return `${apiBase}${path}`;
}

function realtimeEndpoint(ticket?: string) {
  if (apiBase) {
    const url = new URL(apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/realtime";
    url.search = `?role=dashboard${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ""}`;
    return url.toString();
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/realtime?role=dashboard${ticket ? `&ticket=${encodeURIComponent(ticket)}` : ""}`;
}

export function useRealtimeSession() {
  const connection = ref<LiveConnection>("connecting");
  const authRequired = ref(false);
  const authToken = ref(sessionStorage.getItem("way-memory.dashboard-token") ?? "");
  const authenticated = computed(() => authToken.value.length > 0 && !authRequired.value);
  const latestSession = shallowRef<ObservationSession | null>(null);
  const availableSessions = ref<ObservationSession[]>([]);
  const selectedSessionId = ref<string | null>(null);
  const followingLive = ref(true);
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let sessionUpdateFrame: number | undefined;
  let pendingSession: ObservationSession | null | undefined;

  function requestHeaders() {
    return authToken.value ? { Authorization: `Bearer ${authToken.value}` } : undefined;
  }

  async function requestWebSocketTicket() {
    if (!authToken.value) return undefined;
    const response = await fetch(endpoint("/api/auth/ws-ticket"), { method: "POST", headers: requestHeaders() });
    if (response.status === 404) return undefined;
    if (response.status === 401) {
      authRequired.value = true;
      connection.value = "offline";
      return null;
    }
    if (!response.ok) throw new Error(`API ${response.status}`);
    const body = await response.json() as { ticket?: string };
    if (!body.ticket) throw new Error("missing WebSocket ticket");
    return body.ticket;
  }

  function queueSessionUpdate(nextSession: ObservationSession | null) {
    pendingSession = nextSession;
    if (sessionUpdateFrame !== undefined) return;
    sessionUpdateFrame = window.requestAnimationFrame(() => {
      latestSession.value = pendingSession ?? null;
      pendingSession = undefined;
      sessionUpdateFrame = undefined;
    });
  }

  function applySessionDelta(delta: SessionDelta) {
    const current = pendingSession ?? latestSession.value;
    if (!current || current.sessionId !== delta.sessionId) {
      if (followingLive.value) void refreshSnapshot();
      return;
    }
    queueSessionUpdate({
      ...current,
      status: delta.status,
      lastReceivedAt: delta.lastReceivedAt ?? current.lastReceivedAt,
      lastSampleAt: delta.lastSampleAt ?? current.lastSampleAt,
      sampleCount: delta.sampleCount,
      rawSampleCount: delta.rawSampleCount,
      droppedSampleCount: delta.droppedSampleCount,
      outOfOrderSampleCount: delta.outOfOrderSampleCount,
      latestLocation: delta.latestLocation ?? current.latestLocation,
      latestAltitudeM: delta.latestAltitudeM ?? current.latestAltitudeM,
      altitudeSource: delta.altitudeSource ?? current.altitudeSource,
      latestRelativePosition: delta.latestRelativePosition ?? current.latestRelativePosition,
      track: [...current.track, ...delta.trackPoints].slice(-500),
      relativeTrack: [...current.relativeTrack, ...delta.relativePoints].slice(-500),
      poseTrack: [...current.poseTrack, ...delta.posePoints].slice(-1200),
      correctedPoseTrack: delta.correctedPosePoints
        ? !current.closure.adjusted && delta.closure.adjusted
          ? delta.correctedPosePoints
          : [...(current.correctedPoseTrack ?? current.poseTrack), ...delta.correctedPosePoints].slice(-1200)
        : current.correctedPoseTrack,
      latestPose: delta.latestPose ?? current.latestPose,
      motionMode: delta.motionMode,
      closure: delta.closure,
      motionEvents: [...current.motionEvents, ...delta.motionEvents].slice(-128),
      sensorInventory: delta.sensorInventory ?? current.sensorInventory,
      sensorStats: delta.sensorStats,
      latestSensors: delta.latestSensors,
    });
  }

  async function refreshSnapshot() {
    try {
      const response = await fetch(endpoint("/api/sessions"), { cache: "no-store", headers: requestHeaders() });
      if (response.status === 401) {
        authRequired.value = true;
        connection.value = "offline";
        return;
      }
      if (!response.ok) throw new Error(`API ${response.status}`);
      const sessions = await response.json() as ObservationSession[];
      availableSessions.value = sessions;
      const preferred = followingLive.value
        ? sessions.find((item) => item.status === "active") ?? sessions[0]
        : sessions.find((item) => item.sessionId === selectedSessionId.value);
      if (preferred) queueSessionUpdate(preferred);
    } catch {
      if (connection.value !== "connected") connection.value = "offline";
    }
  }

  async function selectSession(sessionId: string) {
    followingLive.value = false;
    selectedSessionId.value = sessionId;
    try {
      const response = await fetch(endpoint(`/api/sessions/${encodeURIComponent(sessionId)}`), { cache: "no-store", headers: requestHeaders() });
      if (response.status === 401) {
        authRequired.value = true;
        connection.value = "offline";
        return;
      }
      if (!response.ok) throw new Error(`API ${response.status}`);
      queueSessionUpdate(await response.json() as ObservationSession);
    } catch {
      await refreshSnapshot();
    }
  }

  function followLatest() {
    followingLive.value = true;
    selectedSessionId.value = null;
    void refreshSnapshot();
  }

  function scheduleReconnect() {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 1500);
  }

  async function connect() {
    socket?.close();
    connection.value = "connecting";
    let ticket: string | undefined;
    try {
      const requestedTicket = await requestWebSocketTicket();
      if (requestedTicket === null) return;
      ticket = requestedTicket;
    } catch {
      connection.value = "offline";
      scheduleReconnect();
      return;
    }
    socket = new WebSocket(realtimeEndpoint(ticket));
    socket.addEventListener("open", () => { connection.value = "connected"; });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; session?: ObservationSession };
        if (message.type === "session.updated" && message.session) {
          availableSessions.value = [message.session, ...availableSessions.value.filter((item) => item.sessionId !== message.session?.sessionId)];
          if (followingLive.value) queueSessionUpdate(message.session);
        }
        if (message.type === "session.delta") applySessionDelta(message as SessionDelta);
      } catch {
        // A malformed update should not take down the monitoring console.
      }
    });
    socket.addEventListener("error", () => { connection.value = "offline"; });
    socket.addEventListener("close", () => {
      connection.value = "offline";
      scheduleReconnect();
    });
  }

  onMounted(() => {
    refreshSnapshot();
    connect();
  });

  function setAuthToken(token: string) {
    authToken.value = token.trim();
    if (authToken.value) sessionStorage.setItem("way-memory.dashboard-token", authToken.value);
    else sessionStorage.removeItem("way-memory.dashboard-token");
    authRequired.value = false;
    void refreshSnapshot();
    void connect();
  }

  function clearAuthToken() {
    setAuthToken("");
  }

  async function enrollDevice() {
    const response = await fetch(endpoint("/api/auth/devices"), {
      method: "POST",
      headers: { ...requestHeaders(), "content-type": "application/json" },
      body: "{}",
    });
    if (response.status === 401) {
      authRequired.value = true;
      throw new Error("dashboard authorization expired");
    }
    if (!response.ok) throw new Error(`API ${response.status}`);
    return await response.json() as { ownerId: string; tokenId: string; deviceToken: string; expiresAt: string };
  }

  onUnmounted(() => {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (sessionUpdateFrame !== undefined) window.cancelAnimationFrame(sessionUpdateFrame);
    socket?.close();
  });

  return { connection, authRequired, authenticated, latestSession, availableSessions, selectedSessionId, followingLive, refreshSnapshot, selectSession, followLatest, setAuthToken, clearAuthToken, enrollDevice };
}
