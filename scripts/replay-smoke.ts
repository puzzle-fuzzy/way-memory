import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const dbPath = resolve(cwd, ".data/replay-check.sqlite");
const files = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
const baseUrl = "http://127.0.0.1:8810";
const bootstrapToken = "replay-smoke-bootstrap-token";
const removeFiles = () => Promise.all(files.map((path) => rm(path, { force: true })));
const request = async (path: string, init?: RequestInit, token?: string) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
};

let api: ReturnType<typeof Bun.spawn> | undefined;
try {
  await removeFiles();
  api = Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
    cwd,
    env: {
      ...Bun.env,
      PORT: "8810",
      WAY_MEMORY_DB_PATH: dbPath,
      WAY_MEMORY_ENV: "test",
      WAY_MEMORY_AUTH_MODE: "enforced",
      WAY_MEMORY_BOOTSTRAP_TOKEN: bootstrapToken,
      WAY_MEMORY_ALLOWED_ORIGIN: "http://127.0.0.1:3412",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await (await fetch(`${baseUrl}/health`)).json() as { ok: boolean }).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  const bootstrap = await request("/api/auth/bootstrap", {
    method: "POST",
    headers: { "x-way-memory-bootstrap": bootstrapToken },
    body: JSON.stringify({ ownerId: "replay-smoke-owner" }),
  });
  if (bootstrap.response.status !== 201 || !bootstrap.body?.deviceToken || !bootstrap.body?.dashboardToken) {
    throw new Error(`replay auth bootstrap failed: ${JSON.stringify(bootstrap.body)}`);
  }
  const deviceToken = bootstrap.body.deviceToken as string;
  const dashboardToken = bootstrap.body.dashboardToken as string;
  const sourceResult = await request("/api/sessions", { method: "POST", body: JSON.stringify({ deviceId: "replay-source", mode: "learning" }) }, deviceToken);
  if (sourceResult.response.status !== 201) throw new Error(`source session creation failed: ${JSON.stringify(sourceResult.body)}`);
  const source = sourceResult.body as { sessionId: string };
  const sampleResult = await request(`/api/sessions/${source.sessionId}/samples`, {
    method: "POST",
    body: JSON.stringify({ samples: [
      { deviceTimestampNs: 1, sensorType: "pose", values: [0, 0, 0], pose: { deviceTimestampNs: 1, xM: 0, yM: 0, zM: 0, velocityXMps: 0, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.8, source: "fused", frame: "local-enu", sourceFlags: ["imu"], motionMode: "stationary", stationary: true } },
      { deviceTimestampNs: 2, sensorType: "pose", values: [1, 0, 0], pose: { deviceTimestampNs: 2, xM: 1, yM: 0, zM: 0, velocityXMps: 1, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.8, source: "fused", frame: "local-enu", sourceFlags: ["imu"], motionMode: "walking", stationary: false } },
      { deviceTimestampNs: 3, sensorType: "arcore.visual-pose", values: [0, 0, 0], metadata: { trackingState: "tracking", trackingReset: true, confidence: 0.9 }, pose: { deviceTimestampNs: 3, xM: 1, yM: 0, zM: 0, velocityXMps: 0, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.8, source: "fused", frame: "local-enu", sourceFlags: ["imu", "visual-reset"], motionMode: "walking", stationary: false } },
      { deviceTimestampNs: 4, sensorType: "arcore.visual-status", values: [], metadata: { available: true, active: true, trackingState: "paused", failureReason: "INSUFFICIENT_FEATURES", detail: "等待视觉特征" } },
    ] }),
  }, deviceToken);
  if (sampleResult.response.status !== 200) throw new Error(`source samples failed: ${JSON.stringify(sampleResult.body)}`);
  const sourceRaw = await request(`/api/sessions/${source.sessionId}/raw`, undefined, dashboardToken);
  const sourceVisualSample = sourceRaw.body?.samples?.find((sample: { sensorType?: string }) => sample.sensorType === "arcore.visual-pose");
  const sourceVisualStatus = sourceRaw.body?.samples?.find((sample: { sensorType?: string }) => sample.sensorType === "arcore.visual-status");
  if (sourceRaw.response.status !== 200 || sourceVisualSample?.metadata?.trackingReset !== true || sourceVisualStatus?.metadata?.trackingState !== "paused" || sourceVisualStatus.pose !== undefined || sourceVisualStatus.relativePosition !== undefined || sourceVisualStatus.motionEvent !== undefined) {
    throw new Error(`source visual metadata was not retained: ${JSON.stringify(sourceRaw.body)}`);
  }
  const stopResult = await request(`/api/sessions/${source.sessionId}/stop`, { method: "POST" }, deviceToken);
  if (stopResult.response.status !== 200) throw new Error(`source stop failed: ${JSON.stringify(stopResult.body)}`);
  const replay = Bun.spawn(["bun", "run", "scripts/replay-session.ts", source.sessionId], {
    cwd,
    env: { ...Bun.env, WAY_MEMORY_API_URL: baseUrl, WAY_MEMORY_DEVICE_TOKEN: deviceToken, WAY_MEMORY_DASHBOARD_TOKEN: dashboardToken },
    stdout: "pipe",
    stderr: "pipe",
  });
  const replayExit = await replay.exited;
  if (replayExit !== 0) throw new Error(`replay command failed: ${await new Response(replay.stderr).text()}`);
  const sessionsResult = await request("/api/sessions", undefined, dashboardToken);
  if (sessionsResult.response.status !== 200) throw new Error(`dashboard session list failed: ${JSON.stringify(sessionsResult.body)}`);
  const sessions = sessionsResult.body as Array<{ sessionId: string; deviceId: string; sampleCount: number; status: string }>;
  const replayed = sessions.find((item) => item.deviceId === `replay:${source.sessionId}`);
  if (!replayed || replayed.sampleCount !== 4 || replayed.status !== "stopped") throw new Error(`replay assertion failed: ${JSON.stringify(sessions)}`);
  const replayedRaw = await request(`/api/sessions/${replayed.sessionId}/raw`, undefined, dashboardToken);
  const replayedVisualSample = replayedRaw.body?.samples?.find((sample: { sensorType?: string }) => sample.sensorType === "arcore.visual-pose");
  const replayedVisualStatus = replayedRaw.body?.samples?.find((sample: { sensorType?: string }) => sample.sensorType === "arcore.visual-status");
  if (replayedVisualSample?.metadata?.trackingReset !== true || replayedVisualStatus?.metadata?.failureReason !== "INSUFFICIENT_FEATURES" || replayedVisualStatus.pose !== undefined || replayedVisualStatus.relativePosition !== undefined || replayedVisualStatus.motionEvent !== undefined) {
    throw new Error(`replayed visual metadata was not retained: ${JSON.stringify(replayedRaw.body)}`);
  }
  console.log("Replay smoke passed", { sourceSessionId: source.sessionId, replayedSamples: replayed.sampleCount, sourceVisualMetadata: true, replayedVisualMetadata: true, visualStatusDiagnostic: true });
} finally {
  if (api && !api.killed) api.kill();
  await api?.exited;
  await removeFiles();
}
