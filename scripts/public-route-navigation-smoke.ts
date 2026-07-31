const baseUrl = (Bun.env.WAY_MEMORY_PUBLIC_BASE_URL ?? "http://101.35.246.159").replace(/\/$/, "");
const wsBase = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
let routeId: string | undefined;

const requestJson = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  return { response, body: await response.json() as Record<string, any> };
};

const waitForOpen = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket open timeout")), 5_000);
  socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket open error")); }, { once: true });
});

const nextMessage = (socket: WebSocket) => new Promise<Record<string, any>>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket message timeout")), 5_000);
  socket.addEventListener("message", (event) => { clearTimeout(timeout); resolve(JSON.parse(String(event.data)) as Record<string, any>); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("WebSocket message error")); }, { once: true });
});

const captureObservation = async (deviceId: string, prefix: string, points: Array<{ lat: number; lng: number }>) => {
  const socket = new WebSocket(`${wsBase}/realtime?role=device&deviceId=${encodeURIComponent(deviceId)}`);
  await waitForOpen(socket);
  socket.send(JSON.stringify({ type: "session.start", deviceId, mode: "learning", routeId, sensors: [] }));
  const started = await nextMessage(socket);
  if (started.type !== "session.started" || typeof started.session?.sessionId !== "string") throw new Error(`${deviceId} did not start`);
  const sessionId = started.session.sessionId as string;
  socket.send(JSON.stringify({
    type: "samples",
    sessionId,
    samples: points.map((point, index) => ({
      sampleId: `${prefix}-${index + 1}`,
      deviceTimestampNs: (index + 1) * 1_000_000_000,
      sensorType: "location",
      values: [],
      location: { ...point, accuracyM: 4 },
      pose: { deviceTimestampNs: (index + 1) * 1_000_000_000, xM: index, yM: 0, zM: 0, velocityXMps: 1, velocityYMps: 0, velocityZMps: 0, accuracyM: 1, confidence: 0.9, source: "fused", frame: "local-enu", sourceFlags: ["gnss"], motionMode: "walking", stationary: false },
    })),
  }));
  const accepted = await nextMessage(socket);
  if (accepted.type !== "samples.accepted") throw new Error(`${deviceId} samples failed: ${JSON.stringify(accepted)}`);
  const stopped = await requestJson(`/api/sessions/${sessionId}/stop`, { method: "POST" });
  socket.close();
  if (stopped.response.status !== 200) throw new Error(`${deviceId} did not stop`);
  const attached = await requestJson(`/api/routes/${routeId}/observations`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  if (attached.response.status !== 200) throw new Error(`${deviceId} observation attach failed: ${JSON.stringify(attached.body)}`);
  return attached.body;
};

try {
  const created = await requestJson("/api/routes", {
    method: "POST",
    body: JSON.stringify({ name: `public-navigation-smoke-${Date.now()}` }),
  });
  if (created.response.status !== 201 || typeof created.body.routeId !== "string") throw new Error(`route create failed: ${JSON.stringify(created.body)}`);
  routeId = created.body.routeId;
  const reference = await captureObservation("public-route-observation-1", "public-route-1", [
    { lat: 31.2304, lng: 121.47 },
    { lat: 31.23041, lng: 121.47 },
  ]);
  if (reference.observations !== 1) throw new Error("reference observation was not attached");
  const second = await captureObservation("public-route-observation-2", "public-route-2", [
    { lat: 31.230401, lng: 121.470001 },
    { lat: 31.230411, lng: 121.470001 },
  ]);
  if (second.observationSummaries?.[1]?.alignment?.status !== "matched") throw new Error("second observation did not align");
  const third = await captureObservation("public-route-observation-3", "public-route-3", [
    { lat: 31.230399, lng: 121.469999 },
    { lat: 31.230409, lng: 121.469999 },
  ]);
  if (third.observationSummaries?.[2]?.alignment?.status !== "matched") throw new Error("third observation did not align");
  const published = await requestJson(`/api/routes/${routeId}/publish`, { method: "POST" });
  if (published.response.status !== 200 || published.body.status !== "verified") throw new Error(`route did not publish: ${JSON.stringify(published.body)}`);

  const navigator = new WebSocket(`${wsBase}/realtime?role=device&deviceId=public-route-navigator`);
  await waitForOpen(navigator);
  navigator.send(JSON.stringify({ type: "session.start", deviceId: "public-route-navigator", mode: "navigation", routeId, sensors: [] }));
  const navigationStarted = await nextMessage(navigator);
  if (navigationStarted.type !== "session.started" || navigationStarted.session?.navigation?.status !== "no-fix") throw new Error(`navigation did not start: ${JSON.stringify(navigationStarted)}`);
  const navigationSessionId = navigationStarted.session.sessionId as string;
  navigator.send(JSON.stringify({
    type: "samples",
    sessionId: navigationSessionId,
    samples: [{ sampleId: "public-route-nav-on", deviceTimestampNs: 1_000_000_000, sensorType: "location", values: [], location: { lat: 31.230405, lng: 121.470001, accuracyM: 4 } }],
  }));
  if ((await nextMessage(navigator)).type !== "samples.accepted") throw new Error("navigation on-route sample failed");
  const onRoute = await requestJson(`/api/sessions/${navigationSessionId}?view=integrity`);
  if (onRoute.body.navigation?.status !== "on-route") throw new Error(`on-route projection failed: ${JSON.stringify(onRoute.body.navigation)}`);
  navigator.send(JSON.stringify({
    type: "samples",
    sessionId: navigationSessionId,
    samples: [{ sampleId: "public-route-nav-off", deviceTimestampNs: 10_000_000_000, sensorType: "location", values: [], location: { lat: 31.2315, lng: 121.470001, accuracyM: 4 } }],
  }));
  if ((await nextMessage(navigator)).type !== "samples.accepted") throw new Error("navigation off-route sample failed");
  const offRoute = await requestJson(`/api/sessions/${navigationSessionId}?view=integrity`);
  if (offRoute.body.navigation?.status !== "off-route" || (offRoute.body.navigation?.distanceToRouteM ?? 0) <= 25) throw new Error(`off-route projection failed: ${JSON.stringify(offRoute.body.navigation)}`);
  await requestJson(`/api/sessions/${navigationSessionId}/stop`, { method: "POST" });
  navigator.close();
  console.log("Public route navigation smoke passed", { baseUrl, routeId, observations: 3, published: true, onRoute: onRoute.body.navigation.status, offRoute: offRoute.body.navigation.status });
} finally {
  if (routeId) await requestJson(`/api/routes/${routeId}`, { method: "DELETE" }).catch(() => undefined);
}
