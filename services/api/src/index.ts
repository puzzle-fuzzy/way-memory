import type { DeviceSnapshot, RouteSummary } from "@way-memory/contracts";

const port = Number(Bun.env.PORT ?? 8787);

const device: DeviceSnapshot = {
  deviceId: "demo-pixel-01",
  label: "演示手机 · Android",
  connected: true,
  batteryPercent: 82,
  temperatureC: 31.4,
  lastSeen: new Date().toISOString(),
  locationQuality: "high",
  sensors: [
    { type: "gnss", label: "GNSS 定位", status: "ready", frequencyHz: 1 },
    { type: "accelerometer", label: "加速度计", status: "ready", frequencyHz: 50 },
    { type: "gyroscope", label: "陀螺仪", status: "ready", frequencyHz: 50 },
    { type: "magnetometer", label: "磁力计", status: "limited", note: "建议校准" },
    { type: "barometer", label: "气压计", status: "ready", frequencyHz: 10 },
    { type: "camera", label: "视觉采集", status: "ready", frequencyHz: 5 },
    { type: "depth", label: "深度感知", status: "unavailable", note: "设备不支持" },
  ],
};

const track = [
  [31.23041, 121.47370], [31.23058, 121.47402], [31.23076, 121.47428],
  [31.23104, 121.47455], [31.23132, 121.47440], [31.23151, 121.47408],
  [31.23175, 121.47382], [31.23203, 121.47398], [31.23230, 121.47426],
].map(([lat, lng], index) => ({
  lat, lng, accuracyM: index > 5 ? 4.8 : 3.2,
  confidence: index > 5 ? 0.86 : 0.96,
  source: index === 4 ? "manual" : "fused",
} as const));

const route: RouteSummary = {
  routeId: "route-home-metro",
  name: "家 · 地铁站入口",
  status: "verified",
  distanceM: 486,
  observations: 4,
  nodes: 7,
  confidence: 0.91,
  updatedAt: "今天 09:42",
  track,
};

const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, {
  ...init,
  headers: { "access-control-allow-origin": "*", ...init.headers },
});

const server = Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS" } });
    if (url.pathname === "/health") return json({ ok: true, service: "way-memory-api", time: new Date().toISOString() });
    if (url.pathname === "/api/devices") return json([device]);
    if (url.pathname === "/api/routes") return json([route]);
    if (url.pathname === "/api/routes/route-home-metro") return json(route);
    return json({ error: "not_found" }, { status: 404 });
  },
});

console.log(`way-memory API listening on ${server.url}`);
