import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const port = 8870;
const dbPath = resolve(cwd, ".data/route-check.sqlite");
const baseUrl = `http://127.0.0.1:${port}`;

const startApi = async () => {
  const child = Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
    cwd,
    env: { ...process.env, PORT: String(port), WAY_MEMORY_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return child;
    } catch {
      await Bun.sleep(100);
    }
  }
  child.kill();
  throw new Error("route API did not start");
};

const waitForOpen = (socket: WebSocket) => new Promise<void>((resolveOpen, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket open timeout")), 3_000);
  socket.addEventListener("open", () => { clearTimeout(timeout); resolveOpen(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket open error")); }, { once: true });
});

const nextMessage = (socket: WebSocket) => new Promise<Record<string, any>>((resolveMessage, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket message timeout")), 3_000);
  socket.addEventListener("message", (event) => {
    clearTimeout(timeout);
    resolveMessage(JSON.parse(String(event.data)) as Record<string, any>);
  }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket message error")); }, { once: true });
});

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() as Record<string, any> };
};

const stopApi = async (child: Bun.Subprocess | undefined) => {
  if (!child) return;
  child.kill();
  await child.exited;
  await Bun.sleep(100);
};

await rm(dbPath, { force: true });
await rm(`${dbPath}-wal`, { force: true });
await rm(`${dbPath}-shm`, { force: true });

let api: Bun.Subprocess | undefined;
try {
  api = await startApi();
  const initial = await requestJson("/api/routes");
  if (initial.response.status !== 200 || !Array.isArray(initial.body) || initial.body.length !== 0) throw new Error("route list was not initially empty");

  const created = await requestJson("/api/routes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "真实路线 smoke" }),
  });
  if (created.response.status !== 201 || typeof created.body.routeId !== "string") throw new Error(`route create failed: ${JSON.stringify(created.body)}`);
  const routeId = created.body.routeId as string;

  const device = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=route-smoke-device`);
  await waitForOpen(device);
  device.send(JSON.stringify({
    type: "session.start",
    deviceId: "route-smoke-device",
    mode: "learning",
    routeId,
    sensors: [{ sensorType: "android.sensor.accelerometer", name: "Route Smoke", registered: true, transportMaxHz: 50 }],
  }));
  const started = await nextMessage(device);
  if (started.type !== "session.started" || typeof started.session?.sessionId !== "string") throw new Error("route session did not start");
  const sessionId = started.session.sessionId as string;
  device.send(JSON.stringify({
    type: "samples",
    sessionId,
    samples: [
      { sampleId: "route-sample-1", deviceTimestampNs: 100, sensorType: "location", values: [], location: { lat: 31.2304, lng: 121.47, accuracyM: 4 }, pose: { deviceTimestampNs: 100, xM: 0, yM: 0, zM: 0, velocityXMps: 0, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.9, source: "fused", frame: "local-enu", sourceFlags: ["imu", "gnss"], motionMode: "walking", stationary: false } },
      { sampleId: "route-sample-2", deviceTimestampNs: 200, sensorType: "location", values: [], location: { lat: 31.23041, lng: 121.47, accuracyM: 4 }, pose: { deviceTimestampNs: 200, xM: 1, yM: 0, zM: 0, velocityXMps: 1, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.9, source: "fused", frame: "local-enu", sourceFlags: ["imu", "gnss"], motionMode: "walking", stationary: false } },
    ],
  }));
  const accepted = await nextMessage(device);
  if (accepted.type !== "samples.accepted") throw new Error(`route samples failed: ${JSON.stringify(accepted)}`);
  device.close();

  const stopped = await requestJson(`/api/sessions/${sessionId}/stop`, { method: "POST" });
  if (stopped.response.status !== 200 || stopped.body.status !== "stopped") throw new Error("route session did not stop");
  const attached = await requestJson(`/api/routes/${routeId}/observations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (attached.response.status !== 200 || attached.body.observations !== 1 || attached.body.referenceSessionId !== sessionId || attached.body.track.length !== 2 || attached.body.poseTrack.length !== 2) throw new Error(`route observation attach failed: ${JSON.stringify(attached.body)}`);
  const repeated = await requestJson(`/api/routes/${routeId}/observations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (repeated.response.status !== 200 || repeated.body.observations !== 1) throw new Error("route observation attach was not idempotent");
  const publish = await requestJson(`/api/routes/${routeId}/publish`, { method: "POST" });
  if (publish.response.status !== 409 || publish.body.error !== "route_alignment_required") throw new Error("route published without alignment");

  await stopApi(api);
  api = await startApi();
  const restored = await requestJson(`/api/routes/${routeId}`);
  if (restored.response.status !== 200 || restored.body.observations !== 1 || restored.body.referenceSessionId !== sessionId) throw new Error("route did not survive restart");
  console.log("Route persistence smoke passed", { routeId, sessionId, observations: restored.body.observations, referencePosePoints: restored.body.poseTrack.length, publishBlocked: publish.body.error });
} finally {
  await stopApi(api);
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
}
