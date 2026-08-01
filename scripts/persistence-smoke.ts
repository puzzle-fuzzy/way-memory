import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const dbPath = resolve(cwd, ".data/persistence-check.sqlite");
const disposableFiles = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
const port = "8799";
const baseUrl = `http://127.0.0.1:${port}`;

const removeDisposableFiles = async () => {
  await Promise.all(disposableFiles.map((path) => rm(path, { force: true })));
};

const startApi = () => Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
  cwd,
  env: { ...process.env, PORT: port, WAY_MEMORY_DB_PATH: dbPath },
  stdout: "pipe",
  stderr: "pipe",
});

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok && (await response.json() as { ok: boolean }).ok) return;
    } catch {
      // The child process is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("persistence API did not start");
};

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
  return response.json() as Promise<any>;
};

let first: ReturnType<typeof startApi> | undefined;
let second: ReturnType<typeof startApi> | undefined;

const waitForSocketOpen = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("persistence WebSocket open timeout")), 2_000);
  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    resolve();
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("persistence WebSocket open failed"));
  }, { once: true });
});

const nextSocketMessage = (socket: WebSocket) => new Promise<Record<string, any>>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("persistence WebSocket message timeout")), 2_000);
  socket.addEventListener("message", (event) => {
    clearTimeout(timeout);
    resolve(JSON.parse(String(event.data)) as Record<string, any>);
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("persistence WebSocket message failed"));
  }, { once: true });
});

try {
  await removeDisposableFiles();
  first = startApi();
  await waitForHealth();
  const session = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ deviceId: "persistence-check", mode: "learning" }),
  }) as { sessionId: string };
  const deviceSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=persistence-check`);
  await waitForSocketOpen(deviceSocket);
  deviceSocket.send(JSON.stringify({
    type: "session.resume",
    sessionId: session.sessionId,
    deviceId: "persistence-check",
    sensors: [{
      sensorType: "android.sensor.dynamic",
      sensorId: 99,
      name: "Persistence Dynamic Sensor",
      maximumRange: 10,
      resolution: 0.1,
      dynamicSensor: true,
      transportMaxHz: 5,
      registered: true,
    }],
  }));
  const resumed = await nextSocketMessage(deviceSocket);
  if (resumed.type !== "session.resumed") throw new Error("dynamic sensor inventory resume was not acknowledged");
  deviceSocket.close();
  await requestJson(`/api/sessions/${session.sessionId}/samples`, {
    method: "POST",
    body: JSON.stringify({
      samples: [{
        deviceTimestampNs: 1,
        sensorType: "arcore.visual-pose",
        values: [0, 0, 0],
        metadata: { trackingState: "tracking", trackingReset: true, confidence: 0.9 },
        pose: {
          deviceTimestampNs: 1,
          xM: 0,
          yM: 0,
          zM: 0,
          velocityXMps: 0,
          velocityYMps: 0,
          velocityZMps: 0,
          accuracyM: 1,
          confidence: 0.8,
          source: "fused",
          frame: "local-enu",
          sourceFlags: ["visual"],
          motionMode: "stationary",
          stationary: true,
        },
      }, {
        deviceTimestampNs: 2,
        sensorType: "arcore.visual-status",
        values: [],
        metadata: {
          available: true,
          active: true,
          trackingState: "paused",
          failureReason: "INSUFFICIENT_FEATURES",
          detail: "等待视觉特征",
        },
      }],
    }),
  });
  await requestJson(`/api/sessions/${session.sessionId}/stop`, { method: "POST" });
  first.kill();
  await first.exited;

  second = startApi();
  await waitForHealth();
  const sessions = await requestJson("/api/sessions") as Array<{ sessionId: string; status: string; posePointCount?: number }>;
  const restored = sessions.find((item) => item.sessionId === session.sessionId);
  const raw = await requestJson(`/api/sessions/${session.sessionId}/raw`) as { retainedSamples: number; samples?: Array<{ sensorType?: string; metadata?: { trackingReset?: boolean; trackingState?: string } }> };
  const restoredSnapshot = await requestJson(`/api/sessions/${session.sessionId}`) as { sensorInventory?: Array<{ sensorType?: string; sensorId?: number; dynamicSensor?: boolean }>; latestSensors?: Array<{ sensorType?: string; metadata?: { trackingState?: string; failureReason?: string } }> };
  const restoredVisualStatus = restoredSnapshot.latestSensors?.find((sample) => sample.sensorType === "arcore.visual-status");
  if (!restored || restored.status !== "stopped" || restored.posePointCount !== 1 || raw.retainedSamples !== 2 || raw.samples?.find((sample) => sample.metadata?.trackingReset === true) === undefined || raw.samples?.find((sample) => sample.sensorType === "arcore.visual-status")?.metadata?.trackingState !== "paused" || restoredVisualStatus?.metadata?.failureReason !== "INSUFFICIENT_FEATURES" || !restoredSnapshot.sensorInventory?.some((sensor) => sensor.sensorType === "android.sensor.dynamic" && sensor.sensorId === 99 && sensor.dynamicSensor === true)) {
    throw new Error("persistence assertion failed");
  }
  console.log("Persistence smoke passed", { sessionId: session.sessionId, posePoints: restored.posePointCount, raw: raw.retainedSamples, visualStatus: true, dynamicSensor: true });
} finally {
  if (first && !first.killed) first.kill();
  if (second && !second.killed) second.kill();
  await Promise.all([first?.exited, second?.exited]);
  await removeDisposableFiles();
}
