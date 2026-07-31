import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { AuthStore } from "../services/api/src/authStore";

const cwd = process.cwd();
const port = 8860;
const dbPath = resolve(cwd, ".data/auth-check.sqlite");
await rm(dbPath, { force: true });
await rm(`${dbPath}-wal`, { force: true });
await rm(`${dbPath}-shm`, { force: true });

const child = Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
  cwd,
  env: {
    ...process.env,
    PORT: String(port),
    WAY_MEMORY_AUTH_MODE: "enforced",
    WAY_MEMORY_BOOTSTRAP_TOKEN: "auth-smoke-bootstrap",
    WAY_MEMORY_DB_PATH: dbPath,
  },
  stdout: "pipe",
  stderr: "pipe",
});

const baseUrl = `http://127.0.0.1:${port}`;
const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() as Record<string, any> };
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

try {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch {
      if (attempt === 29) throw new Error("auth API did not start");
      await Bun.sleep(100);
    }
  }

  const unauthenticated = await json("/api/sessions");
  if (unauthenticated.response.status !== 401) throw new Error("unauthenticated session list was not rejected");

  const bootstrap = await json("/api/auth/bootstrap", {
    method: "POST",
    headers: { "x-way-memory-bootstrap": "auth-smoke-bootstrap", "content-type": "application/json" },
    body: JSON.stringify({ ownerId: "auth-smoke-owner" }),
  });
  if (bootstrap.response.status !== 201) throw new Error(`bootstrap failed: ${JSON.stringify(bootstrap.body)}`);
  const { deviceToken, dashboardToken, ownerId } = bootstrap.body as { deviceToken: string; dashboardToken: string; ownerId: string };
  if (ownerId !== "auth-smoke-owner" || !deviceToken || !dashboardToken) throw new Error("bootstrap did not return both credentials");

  const reusedBootstrap = await json("/api/auth/bootstrap", { method: "POST", headers: { "x-way-memory-bootstrap": "auth-smoke-bootstrap" } });
  if (reusedBootstrap.response.status !== 409) throw new Error("bootstrap token was reusable");

  const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
  const openAuthenticatedDevice = async (deviceId: string) => {
    const ticket = await json("/api/auth/ws-ticket", { method: "POST", headers: authHeaders(deviceToken) });
    if (ticket.response.status !== 200 || typeof ticket.body.ticket !== "string") throw new Error("authenticated device ticket failed");
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=${encodeURIComponent(deviceId)}&ticket=${encodeURIComponent(ticket.body.ticket)}`);
    await waitForOpen(socket);
    return socket;
  };
  const me = await json("/api/auth/me", { headers: authHeaders(dashboardToken) });
  if (me.response.status !== 200 || me.body.role !== "dashboard" || me.body.ownerId !== ownerId) throw new Error("dashboard identity failed");
  const enrolled = await json("/api/auth/devices", { method: "POST", headers: { ...authHeaders(dashboardToken), "content-type": "application/json" }, body: "{}" });
  if (enrolled.response.status !== 201 || !enrolled.body.deviceToken || !enrolled.body.tokenId) throw new Error("dashboard device enrollment failed");
  const enrolledDevice = await json("/api/auth/devices", { headers: authHeaders(dashboardToken) });
  if (enrolledDevice.response.status !== 200 || !(enrolledDevice.body as any[]).some((item) => item.tokenId === enrolled.body.tokenId && !item.revokedAt)) throw new Error("enrolled device was not listed");
  const revoked = await json(`/api/auth/devices/${encodeURIComponent(enrolled.body.tokenId)}/revoke`, { method: "POST", headers: authHeaders(dashboardToken) });
  if (revoked.response.status !== 200) throw new Error("device revoke failed");
  const revokedDeviceTicket = await json("/api/auth/ws-ticket", { method: "POST", headers: authHeaders(enrolled.body.deviceToken) });
  if (revokedDeviceTicket.response.status !== 401) throw new Error("revoked device token remained usable");
  const pairing = await json("/api/auth/enrollments", { method: "POST", headers: authHeaders(dashboardToken) });
  if (pairing.response.status !== 201 || typeof pairing.body.code !== "string" || !/^WM-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pairing.body.code)) throw new Error("device pairing code creation failed");
  const paired = await json("/api/auth/enrollments/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.body.code }) });
  if (paired.response.status !== 201 || !paired.body.deviceToken || !paired.body.tokenId || paired.body.ownerId !== ownerId) throw new Error(`device pairing exchange failed: ${JSON.stringify(paired.body)}`);
  const reusedPairing = await json("/api/auth/enrollments/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pairing.body.code }) });
  if (reusedPairing.response.status !== 401) throw new Error("device pairing code was reusable");
  const dashboardTicketResponse = await json("/api/auth/ws-ticket", { method: "POST", headers: authHeaders(dashboardToken) });
  const deviceTicketResponse = await json("/api/auth/ws-ticket", { method: "POST", headers: authHeaders(deviceToken) });
  if (dashboardTicketResponse.response.status !== 200 || deviceTicketResponse.response.status !== 200) throw new Error("WebSocket ticket issuance failed");

  const dashboard = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=dashboard&ticket=${encodeURIComponent(dashboardTicketResponse.body.ticket)}`);
  const device = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=auth-device&ticket=${encodeURIComponent(deviceTicketResponse.body.ticket)}`);
  await Promise.all([waitForOpen(dashboard), waitForOpen(device)]);
  device.send(JSON.stringify({
    type: "session.start",
    deviceId: "auth-device",
    mode: "learning",
    client: { applicationId: "com.puzzlefuzzy.waymemory", versionName: "auth-smoke", buildType: "debug", apiBaseUrl: baseUrl },
    sensors: [{ sensorType: "android.sensor.accelerometer", name: "Smoke", registered: true, transportMaxHz: 50 }],
  }));
  const started = await nextMessage(device);
  const session = started.session as { sessionId: string; ownerId: string };
  if (started.type !== "session.started" || session.ownerId !== ownerId) throw new Error("session owner was not assigned from device credential");
  const dashboardStarted = await nextMessage(dashboard);
  if (dashboardStarted.type !== "session.updated") throw new Error("dashboard did not receive owner-scoped session event");

  device.send(JSON.stringify({
    type: "samples",
    sessionId: session.sessionId,
    samples: [{
      sampleId: "auth-report-sample",
      deviceTimestampNs: 1,
      sensorType: "android.sensor.accelerometer",
      values: [0, 0, 9.81],
      pose: {
        deviceTimestampNs: 1,
        xM: 0,
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
      },
    }],
  }));
  const reportAccepted = await nextMessage(device);
  const reportUpdated = await nextMessage(dashboard);
  if (reportAccepted.type !== "samples.accepted" || reportUpdated.type !== "session.delta") throw new Error("auth report sample was not accepted");
  const reportProcess = Bun.spawn(["bun", "scripts/acceptance-report.ts", `--session=${session.sessionId}`, "--case=baseline"], {
    cwd,
    env: { ...process.env, WAY_MEMORY_API_URL: baseUrl, WAY_MEMORY_SESSION_ID: session.sessionId, WAY_MEMORY_DASHBOARD_TOKEN: dashboardToken },
    stdout: "ignore",
    stderr: "pipe",
  });
  const reportExit = await reportProcess.exited;
  if (reportExit !== 0) throw new Error(`authenticated acceptance report failed with exit code ${reportExit}`);

  const deviceList = await json("/api/sessions", { headers: authHeaders(deviceToken) });
  if (deviceList.response.status !== 401) throw new Error("device credential can list dashboard sessions");
  const dashboardRead = await json(`/api/sessions/${session.sessionId}`, { headers: authHeaders(dashboardToken) });
  if (dashboardRead.response.status !== 200 || dashboardRead.body.ownerId !== ownerId) throw new Error("dashboard session read failed");
  const activeDelete = await json(`/api/sessions/${session.sessionId}`, { method: "DELETE", headers: authHeaders(dashboardToken) });
  if (activeDelete.response.status !== 409 || activeDelete.body.error !== "session_must_be_stopped") throw new Error("active session deletion was not rejected");
  const deviceDelete = await json(`/api/sessions/${session.sessionId}`, { method: "DELETE", headers: authHeaders(deviceToken) });
  if (deviceDelete.response.status !== 401) throw new Error("device credential can delete sessions");
  const exported = await json(`/api/sessions/${session.sessionId}/export`, { headers: authHeaders(dashboardToken) });
  if (exported.response.status !== 200 || exported.body.format !== "way-memory.session-export.v1" || !exported.body.session || !Array.isArray(exported.body.rawSamples)) throw new Error("session export failed");
  const routeCreated = await json("/api/routes", { method: "POST", headers: { ...authHeaders(dashboardToken), "content-type": "application/json" }, body: JSON.stringify({ name: "owner-scoped route" }) });
  if (routeCreated.response.status !== 201 || !routeCreated.body.routeId) throw new Error("dashboard route creation failed");
  const otherOwnerStore = new AuthStore(dbPath);
  const otherOwnerDashboard = await otherOwnerStore.issueAccessToken("other-auth-smoke-owner", "dashboard");
  const foreignSessionRead = await json(`/api/sessions/${session.sessionId}`, { headers: authHeaders(otherOwnerDashboard.token) });
  const foreignRouteRead = await json(`/api/routes/${routeCreated.body.routeId}`, { headers: authHeaders(otherOwnerDashboard.token) });
  if (foreignSessionRead.response.status !== 404 || foreignRouteRead.response.status !== 404) throw new Error("owner isolation failed: another owner can read resources");
  const deviceRouteList = await json("/api/routes", { headers: authHeaders(deviceToken) });
  if (deviceRouteList.response.status !== 401) throw new Error("device credential can list routes");
  const deviceRouteRead = await json(`/api/routes/${routeCreated.body.routeId}`, { headers: authHeaders(deviceToken) });
  if (deviceRouteRead.response.status !== 401) throw new Error("device credential can read routes");
  const routeId = routeCreated.body.routeId as string;
  const routeSessionIds: string[] = [];
  const captureRouteObservation = async (deviceId: string, samplePrefix: string, points: Array<{ lat: number; lng: number; xM: number }>) => {
    const routeDevice = await openAuthenticatedDevice(deviceId);
    let routeSessionId = "";
    try {
      routeDevice.send(JSON.stringify({
        type: "session.start",
        deviceId,
        mode: "learning",
        routeId,
        client: { applicationId: "com.puzzlefuzzy.waymemory", versionName: "auth-route-smoke", buildType: "debug", apiBaseUrl: baseUrl },
        sensors: [{ sensorType: "android.sensor.accelerometer", name: "Auth Route Smoke", registered: true, transportMaxHz: 50 }],
      }));
      const startedRoute = await nextMessage(routeDevice);
      routeSessionId = typeof startedRoute.session?.sessionId === "string" ? startedRoute.session.sessionId : "";
      if (startedRoute.type !== "session.started" || !routeSessionId) throw new Error(`route observation did not start: ${JSON.stringify(startedRoute)}`);
      routeSessionIds.push(routeSessionId);
      routeDevice.send(JSON.stringify({
        type: "samples",
        sessionId: routeSessionId,
        samples: points.map((point, index) => ({
          sampleId: `${samplePrefix}-${index + 1}`,
          deviceTimestampNs: (index + 1) * 1_000_000_000,
          sensorType: "location",
          values: [],
          location: { lat: point.lat, lng: point.lng, accuracyM: 4 },
          pose: {
            deviceTimestampNs: (index + 1) * 1_000_000_000,
            xM: point.xM,
            yM: 0,
            zM: 0,
            velocityXMps: 1,
            velocityYMps: 0,
            velocityZMps: 0,
            accuracyM: 1,
            confidence: 0.9,
            source: "fused",
            frame: "local-enu",
            sourceFlags: ["imu", "gnss"],
            motionMode: "walking",
            stationary: false,
          },
        })),
      }));
      const acceptedRoute = await nextMessage(routeDevice);
      if (acceptedRoute.type !== "samples.accepted" || acceptedRoute.accepted !== points.length) throw new Error(`route observation samples failed: ${JSON.stringify(acceptedRoute)}`);
    } finally {
      routeDevice.close();
    }
    const stoppedRoute = await json(`/api/sessions/${encodeURIComponent(routeSessionId)}/stop`, { method: "POST", headers: authHeaders(deviceToken) });
    if (stoppedRoute.response.status !== 200 || stoppedRoute.body.status !== "stopped") throw new Error("route observation did not stop");
    const attachedRoute = await json(`/api/routes/${encodeURIComponent(routeId)}/observations`, {
      method: "POST",
      headers: { ...authHeaders(dashboardToken), "content-type": "application/json" },
      body: JSON.stringify({ sessionId: routeSessionId }),
    });
    if (attachedRoute.response.status !== 200) throw new Error(`route observation attach failed: ${JSON.stringify(attachedRoute.body)}`);
    return attachedRoute.body;
  };
  const firstRouteObservation = await captureRouteObservation("auth-route-device-1", "auth-route-1", [
    { lat: 31.2304, lng: 121.47, xM: 0 },
    { lat: 31.23041, lng: 121.47, xM: 1 },
  ]);
  if (firstRouteObservation.observations !== 1 || firstRouteObservation.referenceSessionId !== routeSessionIds[0]) throw new Error("reference route observation was not stored");
  const secondRouteObservation = await captureRouteObservation("auth-route-device-2", "auth-route-2", [
    { lat: 31.230401, lng: 121.470001, xM: 0.1 },
    { lat: 31.230411, lng: 121.470001, xM: 1.1 },
  ]);
  if (secondRouteObservation.observations !== 2 || secondRouteObservation.observationSummaries?.[1]?.alignment?.status !== "matched") throw new Error("first authenticated route repeat did not align");
  const thirdRouteObservation = await captureRouteObservation("auth-route-device-3", "auth-route-3", [
    { lat: 31.230399, lng: 121.469999, xM: -0.1 },
    { lat: 31.230409, lng: 121.469999, xM: 0.9 },
  ]);
  if (thirdRouteObservation.observations !== 3 || thirdRouteObservation.observationSummaries?.[2]?.alignment?.status !== "matched") throw new Error("second authenticated route repeat did not align");
  const publishedRoute = await json(`/api/routes/${encodeURIComponent(routeId)}/publish`, { method: "POST", headers: authHeaders(dashboardToken) });
  if (publishedRoute.response.status !== 200 || publishedRoute.body.status !== "verified") throw new Error(`authenticated route did not publish: ${JSON.stringify(publishedRoute.body)}`);
  const handoff = await json(`/api/routes/${encodeURIComponent(routeId)}/handoff`, { method: "POST", headers: authHeaders(dashboardToken) });
  if (handoff.response.status !== 201 || typeof handoff.body.token !== "string") throw new Error("authenticated navigation handoff failed");
  const navigator = await openAuthenticatedDevice("auth-route-navigator");
  let navigationSessionId = "";
  try {
    navigator.send(JSON.stringify({ type: "session.start", deviceId: "auth-route-navigator", mode: "navigation", handoffToken: handoff.body.token, client: { applicationId: "com.puzzlefuzzy.waymemory", versionName: "auth-route-smoke", buildType: "debug", apiBaseUrl: baseUrl }, sensors: [] }));
    const navigationStarted = await nextMessage(navigator);
    navigationSessionId = typeof navigationStarted.session?.sessionId === "string" ? navigationStarted.session.sessionId : "";
    if (navigationStarted.type !== "session.started" || navigationStarted.session?.mode !== "navigation" || navigationStarted.session?.routeId !== routeId) throw new Error(`authenticated navigation did not bind route: ${JSON.stringify(navigationStarted)}`);
    routeSessionIds.push(navigationSessionId);
  } finally {
    navigator.close();
  }
  const stoppedNavigation = await json(`/api/sessions/${encodeURIComponent(navigationSessionId)}/stop`, { method: "POST", headers: authHeaders(deviceToken) });
  if (stoppedNavigation.response.status !== 200 || stoppedNavigation.body.status !== "stopped") throw new Error("authenticated navigation session did not stop");
  const reusedHandoffNavigator = await openAuthenticatedDevice("auth-route-handoff-reuse");
  try {
    reusedHandoffNavigator.send(JSON.stringify({ type: "session.start", deviceId: "auth-route-handoff-reuse", mode: "navigation", handoffToken: handoff.body.token }));
    const reusedHandoff = await nextMessage(reusedHandoffNavigator);
    if (reusedHandoff.type !== "error" || reusedHandoff.error !== "invalid_navigation_handoff") throw new Error(`authenticated handoff was reusable: ${JSON.stringify(reusedHandoff)}`);
  } finally {
    reusedHandoffNavigator.close();
  }
  const dashboardWrite = await json(`/api/sessions/${session.sessionId}/samples`, { method: "POST", headers: { ...authHeaders(dashboardToken), "content-type": "application/json" }, body: JSON.stringify({ samples: [] }) });
  if (dashboardWrite.response.status !== 401) throw new Error("dashboard credential can write device samples");

  const stopped = await json(`/api/sessions/${session.sessionId}/stop`, { method: "POST", headers: authHeaders(deviceToken) });
  if (stopped.response.status !== 200 || stopped.body.status !== "stopped") throw new Error("session stop for deletion failed");
  const deleted = await json(`/api/sessions/${session.sessionId}`, { method: "DELETE", headers: authHeaders(dashboardToken) });
  if (deleted.response.status !== 200 || deleted.body.deleted !== true) throw new Error("session deletion failed");
  const deletedRead = await json(`/api/sessions/${session.sessionId}`, { headers: authHeaders(dashboardToken) });
  const deletedRaw = await json(`/api/sessions/${session.sessionId}/raw`, { headers: authHeaders(dashboardToken) });
  if (deletedRead.response.status !== 404 || deletedRaw.response.status !== 404) throw new Error("deleted session remained readable");

  const rotated = await json("/api/auth/rotate", { method: "POST", headers: authHeaders(dashboardToken) });
  if (rotated.response.status !== 200 || !rotated.body.token) throw new Error("dashboard token rotation failed");
  const oldToken = await json("/api/auth/me", { headers: authHeaders(dashboardToken) });
  const newToken = await json("/api/auth/me", { headers: authHeaders(rotated.body.token) });
  if (oldToken.response.status !== 401 || newToken.response.status !== 200) throw new Error("rotated token was not exclusive");

  dashboard.close();
  device.close();
  console.log("Authenticated API smoke passed", { ownerId, sessionId: session.sessionId, dashboardRotation: true, websocketTickets: true, verifiedRoute: true, navigationHandoff: true });
} finally {
  child.kill();
  await child.exited;
  await Bun.sleep(100);
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
}
