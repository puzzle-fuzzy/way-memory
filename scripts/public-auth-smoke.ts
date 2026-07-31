type JsonRecord = Record<string, any>;

const configuredBaseUrl = Bun.env.WAY_MEMORY_PUBLIC_BASE_URL ?? "https://way-memory.yxswy.com";
const deviceToken = Bun.env.WAY_MEMORY_DEVICE_TOKEN?.trim();
const dashboardToken = Bun.env.WAY_MEMORY_DASHBOARD_TOKEN?.trim();

const fail = (message: string): never => {
  throw new Error(message);
};

const baseUrl = (() => {
  let url: URL;
  try {
    url = new URL(configuredBaseUrl);
  } catch {
    return fail(`invalid public base URL: ${configuredBaseUrl}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return fail("public authenticated smoke requires a clean https:// base URL");
  }
  return url.origin;
})();

if (!deviceToken || !dashboardToken) {
  fail("WAY_MEMORY_DEVICE_TOKEN and WAY_MEMORY_DASHBOARD_TOKEN are required; tokens are never printed");
}

const wsBase = baseUrl.replace(/^https:/, "wss:");

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  let body: JsonRecord = {};
  try {
    body = await response.json() as JsonRecord;
  } catch {
    // Some rejection responses are intentionally bodyless.
  }
  return { response, body };
};

const authHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

const issueTicket = async (token: string) => {
  const result = await requestJson("/api/auth/ws-ticket", { method: "POST", headers: authHeaders(token) });
  if (result.response.status !== 200 || typeof result.body.ticket !== "string" || !result.body.ticket) {
    fail(`WebSocket ticket issuance failed: HTTP ${result.response.status}`);
  }
  return result.body.ticket as string;
};

const waitForOpen = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket open timeout")), 8_000);
  socket.addEventListener("open", () => {
    clearTimeout(timeout);
    resolve();
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("WebSocket open failed"));
  }, { once: true });
});

const nextMessage = (socket: WebSocket) => new Promise<JsonRecord>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket message timeout")), 8_000);
  const onMessage = (event: MessageEvent) => {
    clearTimeout(timeout);
    socket.removeEventListener("message", onMessage);
    try {
      resolve(JSON.parse(String(event.data)) as JsonRecord);
    } catch {
      reject(new Error("WebSocket returned invalid JSON"));
    }
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    socket.removeEventListener("message", onMessage);
    reject(new Error("WebSocket message error"));
  }, { once: true });
});

const openSocket = async (role: "dashboard" | "device", token: string, deviceId?: string) => {
  const ticket = await issueTicket(token);
  const query = new URLSearchParams({ role, ticket });
  if (deviceId) query.set("deviceId", deviceId);
  const socket = new WebSocket(`${wsBase}/realtime?${query.toString()}`);
  await waitForOpen(socket);
  return socket;
};

const run = async () => {
  const deviceId = `public-auth-smoke-${Date.now()}`;
  const dashboard = await openSocket("dashboard", dashboardToken);
  let device = await openSocket("device", deviceToken, deviceId);
  let sessionId = "";
  let routeId = "";
  const routeSessionIds: string[] = [];

  try {
    const startedMessage = nextMessage(device);
    const dashboardStartedMessage = nextMessage(dashboard);
    device.send(JSON.stringify({
      type: "session.start",
      deviceId,
      mode: "learning",
      client: {
        applicationId: "com.puzzlefuzzy.waymemory",
        versionName: "public-auth-smoke",
        buildType: "debug",
        apiBaseUrl: baseUrl,
      },
      sensors: [{ sensorType: "android.sensor.accelerometer", name: "public-auth-smoke", registered: true, transportMaxHz: 50 }],
    }));
    const started = await startedMessage;
    const dashboardStarted = await dashboardStartedMessage;
    sessionId = typeof started.session?.sessionId === "string" ? started.session.sessionId : "";
    if (started.type !== "session.started" || !sessionId) fail(`authenticated session start failed: ${JSON.stringify(started)}`);
    if (dashboardStarted.type !== "session.updated" || dashboardStarted.session?.sessionId !== sessionId) fail("dashboard did not receive owner-scoped session broadcast");

    const acceptedMessage = nextMessage(device);
    const deltaMessage = nextMessage(dashboard);
    const timestampNs = 1_000_000_000;
    device.send(JSON.stringify({
      type: "samples",
      sessionId,
      samples: [{
        sampleId: `${deviceId}-sample-1`,
        deviceTimestampNs: timestampNs,
        sensorType: "android.sensor.linear_acceleration",
        values: [0.01, 0.02, 0.03],
        pose: {
          deviceTimestampNs: timestampNs,
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
    const accepted = await acceptedMessage;
    const delta = await deltaMessage;
    if (accepted.type !== "samples.accepted" || accepted.accepted !== 1) fail(`authenticated sample upload failed: ${JSON.stringify(accepted)}`);
    if (delta.type !== "session.delta" || delta.sessionId !== sessionId || delta.sampleCount !== 1) fail("dashboard did not receive the sample delta");

    device.close();
    await Bun.sleep(100);
    device = await openSocket("device", deviceToken, deviceId);
    const resumedMessage = nextMessage(device);
    const dashboardResumedMessage = nextMessage(dashboard);
    device.send(JSON.stringify({ type: "session.resume", sessionId, deviceId }));
    const resumed = await resumedMessage;
    const dashboardResumed = await dashboardResumedMessage;
    if (resumed.type !== "session.resumed" || resumed.session?.sessionId !== sessionId) fail(`session resume failed: ${JSON.stringify(resumed)}`);
    if (dashboardResumed.type !== "session.updated" || dashboardResumed.session?.sessionId !== sessionId) fail("dashboard did not receive the resumed session");

    const session = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { headers: authHeaders(dashboardToken) });
    const raw = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/raw`, { headers: authHeaders(dashboardToken) });
    if (session.response.status !== 200 || session.body.sessionId !== sessionId || session.body.sampleCount !== 1) fail("dashboard session read failed");
    if (raw.response.status !== 200 || !Array.isArray(raw.body.samples) || raw.body.samples.length !== 1) fail("dashboard raw replay read failed");

    const deviceList = await requestJson("/api/sessions", { headers: authHeaders(deviceToken) });
    const dashboardWrite = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/samples`, {
      method: "POST",
      headers: { ...authHeaders(dashboardToken), "content-type": "application/json" },
      body: JSON.stringify({ samples: [] }),
    });
    if (deviceList.response.status !== 401) fail("device token can read dashboard session list");
    if (dashboardWrite.response.status !== 401) fail("dashboard token can write device samples");

    const stoppedMessage = nextMessage(dashboard);
    device.send(JSON.stringify({ type: "session.stop", sessionId }));
    const stopped = await stoppedMessage;
    if (stopped.type !== "session.updated" || stopped.session?.status !== "stopped") fail("session stop was not broadcast");

    const routeCreated = await requestJson("/api/routes", {
      method: "POST",
      headers: { ...authHeaders(dashboardToken), "content-type": "application/json" },
      body: JSON.stringify({ name: `public-auth-route-${Date.now()}` }),
    });
    if (routeCreated.response.status !== 201 || typeof routeCreated.body.routeId !== "string") fail(`authenticated route creation failed: HTTP ${routeCreated.response.status}`);
    routeId = routeCreated.body.routeId;

    type RoutePoint = { lat: number; lng: number; altitudeM?: number; xM: number };
    const captureObservation = async (observationDeviceId: string, samplePrefix: string, points: RoutePoint[]) => {
      const observationDevice = await openSocket("device", deviceToken, observationDeviceId);
      let observationSessionId = "";
      try {
        observationDevice.send(JSON.stringify({
          type: "session.start",
          deviceId: observationDeviceId,
          mode: "learning",
          routeId,
          client: { applicationId: "com.puzzlefuzzy.waymemory", versionName: "public-auth-route-smoke", buildType: "debug", apiBaseUrl: baseUrl },
          sensors: [{ sensorType: "android.sensor.accelerometer", name: "public-auth-route-smoke", registered: true, transportMaxHz: 50 }],
        }));
        const started = await nextMessage(observationDevice);
        observationSessionId = typeof started.session?.sessionId === "string" ? started.session.sessionId : "";
        if (started.type !== "session.started" || !observationSessionId) fail(`route observation did not start: ${JSON.stringify(started)}`);
        routeSessionIds.push(observationSessionId);
        observationDevice.send(JSON.stringify({
          type: "samples",
          sessionId: observationSessionId,
          samples: points.map((point, index) => ({
            sampleId: `${samplePrefix}-${index + 1}`,
            deviceTimestampNs: (index + 1) * 1_000_000_000,
            sensorType: "location",
            values: [],
            location: { lat: point.lat, lng: point.lng, accuracyM: 4, ...(point.altitudeM === undefined ? {} : { altitudeM: point.altitudeM }) },
            pose: {
              deviceTimestampNs: (index + 1) * 1_000_000_000,
              xM: point.xM,
              yM: 0,
              zM: point.altitudeM === undefined ? 0 : point.altitudeM - (points[0].altitudeM ?? point.altitudeM),
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
        const accepted = await nextMessage(observationDevice);
        if (accepted.type !== "samples.accepted" || accepted.accepted !== points.length) fail(`route observation samples failed: ${JSON.stringify(accepted)}`);
      } finally {
        observationDevice.close();
      }
      const stoppedObservation = await requestJson(`/api/sessions/${encodeURIComponent(observationSessionId)}/stop`, { method: "POST", headers: authHeaders(deviceToken) });
      if (stoppedObservation.response.status !== 200 || stoppedObservation.body.status !== "stopped") fail("route observation did not stop");
      const attached = await requestJson(`/api/routes/${encodeURIComponent(routeId)}/observations`, {
        method: "POST",
        headers: { ...authHeaders(dashboardToken), "content-type": "application/json" },
        body: JSON.stringify({ sessionId: observationSessionId }),
      });
      if (attached.response.status !== 200) fail(`route observation attach failed: HTTP ${attached.response.status}`);
      return attached.body;
    };

    const firstObservation = await captureObservation("public-auth-route-1", "public-auth-route-1", [
      { lat: 31.2304, lng: 121.47, altitudeM: 100, xM: 0 },
      { lat: 31.23041, lng: 121.47, altitudeM: 101, xM: 1 },
    ]);
    if (firstObservation.observations !== 1 || firstObservation.referenceSessionId !== routeSessionIds[0]) fail("reference route observation was not stored");
    const secondObservation = await captureObservation("public-auth-route-2", "public-auth-route-2", [
      { lat: 31.230401, lng: 121.470001, xM: 0.1 },
      { lat: 31.230411, lng: 121.470001, xM: 1.1 },
    ]);
    if (secondObservation.observations !== 2 || secondObservation.observationSummaries?.[1]?.alignment?.status !== "matched") fail("first repeated route observation did not align");
    const thirdObservation = await captureObservation("public-auth-route-3", "public-auth-route-3", [
      { lat: 31.230399, lng: 121.469999, xM: -0.1 },
      { lat: 31.230409, lng: 121.469999, xM: 0.9 },
    ]);
    if (thirdObservation.observations !== 3 || thirdObservation.observationSummaries?.[2]?.alignment?.status !== "matched") fail("second repeated route observation did not align");
    const published = await requestJson(`/api/routes/${encodeURIComponent(routeId)}/publish`, { method: "POST", headers: authHeaders(dashboardToken) });
    if (published.response.status !== 200 || published.body.status !== "verified") fail(`route did not publish as verified: HTTP ${published.response.status}`);

    const handoff = await requestJson(`/api/routes/${encodeURIComponent(routeId)}/handoff`, { method: "POST", headers: authHeaders(dashboardToken) });
    if (handoff.response.status !== 201 || typeof handoff.body.token !== "string") fail(`navigation handoff failed: HTTP ${handoff.response.status}`);
    const navigator = await openSocket("device", deviceToken, "public-auth-navigator");
    let navigationSessionId = "";
    try {
      navigator.send(JSON.stringify({
        type: "session.start",
        deviceId: "public-auth-navigator",
        mode: "navigation",
        handoffToken: handoff.body.token,
        client: { applicationId: "com.puzzlefuzzy.waymemory", versionName: "public-auth-route-smoke", buildType: "debug", apiBaseUrl: baseUrl },
        sensors: [],
      }));
      const navigationStarted = await nextMessage(navigator);
      navigationSessionId = typeof navigationStarted.session?.sessionId === "string" ? navigationStarted.session.sessionId : "";
      if (navigationStarted.type !== "session.started" || navigationStarted.session?.mode !== "navigation" || navigationStarted.session?.routeId !== routeId) fail(`navigation handoff did not bind route: ${JSON.stringify(navigationStarted)}`);
      routeSessionIds.push(navigationSessionId);
    } finally {
      navigator.close();
    }
    const stoppedNavigation = await requestJson(`/api/sessions/${encodeURIComponent(navigationSessionId)}/stop`, { method: "POST", headers: authHeaders(deviceToken) });
    if (stoppedNavigation.response.status !== 200 || stoppedNavigation.body.status !== "stopped") fail("navigation session did not stop");

    const reusedHandoff = await openSocket("device", deviceToken, "public-auth-handoff-reuse");
    try {
      reusedHandoff.send(JSON.stringify({ type: "session.start", deviceId: "public-auth-handoff-reuse", mode: "navigation", handoffToken: handoff.body.token }));
      const reused = await nextMessage(reusedHandoff);
      if (reused.type !== "error" || reused.error !== "invalid_navigation_handoff") fail(`navigation handoff was reusable: ${JSON.stringify(reused)}`);
    } finally {
      reusedHandoff.close();
    }

    console.log("Public authenticated smoke passed", {
      baseUrl,
      sessionId,
      samples: 1,
      resumed: true,
      rawReplay: true,
      verifiedRoute: true,
      navigationHandoff: true,
      roleIsolation: true,
    });
  } finally {
    device.close();
    dashboard.close();
    if (routeId) {
      await requestJson(`/api/routes/${encodeURIComponent(routeId)}`, { method: "DELETE", headers: authHeaders(dashboardToken) }).catch(() => undefined);
    }
    for (const cleanupSessionId of [sessionId, ...routeSessionIds]) {
      await requestJson(`/api/sessions/${encodeURIComponent(cleanupSessionId)}`, { method: "DELETE", headers: authHeaders(dashboardToken) }).catch(() => undefined);
    }
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
