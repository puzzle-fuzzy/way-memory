import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const dbPath = resolve(cwd, ".data/idempotency-check.sqlite");
const files = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
const configuredApiUrl = Bun.env.WAY_MEMORY_API_URL?.replace(/\/$/, "");
const baseUrl = configuredApiUrl ?? "http://127.0.0.1:8830";

const request = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(body)}`);
  return body;
};

const startApi = () => Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
  cwd,
  env: { ...process.env, PORT: "8830", WAY_MEMORY_DB_PATH: dbPath },
  stdout: "pipe",
  stderr: "pipe",
});

let api: ReturnType<typeof startApi> | undefined;
try {
  if (!configuredApiUrl) {
    await Promise.all(files.map((path) => rm(path, { force: true })));
    api = startApi();
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await request("/health")).ok) break;
    } catch {}
    await Bun.sleep(100);
  }

  const session = await request("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "idempotency-check", mode: "learning" }),
  });
  const sample = {
    sampleId: `stable-sample-${Date.now()}`,
    deviceTimestampNs: 1,
    sensorType: "android.sensor.test",
    values: [1, 2, 3],
  };
  const first = await request(`/api/sessions/${session.sessionId}/samples`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ samples: [sample, sample] }),
  });
  if (first.accepted !== 1 || first.session.sampleCount !== 1 || first.session.droppedSampleCount !== 1) {
    throw new Error("same-batch duplicate was not removed idempotently");
  }

  const replayed = await request(`/api/sessions/${session.sessionId}/samples`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ samples: [sample] }),
  });
  if (replayed.accepted !== 0 || replayed.session.sampleCount !== 1 || replayed.session.rawSampleCount !== 1 || replayed.session.droppedSampleCount !== 2) {
    throw new Error("replayed sample was not ignored idempotently");
  }

  console.log("Idempotency smoke passed", {
    baseUrl,
    sessionId: session.sessionId,
    acceptedFirstBatch: first.accepted,
    acceptedReplay: replayed.accepted,
    retainedRaw: replayed.session.rawSampleCount,
  });
} finally {
  if (api && !api.killed) api.kill();
  await api?.exited;
  if (!configuredApiUrl) await Promise.all(files.map((path) => rm(path, { force: true })));
}
