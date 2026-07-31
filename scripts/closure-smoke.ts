import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const dbPath = resolve(cwd, ".data/closure-check.sqlite");
const files = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
const baseUrl = "http://127.0.0.1:8800";
const removeFiles = () => Promise.all(files.map((path) => rm(path, { force: true })));
const startApi = () => Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
  cwd,
  env: { ...process.env, PORT: "8800", WAY_MEMORY_DB_PATH: dbPath },
  stdout: "pipe",
  stderr: "pipe",
});
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await (await fetch(`${baseUrl}/health`)).json() as { ok: boolean }).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error("closure API did not start");
};
const request = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
  return response.json() as Promise<any>;
};
const pose = (timestamp: number, x: number, flags: string[]) => ({
  deviceTimestampNs: timestamp,
  xM: x,
  yM: 0,
  zM: 0,
  velocityXMps: 1,
  velocityYMps: 0,
  velocityZMps: 0,
  accuracyM: 0.7,
  confidence: 0.9,
  source: "fused",
  frame: "local-enu",
  sourceFlags: flags,
  motionMode: "walking",
  stationary: false,
});

let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  await removeFiles();
  child = startApi();
  await waitForHealth();
  const session = await request("/api/sessions", { method: "POST", body: JSON.stringify({ deviceId: "closure-check", mode: "learning" }) });
  await request(`/api/sessions/${session.sessionId}/samples`, {
    method: "POST",
    body: JSON.stringify({ samples: [
      { deviceTimestampNs: 1, sensorType: "pose", values: [0, 0, 0], pose: pose(1, 0, ["imu", "visual-aligned"]) },
      { deviceTimestampNs: 2, sensorType: "pose", values: [4, 0, 0], pose: pose(2, 4, ["imu", "visual-aligned"]) },
      { deviceTimestampNs: 3, sensorType: "pose", values: [8, 0, 0], pose: pose(3, 8, ["imu", "visual-aligned"]) },
      { deviceTimestampNs: 4, sensorType: "pose", values: [1, 0, 0], pose: pose(4, 1, ["imu", "visual-aligned", "loop-closure"]), motionEvent: { eventId: "closure-check", deviceTimestampNs: 4, type: "loop-closed", confidence: 0.72 } },
      { deviceTimestampNs: 5, sensorType: "pose", values: [2, 0, 0], pose: pose(5, 2, ["imu", "visual-aligned"]) },
    ] }),
  });
  const restored = await request(`/api/sessions/${session.sessionId}`) as { closure: { status: string; adjusted: boolean }; poseTrack: Array<{ xM: number }>; correctedPoseTrack: Array<{ xM: number }> };
  const corrected = restored.correctedPoseTrack;
  if (restored.closure.status !== "closed" || !restored.closure.adjusted || restored.poseTrack.at(-1)?.xM !== 2 || corrected.at(-1)?.xM !== 1 || corrected[3]?.xM !== 0) {
    throw new Error("loop correction assertion failed");
  }
  await Bun.sleep(2_200);
  child.kill();
  await child.exited;
  child = undefined;
  child = startApi();
  await waitForHealth();
  const afterRestart = await request(`/api/sessions/${session.sessionId}`) as typeof restored;
  if (afterRestart.closure.status !== "closed" || !afterRestart.closure.adjusted || afterRestart.correctedPoseTrack.at(-1)?.xM !== 1) {
    throw new Error("loop correction did not survive restart");
  }
  console.log("Closure smoke passed", { rawEndM: afterRestart.poseTrack.at(-1)?.xM, correctedEndM: afterRestart.correctedPoseTrack.at(-1)?.xM, points: afterRestart.correctedPoseTrack.length, restart: true });

  const longSession = await request("/api/sessions", { method: "POST", body: JSON.stringify({ deviceId: "closure-window-check", mode: "learning" }) });
  const longSamples = Array.from({ length: 1_205 }, (_, index) => {
    const x = index < 300 ? index / 30 : 1;
    const timestamp = index + 1;
    const isReturn = index === 1_204;
    return {
      sampleId: `long-${timestamp}`,
      deviceTimestampNs: timestamp,
      sensorType: "pose",
      values: [x, 0, 0],
      pose: pose(timestamp, isReturn ? 1 : x, ["imu", "visual-aligned", ...(isReturn ? ["loop-closure"] : [])]),
    };
  });
  for (let offset = 0; offset < longSamples.length; offset += 500) {
    await request(`/api/sessions/${longSession.sessionId}/samples`, {
      method: "POST",
      body: JSON.stringify({ samples: longSamples.slice(offset, offset + 500) }),
    });
  }
  const longRestored = await request(`/api/sessions/${longSession.sessionId}`) as {
    closure: { status: string; adjusted: boolean; anchor?: { deviceTimestampNs: number }; travelledM?: number; correction?: { startTimestampNs: number } };
    poseTrack: Array<{ xM: number }>;
    correctedPoseTrack: Array<{ xM: number }>;
  };
  if (
    longRestored.closure.status !== "closed"
    || !longRestored.closure.adjusted
    || longRestored.closure.anchor?.deviceTimestampNs !== 1
    || (longRestored.closure.travelledM ?? 0) < 8
    || longRestored.closure.correction?.startTimestampNs !== 1
    || longRestored.poseTrack.length !== 1_200
    || longRestored.poseTrack.at(-1)?.xM !== 1
    || longRestored.correctedPoseTrack.at(-1)?.xM !== 0
  ) {
    throw new Error("long loop closure did not preserve the session anchor");
  }
  console.log("Long closure window smoke passed", { retainedPosePoints: longRestored.poseTrack.length, travelledM: longRestored.closure.travelledM, anchorTimestampNs: longRestored.closure.anchor?.deviceTimestampNs });
} finally {
  if (child && !child.killed) child.kill();
  await child?.exited;
  await removeFiles();
}
