import type { ObservationSession, SessionDelta } from "@way-memory/contracts";
import { onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { LiveConnection } from "../types";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";

function endpoint(path: string) {
  return `${apiBase}${path}`;
}

function realtimeEndpoint() {
  if (apiBase) {
    const url = new URL(apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/realtime";
    url.search = "?role=dashboard";
    return url.toString();
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/realtime?role=dashboard`;
}

export function useRealtimeSession() {
  const connection = ref<LiveConnection>("connecting");
  const latestSession = shallowRef<ObservationSession | null>(null);
  const availableSessions = ref<ObservationSession[]>([]);
  const selectedSessionId = ref<string | null>(null);
  const followingLive = ref(true);
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let sessionUpdateFrame: number | undefined;
  let pendingSession: ObservationSession | null | undefined;

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
      latestLocation: delta.latestLocation ?? current.latestLocation,
      latestAltitudeM: delta.latestAltitudeM ?? current.latestAltitudeM,
      altitudeSource: delta.altitudeSource ?? current.altitudeSource,
      latestRelativePosition: delta.latestRelativePosition ?? current.latestRelativePosition,
      track: [...current.track, ...delta.trackPoints].slice(-500),
      relativeTrack: [...current.relativeTrack, ...delta.relativePoints].slice(-500),
      poseTrack: [...current.poseTrack, ...delta.posePoints].slice(-1200),
      correctedPoseTrack: delta.correctedPosePoints ?? current.correctedPoseTrack,
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
      const response = await fetch(endpoint("/api/sessions"), { cache: "no-store" });
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
      const response = await fetch(endpoint(`/api/sessions/${encodeURIComponent(sessionId)}`), { cache: "no-store" });
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

  function connect() {
    socket?.close();
    connection.value = "connecting";
    socket = new WebSocket(realtimeEndpoint());
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

  onUnmounted(() => {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    if (sessionUpdateFrame !== undefined) window.cancelAnimationFrame(sessionUpdateFrame);
    socket?.close();
  });

  return { connection, latestSession, availableSessions, selectedSessionId, followingLive, refreshSnapshot, selectSession, followLatest };
}
