import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const port = 8876;
const dbPath = resolve(cwd, ".data/acceptance-report-check.sqlite");
const disposableFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const baseUrl = `http://127.0.0.1:${port}`;

const removeDisposableFiles = async () => {
  await Promise.all(disposableFiles.map((path) => rm(path, { force: true })));
};

const startApi = () => Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
  cwd,
  env: { ...process.env, PORT: String(port), WAY_MEMORY_DB_PATH: dbPath },
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
  throw new Error("acceptance report API did not start");
};

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json() as Record<string, any>;
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const pose = (timestampNs: number, xM: number) => ({
  deviceTimestampNs: timestampNs,
  xM,
  yM: 0,
  zM: 0,
  velocityXMps: 0,
  velocityYMps: 0,
  velocityZMps: 0,
  accuracyM: 1,
  confidence: 0.9,
  source: "fused",
  frame: "local-enu",
  sourceFlags: ["imu"],
  motionMode: "stationary",
  stationary: true,
});

let api: ReturnType<typeof startApi> | undefined;
try {
  await removeDisposableFiles();
  api = startApi();
  await waitForHealth();

  const created = await requestJson("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      deviceId: "acceptance-report-check",
      mode: "learning",
      client: {
        applicationId: "com.puzzlefuzzy.waymemory",
        versionName: "smoke",
        buildType: "debug",
        apiBaseUrl: baseUrl,
      },
      sensors: [{
        sensorType: "accelerometer",
        sensorId: 1,
        name: "Smoke Accelerometer",
        transportMaxHz: 50,
        registered: true,
      }],
    }),
  }) as { sessionId: string };

  const samples = Array.from({ length: 1_100 }, (_, index) => {
    const timestampNs = index + 1;
    return {
      sampleId: `acceptance-report-${timestampNs}`,
      deviceTimestampNs: timestampNs,
      sensorType: "accelerometer",
      sensorId: 1,
      values: [0, 0, 9.8],
      pose: pose(timestampNs, index * 0.0001),
    };
  });
  for (let index = 0; index < samples.length; index += 500) {
    await requestJson(`/api/sessions/${created.sessionId}/samples`, {
      method: "POST",
      body: JSON.stringify({ samples: samples.slice(index, index + 500) }),
    });
  }

  const reportProcess = Bun.spawn(["bun", "scripts/acceptance-report.ts", `--session=${created.sessionId}`, "--case=baseline"], {
    cwd,
    env: { ...process.env, WAY_MEMORY_API_URL: baseUrl, WAY_MEMORY_SESSION_ID: created.sessionId },
    stdout: "ignore",
    stderr: "pipe",
  });
  const reportExit = await reportProcess.exited;
  if (reportExit !== 0) {
    throw new Error(`long-session acceptance report failed with exit code ${reportExit}: ${await new Response(reportProcess.stderr).text()}`);
  }

  const session = await requestJson(`/api/sessions/${created.sessionId}`) as { rawSampleCount: number; poseTrack?: unknown[] };
  const raw = await requestJson(`/api/sessions/${created.sessionId}/raw`) as { retainedSamples: number; maxRetainedSamples: number };
  const poseCount = session.poseTrack?.length ?? 0;
  if (session.rawSampleCount !== 1_100 || poseCount !== 1_100 || raw.retainedSamples !== 1_024 || raw.maxRetainedSamples !== 1_024) {
    throw new Error(`unexpected bounded replay state: ${JSON.stringify({ rawSampleCount: session.rawSampleCount, poseCount, ...raw })}`);
  }
  console.log("Long-session acceptance report smoke passed", {
    totalSamples: session.rawSampleCount,
    retainedSamples: raw.retainedSamples,
    poses: poseCount,
  });
} finally {
  if (api && !api.killed) api.kill();
  if (api) await api.exited;
  await removeDisposableFiles();
}
