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

try {
  await removeDisposableFiles();
  first = startApi();
  await waitForHealth();
  const session = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ deviceId: "persistence-check", mode: "learning" }),
  }) as { sessionId: string };
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
  const raw = await requestJson(`/api/sessions/${session.sessionId}/raw`) as { retainedSamples: number; samples?: Array<{ metadata?: { trackingReset?: boolean } }> };
  if (!restored || restored.status !== "stopped" || restored.posePointCount !== 1 || raw.retainedSamples !== 1 || raw.samples?.[0]?.metadata?.trackingReset !== true) {
    throw new Error("persistence assertion failed");
  }
  console.log("Persistence smoke passed", { sessionId: session.sessionId, posePoints: restored.posePointCount, raw: raw.retainedSamples });
} finally {
  if (first && !first.killed) first.kill();
  if (second && !second.killed) second.kill();
  await Promise.all([first?.exited, second?.exited]);
  await removeDisposableFiles();
}
