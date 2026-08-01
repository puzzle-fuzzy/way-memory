import { rm } from "node:fs/promises";
import { resolve } from "node:path";

type JsonRecord = Record<string, any>;

const cwd = process.cwd();
const port = 8877;
const baseUrl = `http://127.0.0.1:${port}`;
const dbPath = resolve(cwd, ".data/acceptance-cases-check.sqlite");
const disposableFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const cases = ["baseline", "3d", "rotation", "loop", "stairs", "elevator", "recovery", "process-recovery", "network-interruption", "visual-recovery"] as const;

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
  throw new Error("acceptance cases API did not start");
};

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json() as JsonRecord;
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const pose = (
  timestampNs: number,
  xM: number,
  yM: number,
  zM: number,
  options: {
    sourceFlags?: string[];
    motionMode?: string;
    stationary?: boolean;
  } = {},
) => ({
  deviceTimestampNs: timestampNs,
  xM,
  yM,
  zM,
  velocityXMps: 0,
  velocityYMps: 0,
  velocityZMps: 0,
  accuracyM: 1,
  confidence: 0.9,
  source: "fused",
  frame: "local-enu",
  sourceFlags: options.sourceFlags ?? ["imu"],
  motionMode: options.motionMode ?? "walking",
  stationary: options.stationary ?? false,
});

const sample = (
  timestampNs: number,
  xM: number,
  yM: number,
  zM: number,
  options: {
    sensorType?: string;
    sourceFlags?: string[];
    motionMode?: string;
    stationary?: boolean;
    motionEvent?: JsonRecord;
    metadata?: JsonRecord;
    includePose?: boolean;
    values?: number[];
  } = {},
) => ({
  sampleId: `acceptance-case-${timestampNs}-${options.sensorType ?? "accelerometer"}`,
  deviceTimestampNs: timestampNs,
  sensorType: options.sensorType ?? "accelerometer",
  sensorId: 1,
  values: options.values ?? [xM, yM, zM],
  ...(options.metadata ? { metadata: options.metadata } : {}),
  ...(options.includePose === false ? {} : { pose: pose(timestampNs, xM, yM, zM, options) }),
  ...(options.motionEvent ? { motionEvent: options.motionEvent } : {}),
});

const event = (eventId: string, timestampNs: number, type: string, details?: JsonRecord) => ({
  eventId,
  deviceTimestampNs: timestampNs,
  type,
  confidence: 0.8,
  ...(details ? { details } : {}),
});

const samplesFor = (acceptanceCase: typeof cases[number]) => {
  switch (acceptanceCase) {
    case "baseline":
      return [sample(1, 0, 0, 0, { motionMode: "stationary", stationary: true }), sample(2, 0.3, 0, 0)];
    case "3d":
      return [sample(1, 0, 0, 0), sample(2, 0.3, 0.3, 0.3), sample(3, 0.6, 0.6, 0.6)];
    case "rotation":
      return [
        sample(1, 0, 0, 0, { sensorType: "gyroscope", motionMode: "stationary", stationary: true }),
        sample(2, 0, 0, 0, { sensorType: "gyroscope", motionMode: "stationary", stationary: true }),
      ];
    case "loop":
      return [
        sample(1, 0, 0, 0, { sourceFlags: ["imu", "visual-aligned"] }),
        sample(2, 4, 0, 0, { sourceFlags: ["imu", "visual-aligned"] }),
        sample(3, 8, 0, 0, { sourceFlags: ["imu", "visual-aligned"] }),
        sample(4, 1, 0, 0, {
          sourceFlags: ["imu", "visual-aligned", "loop-closure"],
          motionEvent: event("loop-case", 4, "loop-closed", { visualTravelledM: 9 }),
        }),
        sample(5, 2, 0, 0, { sourceFlags: ["imu", "visual-aligned"] }),
      ];
    case "stairs":
      return [
        sample(1, 0, 0, 0, { motionMode: "walking" }),
        sample(2, 0.3, 0.3, 0.3, {
          motionMode: "stairs",
          motionEvent: event("stairs-enter-case", 2, "stairs-enter", { horizontalSpeedMps: 0.5 }),
        }),
        sample(3, 0.6, 0.6, 0.8, { motionMode: "stairs" }),
        sample(4, 0.9, 0.9, 1.1, {
          motionMode: "walking",
          motionEvent: event("stairs-exit-case", 4, "stairs-exit"),
        }),
      ];
    case "elevator":
      return [
        sample(1, 0, 0, 0, { motionMode: "stationary", stationary: true }),
        sample(2, 0, 0, 0.4, {
          motionMode: "elevator",
          motionEvent: event("elevator-enter-case", 2, "elevator-candidate", { barometerVerticalSpeedMps: 0.5 }),
        }),
        sample(3, 0, 0, 1.2, { motionMode: "elevator" }),
        sample(4, 0, 0, 1.3, {
          motionMode: "stationary",
          stationary: true,
          motionEvent: event("elevator-exit-case", 4, "elevator-exit"),
        }),
      ];
    case "recovery":
      return [
        sample(1, 0, 0, 0, { motionMode: "walking" }),
        sample(2, 0.5, 0.2, 0.1, { sourceFlags: ["imu", "recovered-anchor"] }),
        sample(3, 0.8, 0.4, 0.2, { sourceFlags: ["imu", "recovered-anchor"] }),
      ];
    case "process-recovery":
      return [
        sample(1, 0, 0, 0, { motionMode: "walking" }),
        sample(2, 0.5, 0.2, 0.1, { sourceFlags: ["imu", "recovered-anchor"] }),
        sample(3, 0.8, 0.4, 0.2, { sourceFlags: ["imu", "recovered-anchor"] }),
        sample(4, 0, 0, 0, {
          sensorType: "way-memory.session-resumed",
          values: [],
          includePose: false,
          metadata: { resumed: true, latestPoseTimestampNs: 1 },
        }),
      ];
    case "network-interruption":
      return [
        sample(1, 0, 0, 0, { motionMode: "walking" }),
        sample(2, 0.5, 0.2, 0.1),
        sample(3, 0.8, 0.4, 0.2, {
          sensorType: "way-memory.session-resumed",
          values: [],
          includePose: false,
          metadata: { resumed: true, latestPoseTimestampNs: 2 },
        }),
      ];
    case "visual-recovery":
      return [
        sample(1, 0, 0, 0, { sourceFlags: ["imu", "visual-aligned"] }),
        sample(2, 0.4, 0.1, 0.1, {
          sensorType: "arcore.visual-pose",
          sourceFlags: ["imu", "visual-reset"],
          metadata: { trackingState: "tracking", confidence: 0.65, trackingReset: true },
        }),
        sample(3, 0.7, 0.2, 0.2, { sourceFlags: ["imu", "visual-aligned"] }),
        sample(4, 0, 0, 0, {
          sensorType: "arcore.visual-status",
          values: [],
          includePose: false,
          metadata: {
            available: true,
            active: true,
            trackingState: "tracking",
            detail: "视觉位姿正常",
          },
        }),
      ];
  }
};

const runReport = async (sessionId: string, acceptanceCase: typeof cases[number]) => {
  const report = Bun.spawn(["bun", "scripts/acceptance-report.ts", `--session=${sessionId}`, `--case=${acceptanceCase}`], {
    cwd,
    env: { ...process.env, WAY_MEMORY_API_URL: baseUrl, WAY_MEMORY_SESSION_ID: sessionId },
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await report.exited;
  const stdout = await new Response(report.stdout).text();
  const stderr = await new Response(report.stderr).text();
  if (exitCode !== 0) throw new Error(`${acceptanceCase} acceptance report failed: ${stderr || stdout}`);
  const parsed = JSON.parse(stdout) as JsonRecord;
  if (parsed.casePassed !== true || parsed.availableCases?.[acceptanceCase] !== true) {
    throw new Error(`${acceptanceCase} acceptance report did not pass: ${stdout}`);
  }
  return parsed;
};

let api: ReturnType<typeof startApi> | undefined;
try {
  await removeDisposableFiles();
  api = startApi();
  await waitForHealth();

  const results: Record<string, unknown> = {};
  for (const acceptanceCase of cases) {
    const created = await requestJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        deviceId: `acceptance-case-${acceptanceCase}`,
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
    const samples = samplesFor(acceptanceCase);
    await requestJson(`/api/sessions/${created.sessionId}/samples`, {
      method: "POST",
      body: JSON.stringify({ samples }),
    });
    const report = await runReport(created.sessionId, acceptanceCase);
    results[acceptanceCase] = {
      sessionId: created.sessionId,
      poses: report.counts?.poses,
      rawSamples: report.counts?.rawSamples,
      casePassed: report.casePassed,
    };
  }

  console.log("Acceptance cases smoke passed", results);
} finally {
  if (api && !api.killed) api.kill();
  if (api) await api.exited;
  await removeDisposableFiles();
}
