import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const port = 8861;
const dbPath = resolve(cwd, ".data/lifecycle-check.sqlite");
await rm(dbPath, { force: true });
await rm(`${dbPath}-wal`, { force: true });
await rm(`${dbPath}-shm`, { force: true });

const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  PORT: String(port),
  WAY_MEMORY_AUTH_MODE: "enforced",
  WAY_MEMORY_BOOTSTRAP_TOKEN: "lifecycle-smoke-bootstrap",
  WAY_MEMORY_DB_PATH: dbPath,
};

const startApi = () => Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
  cwd,
  env,
  stdout: "pipe",
  stderr: "pipe",
});

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // The API may need a moment to open SQLite and bind its port.
    }
    await Bun.sleep(100);
  }
  throw new Error("lifecycle API did not start");
};

const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() as Record<string, any> };
};

const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
let child: Bun.Subprocess | undefined;

try {
  child = startApi();
  await waitForHealth();

  const bootstrap = await json("/api/auth/bootstrap", {
    method: "POST",
    headers: { "x-way-memory-bootstrap": "lifecycle-smoke-bootstrap", "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "lifecycle-smoke-owner" }),
  });
  if (bootstrap.response.status !== 201) throw new Error(`bootstrap failed: ${JSON.stringify(bootstrap.body)}`);
  const { deviceToken, dashboardToken } = bootstrap.body as { deviceToken: string; dashboardToken: string };

  const created = await json("/api/sessions", {
    method: "POST",
    headers: { ...authHeaders(deviceToken), "content-type": "application/json" },
    body: JSON.stringify({
      deviceId: "lifecycle-device",
      mode: "learning",
      client: { applicationId: "com.puzzlefuzzy.waymemory", versionName: "lifecycle-smoke", buildType: "debug", apiBaseUrl: baseUrl },
      sensors: [{ sensorType: "android.sensor.accelerometer", name: "Smoke", registered: true, transportMaxHz: 50 }],
    }),
  });
  if (created.response.status !== 201) throw new Error(`session creation failed: ${JSON.stringify(created.body)}`);
  const sessionId = created.body.sessionId as string;

  const accepted = await json(`/api/sessions/${sessionId}/samples`, {
    method: "POST",
    headers: { ...authHeaders(deviceToken), "content-type": "application/json" },
    body: JSON.stringify({ samples: [{ sampleId: "lifecycle-sample-1", deviceTimestampNs: 1, sensorType: "accelerometer", values: [0, 0, 9.81] }] }),
  });
  if (accepted.response.status !== 200 || accepted.body.accepted !== 1) throw new Error(`sample acceptance failed: ${JSON.stringify(accepted.body)}`);

  const stopped = await json(`/api/sessions/${sessionId}/stop`, { method: "POST", headers: authHeaders(deviceToken) });
  if (stopped.response.status !== 200 || stopped.body.status !== "stopped") throw new Error("session stop failed");
  const exported = await json(`/api/sessions/${sessionId}/export`, { headers: authHeaders(dashboardToken) });
  if (exported.response.status !== 200 || exported.body.rawReplay?.retainedSamples !== 1 || exported.body.rawSamples?.[0]?.sampleId !== "lifecycle-sample-1") {
    throw new Error(`export did not include the bounded replay tail: ${JSON.stringify(exported.body.rawReplay)}`);
  }

  const route = await json("/api/routes", {
    method: "POST",
    headers: { ...authHeaders(dashboardToken), "content-type": "application/json" },
    body: JSON.stringify({ name: "lifecycle route" }),
  });
  if (route.response.status !== 201) throw new Error("route creation failed");
  const attached = await json(`/api/routes/${route.body.routeId}/observations`, {
    method: "POST",
    headers: { ...authHeaders(dashboardToken), "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (attached.response.status !== 200) throw new Error(`route attachment failed: ${JSON.stringify(attached.body)}`);
  const attachedDelete = await json(`/api/sessions/${sessionId}`, { method: "DELETE", headers: authHeaders(dashboardToken) });
  if (attachedDelete.response.status !== 409 || attachedDelete.body.error !== "session_attached_to_route") throw new Error("attached session deletion was not rejected");

  const routeDeleted = await json(`/api/routes/${route.body.routeId}`, { method: "DELETE", headers: authHeaders(dashboardToken) });
  if (routeDeleted.response.status !== 200) throw new Error("route deletion failed");
  const deleted = await json(`/api/sessions/${sessionId}`, { method: "DELETE", headers: authHeaders(dashboardToken) });
  if (deleted.response.status !== 200 || deleted.body.deleted !== true) throw new Error("session deletion failed");
  const deletedRead = await json(`/api/sessions/${sessionId}`, { headers: authHeaders(dashboardToken) });
  if (deletedRead.response.status !== 404) throw new Error("deleted session was still readable before restart");

  child.kill();
  await child.exited;
  child = startApi();
  await waitForHealth();
  const restoredRead = await json(`/api/sessions/${sessionId}`, { headers: authHeaders(dashboardToken) });
  if (restoredRead.response.status !== 404) throw new Error("deleted session returned after SQLite restart");

  console.log("Lifecycle smoke passed", { exportReplay: 1, routeAttachmentGuard: true, deletedBeforeRestart: true, deletedAfterRestart: true });
} finally {
  child?.kill();
  if (child) await child.exited;
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
}
