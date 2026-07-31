const apiHost = window.location.hostname || "127.0.0.1";
const API_BASE = `http://${apiHost}:8787`;
const WS_BASE = `${window.location.protocol === "https:" ? "wss" : "ws"}://${apiHost}:8787`;

const statusNode = document.querySelector("#live-session-status");
const detailNode = document.querySelector("#live-session-detail");

function renderSession(session) {
  if (!statusNode || !detailNode) return;
  if (!session) {
    statusNode.textContent = "等待 Android 连接";
    detailNode.textContent = "打开手机 App，点击开始采集后，这里会显示真实会话。";
    return;
  }
  statusNode.textContent = session.status === "active" ? "Android 正在采集" : "最近一次采集已结束";
  const location = session.latestLocation;
  const locationText = location ? `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}` : "等待位置样本";
  detailNode.textContent = `样本 ${session.sampleCount} · 最新位置 ${locationText}`;
}

async function refreshSession() {
  try {
    const response = await fetch(`${API_BASE}/api/sessions`, { cache: "no-store" });
    const sessions = await response.json();
    renderSession(sessions.at(-1));
  } catch {
    if (statusNode) statusNode.textContent = "服务端未连接";
    if (detailNode) detailNode.textContent = "请先启动 way-memory API（端口 8787）。";
  }
}

function connectRealtime() {
  const socket = new WebSocket(`${WS_BASE}/realtime?role=dashboard`);
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "session.updated") renderSession(message.session);
    } catch {
      // Keep the dashboard available if a malformed message arrives.
    }
  });
  socket.addEventListener("close", () => setTimeout(connectRealtime, 1500));
  socket.addEventListener("error", () => socket.close());
}

refreshSession();
connectRealtime();
