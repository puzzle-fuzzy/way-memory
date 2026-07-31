import type { ObservationSession } from "@way-memory/contracts";
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
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let sessionUpdateTimer: number | undefined;
  let pendingSession: ObservationSession | null | undefined;

  function queueSessionUpdate(nextSession: ObservationSession | null) {
    pendingSession = nextSession;
    if (sessionUpdateTimer !== undefined) return;
    sessionUpdateTimer = window.setTimeout(() => {
      latestSession.value = pendingSession ?? null;
      pendingSession = undefined;
      sessionUpdateTimer = undefined;
    }, 80);
  }

  async function refreshSnapshot() {
    try {
      const response = await fetch(endpoint("/api/sessions"), { cache: "no-store" });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const sessions = await response.json() as ObservationSession[];
      queueSessionUpdate(sessions.find((item) => item.status === "active") ?? sessions[0] ?? null);
    } catch {
      if (connection.value !== "connected") connection.value = "offline";
    }
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
        if (message.type === "session.updated" && message.session) queueSessionUpdate(message.session);
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
    if (sessionUpdateTimer !== undefined) window.clearTimeout(sessionUpdateTimer);
    socket?.close();
  });

  return { connection, latestSession, refreshSnapshot };
}
