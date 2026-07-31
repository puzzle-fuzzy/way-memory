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
    console.log("Public authenticated smoke passed", {
      baseUrl,
      sessionId,
      samples: 1,
      resumed: true,
      rawReplay: true,
      roleIsolation: true,
    });
  } finally {
    device.close();
    dashboard.close();
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
