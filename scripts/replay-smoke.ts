import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const dbPath = resolve(cwd, ".data/replay-check.sqlite");
const files = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
const baseUrl = "http://127.0.0.1:8810";
const removeFiles = () => Promise.all(files.map((path) => rm(path, { force: true })));
const request = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
  return response.json() as Promise<any>;
};

let api: ReturnType<typeof Bun.spawn> | undefined;
try {
  await removeFiles();
  api = Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
    cwd,
    env: { ...process.env, PORT: "8810", WAY_MEMORY_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await (await fetch(`${baseUrl}/health`)).json() as { ok: boolean }).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  const source = await request("/api/sessions", { method: "POST", body: JSON.stringify({ deviceId: "replay-source", mode: "learning" }) });
  await request(`/api/sessions/${source.sessionId}/samples`, {
    method: "POST",
    body: JSON.stringify({ samples: [
      { deviceTimestampNs: 1, sensorType: "pose", values: [0, 0, 0], pose: { deviceTimestampNs: 1, xM: 0, yM: 0, zM: 0, velocityXMps: 0, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.8, source: "fused", frame: "local-enu", sourceFlags: ["imu"], motionMode: "stationary", stationary: true } },
      { deviceTimestampNs: 2, sensorType: "pose", values: [1, 0, 0], pose: { deviceTimestampNs: 2, xM: 1, yM: 0, zM: 0, velocityXMps: 1, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.8, source: "fused", frame: "local-enu", sourceFlags: ["imu"], motionMode: "walking", stationary: false } },
    ] }),
  });
  await request(`/api/sessions/${source.sessionId}/stop`, { method: "POST" });
  const replay = Bun.spawn(["bun", "run", "scripts/replay-session.ts", source.sessionId], {
    cwd,
    env: { ...process.env, WAY_MEMORY_API_URL: baseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const replayExit = await replay.exited;
  if (replayExit !== 0) throw new Error(`replay command failed: ${await new Response(replay.stderr).text()}`);
  const sessions = await request("/api/sessions") as Array<{ deviceId: string; sampleCount: number; status: string }>;
  const replayed = sessions.find((item) => item.deviceId === `replay:${source.sessionId}`);
  if (!replayed || replayed.sampleCount !== 2 || replayed.status !== "stopped") throw new Error(`replay assertion failed: ${JSON.stringify(sessions)}`);
  console.log("Replay smoke passed", { sourceSessionId: source.sessionId, replayedSamples: replayed.sampleCount });
} finally {
  if (api && !api.killed) api.kill();
  await api?.exited;
  await removeFiles();
}
