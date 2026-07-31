import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const port = 8870;
const dbPath = resolve(cwd, ".data/route-check.sqlite");
const baseUrl = `http://127.0.0.1:${port}`;

const startApi = async () => {
  const child = Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
    cwd,
    env: { ...process.env, PORT: String(port), WAY_MEMORY_DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return child;
    } catch {
      await Bun.sleep(100);
    }
  }
  child.kill();
  throw new Error("route API did not start");
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

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() as Record<string, any> };
};

const stopApi = async (child: Bun.Subprocess | undefined) => {
  if (!child) return;
  child.kill();
  await child.exited;
  await Bun.sleep(100);
};

await rm(dbPath, { force: true });
await rm(`${dbPath}-wal`, { force: true });
await rm(`${dbPath}-shm`, { force: true });

let api: Bun.Subprocess | undefined;
try {
  api = await startApi();
  const initial = await requestJson("/api/routes");
  if (initial.response.status !== 200 || !Array.isArray(initial.body) || initial.body.length !== 0) throw new Error("route list was not initially empty");

  const created = await requestJson("/api/routes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "真实路线 smoke" }),
  });
  if (created.response.status !== 201 || typeof created.body.routeId !== "string") throw new Error(`route create failed: ${JSON.stringify(created.body)}`);
  const routeId = created.body.routeId as string;

  const device = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=route-smoke-device`);
  await waitForOpen(device);
  device.send(JSON.stringify({
    type: "session.start",
    deviceId: "route-smoke-device",
    mode: "learning",
    routeId,
    sensors: [{ sensorType: "android.sensor.accelerometer", name: "Route Smoke", registered: true, transportMaxHz: 50 }],
  }));
  const started = await nextMessage(device);
  if (started.type !== "session.started" || typeof started.session?.sessionId !== "string") throw new Error("route session did not start");
  const sessionId = started.session.sessionId as string;
  device.send(JSON.stringify({
    type: "samples",
    sessionId,
    samples: [
      { sampleId: "route-sample-1", deviceTimestampNs: 100, sensorType: "location", values: [], location: { lat: 31.2304, lng: 121.47, accuracyM: 4, altitudeM: 100 }, pose: { deviceTimestampNs: 100, xM: 0, yM: 0, zM: 0, velocityXMps: 0, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.9, source: "fused", frame: "local-enu", sourceFlags: ["imu", "gnss"], motionMode: "walking", stationary: false } },
      { sampleId: "route-sample-2", deviceTimestampNs: 200, sensorType: "location", values: [], location: { lat: 31.23041, lng: 121.47, accuracyM: 4, altitudeM: 101 }, pose: { deviceTimestampNs: 200, xM: 1, yM: 0, zM: 0, velocityXMps: 1, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.9, source: "fused", frame: "local-enu", sourceFlags: ["imu", "gnss"], motionMode: "walking", stationary: false } },
    ],
  }));
  const accepted = await nextMessage(device);
  if (accepted.type !== "samples.accepted") throw new Error(`route samples failed: ${JSON.stringify(accepted)}`);
  device.close();

  const stopped = await requestJson(`/api/sessions/${sessionId}/stop`, { method: "POST" });
  if (stopped.response.status !== 200 || stopped.body.status !== "stopped") throw new Error("route session did not stop");
  const attached = await requestJson(`/api/routes/${routeId}/observations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (attached.response.status !== 200 || attached.body.observations !== 1 || attached.body.referenceSessionId !== sessionId || attached.body.track.length !== 2 || attached.body.poseTrack.length !== 2) throw new Error(`route observation attach failed: ${JSON.stringify(attached.body)}`);
  const repeated = await requestJson(`/api/routes/${routeId}/observations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (repeated.response.status !== 200 || repeated.body.observations !== 1) throw new Error("route observation attach was not idempotent");
  const node = await requestJson(`/api/routes/${routeId}/nodes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nodeType: "door", instruction: "进入大门后向前", xM: 1, yM: 0, zM: 0, lat: 31.23041, lng: 121.47, confidence: 0.95 }),
  });
  if (node.response.status !== 201 || node.body.nodes !== 1 || node.body.nodeRecords?.length !== 1 || node.body.nodeRecords[0]?.manualAnnotation !== true) throw new Error("manual route node was not persisted");
  const publish = await requestJson(`/api/routes/${routeId}/publish`, { method: "POST" });
  if (publish.response.status !== 409 || publish.body.error !== "route_alignment_required") throw new Error("route published without alignment");

  const followUp = async (deviceId: string, prefix: string, points: Array<{ lat: number; lng: number; xM: number }>) => {
    const followUpDevice = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=${deviceId}`);
    await waitForOpen(followUpDevice);
    followUpDevice.send(JSON.stringify({
      type: "session.start",
      deviceId,
      mode: "learning",
      routeId,
      sensors: [{ sensorType: "android.sensor.accelerometer", name: "Route Smoke", registered: true, transportMaxHz: 50 }],
    }));
    const followUpStarted = await nextMessage(followUpDevice);
    if (followUpStarted.type !== "session.started" || typeof followUpStarted.session?.sessionId !== "string") throw new Error(`${deviceId} session did not start`);
    const followUpSessionId = followUpStarted.session.sessionId as string;
    followUpDevice.send(JSON.stringify({
      type: "samples",
      sessionId: followUpSessionId,
      samples: points.map((point, index) => ({
        sampleId: `${prefix}-${index + 1}`,
        deviceTimestampNs: (index + 1) * 100,
        sensorType: "location",
        values: [],
        location: { lat: point.lat, lng: point.lng, accuracyM: 4 },
        pose: { deviceTimestampNs: (index + 1) * 100, xM: point.xM, yM: 0, zM: 0, velocityXMps: 1, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.9, source: "fused", frame: "local-enu", sourceFlags: ["imu", "gnss"], motionMode: "walking", stationary: false },
      })),
    }));
    const followUpAccepted = await nextMessage(followUpDevice);
    if (followUpAccepted.type !== "samples.accepted") throw new Error(`${deviceId} samples failed: ${JSON.stringify(followUpAccepted)}`);
    followUpDevice.close();
    const followUpStopped = await requestJson(`/api/sessions/${followUpSessionId}/stop`, { method: "POST" });
    if (followUpStopped.response.status !== 200 || followUpStopped.body.status !== "stopped") throw new Error(`${deviceId} session did not stop`);
    const followUpAttached = await requestJson(`/api/routes/${routeId}/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: followUpSessionId }),
    });
    if (followUpAttached.response.status !== 200) throw new Error(`${deviceId} observation attach failed: ${JSON.stringify(followUpAttached.body)}`);
    return followUpAttached.body;
  };

  const secondObservation = await followUp("route-smoke-device-2", "route-sample-2a", [
    { lat: 31.230401, lng: 121.470001, xM: 0.1 },
    { lat: 31.230411, lng: 121.470001, xM: 1.1 },
  ]);
  if (secondObservation.observations !== 2 || secondObservation.observationSummaries?.[1]?.alignment?.status !== "matched") throw new Error(`GNSS route alignment failed: ${JSON.stringify(secondObservation.observationSummaries)}`);
  const thirdObservation = await followUp("route-smoke-device-3", "route-sample-3a", [
    { lat: 31.230399, lng: 121.469999, xM: -0.1 },
    { lat: 31.230409, lng: 121.469999, xM: 0.9 },
  ]);
  if (thirdObservation.observations !== 3 || thirdObservation.observationSummaries?.[2]?.alignment?.status !== "matched") throw new Error(`second GNSS route alignment failed: ${JSON.stringify(thirdObservation.observationSummaries)}`);
  const published = await requestJson(`/api/routes/${routeId}/publish`, { method: "POST" });
  if (published.response.status !== 200 || published.body.status !== "verified") throw new Error(`aligned route did not publish: ${JSON.stringify(published.body)}`);

  const handoff = await requestJson(`/api/routes/${routeId}/handoff`, { method: "POST" });
  if (handoff.response.status !== 201 || typeof handoff.body.token !== "string" || handoff.body.routeId !== routeId) throw new Error(`navigation handoff was not issued: ${JSON.stringify(handoff.body)}`);
  const handoffNavigator = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=route-handoff-device`);
  await waitForOpen(handoffNavigator);
  handoffNavigator.send(JSON.stringify({
    type: "session.start",
    deviceId: "route-handoff-device",
    mode: "navigation",
    handoffToken: handoff.body.token,
    sensors: [],
  }));
  const handoffStarted = await nextMessage(handoffNavigator);
  if (handoffStarted.type !== "session.started" || handoffStarted.session?.mode !== "navigation" || handoffStarted.session?.routeId !== routeId) throw new Error(`navigation handoff did not bind route: ${JSON.stringify(handoffStarted)}`);
  const handoffSessionId = handoffStarted.session.sessionId as string;
  handoffNavigator.close();
  const handoffStopped = await requestJson(`/api/sessions/${handoffSessionId}/stop`, { method: "POST" });
  if (handoffStopped.response.status !== 200) throw new Error("handoff navigation session did not stop");

  const reusedHandoff = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=route-handoff-reuse`);
  await waitForOpen(reusedHandoff);
  reusedHandoff.send(JSON.stringify({ type: "session.start", deviceId: "route-handoff-reuse", mode: "navigation", handoffToken: handoff.body.token }));
  const reusedMessage = await nextMessage(reusedHandoff);
  if (reusedMessage.type !== "error" || reusedMessage.error !== "invalid_navigation_handoff") throw new Error(`navigation handoff was reusable: ${JSON.stringify(reusedMessage)}`);
  reusedHandoff.close();

  const navigator = new WebSocket(`${baseUrl.replace("http", "ws")}/realtime?role=device&deviceId=route-navigation-device`);
  await waitForOpen(navigator);
  navigator.send(JSON.stringify({
    type: "session.start",
    deviceId: "route-navigation-device",
    mode: "navigation",
    routeId,
    sensors: [],
  }));
  const navigationStarted = await nextMessage(navigator);
  if (navigationStarted.type !== "session.started" || navigationStarted.session?.navigation?.status !== "no-fix") throw new Error(`navigation session did not start on verified route: ${JSON.stringify(navigationStarted)}`);
  const navigationSessionId = navigationStarted.session.sessionId as string;
  navigator.send(JSON.stringify({
    type: "samples",
    sessionId: navigationSessionId,
    samples: [{
      sampleId: "route-navigation-location",
      deviceTimestampNs: 100,
      sensorType: "location",
      values: [],
      location: { lat: 31.230405, lng: 121.470001, accuracyM: 4, altitudeM: 100.5 },
      pose: { deviceTimestampNs: 100, xM: 0, yM: 0, zM: 0, velocityXMps: 0, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.9, source: "fused", frame: "local-enu", sourceFlags: ["gnss"], motionMode: "walking", stationary: false },
    }],
  }));
  const navigationAccepted = await nextMessage(navigator);
  if (navigationAccepted.type !== "samples.accepted") throw new Error(`navigation sample failed: ${JSON.stringify(navigationAccepted)}`);
  const navigationSession = await requestJson(`/api/sessions/${navigationSessionId}`);
  if (navigationSession.response.status !== 200 || navigationSession.body.navigation?.status !== "on-route" || typeof navigationSession.body.navigation?.progressM !== "number" || typeof navigationSession.body.navigation?.remainingM !== "number") throw new Error(`navigation projection failed: ${JSON.stringify(navigationSession.body.navigation)}`);
  navigator.send(JSON.stringify({
    type: "samples",
    sessionId: navigationSessionId,
    samples: [{
      sampleId: "route-navigation-vertical-near",
      deviceTimestampNs: 5_000_000_000,
      sensorType: "location",
      values: [],
      location: { lat: 31.230405, lng: 121.470001, accuracyM: 4, altitudeM: 110.5 },
    }],
  }));
  const verticalAccepted = await nextMessage(navigator);
  if (verticalAccepted.type !== "samples.accepted") throw new Error("vertical navigation sample failed");
  const verticalSession = await requestJson(`/api/sessions/${navigationSessionId}`);
  if (verticalSession.body.navigation?.status !== "near-route" || (verticalSession.body.navigation?.altitudeDeltaM ?? 0) <= 5) throw new Error(`3D navigation projection failed: ${JSON.stringify(verticalSession.body.navigation)}`);
  navigator.send(JSON.stringify({
    type: "samples",
    sessionId: navigationSessionId,
    samples: [{
      sampleId: "route-navigation-off-route",
      deviceTimestampNs: 20_000_000_000,
      sensorType: "location",
      values: [],
      location: { lat: 31.2315, lng: 121.470001, accuracyM: 4 },
    }],
  }));
  const offRouteAccepted = await nextMessage(navigator);
  if (offRouteAccepted.type !== "samples.accepted") throw new Error(`off-route sample failed: ${JSON.stringify(offRouteAccepted)}`);
  const offRouteSession = await requestJson(`/api/sessions/${navigationSessionId}`);
  if (offRouteSession.body.navigation?.status !== "off-route" || (offRouteSession.body.navigation?.distanceToRouteM ?? 0) <= 25) throw new Error(`off-route projection failed: ${JSON.stringify(offRouteSession.body.navigation)}`);
  navigator.close();
  const navigationStopped = await requestJson(`/api/sessions/${navigationSessionId}/stop`, { method: "POST" });
  if (navigationStopped.response.status !== 200 || navigationStopped.body.status !== "stopped") throw new Error("navigation session did not stop");

  await stopApi(api);
  api = await startApi();
  const restored = await requestJson(`/api/routes/${routeId}`);
  if (restored.response.status !== 200 || restored.body.observations !== 3 || restored.body.status !== "verified" || restored.body.referenceSessionId !== sessionId || restored.body.nodeRecords?.length !== 1) throw new Error("route did not survive restart");
  console.log("Route persistence smoke passed", { routeId, sessionId, observations: restored.body.observations, referencePosePoints: restored.body.poseTrack.length, nodes: restored.body.nodeRecords.length, publishBlocked: publish.body.error, published: restored.body.status });
} finally {
  await stopApi(api);
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
}
