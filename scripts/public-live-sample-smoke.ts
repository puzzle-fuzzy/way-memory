const baseUrl = (Bun.env.WAY_MEMORY_PUBLIC_BASE_URL ?? "http://101.35.246.159").replace(/\/$/, "");
const wsUrl = baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
  + "/realtime?role=device&deviceId=public-live-sample-smoke";

const waitForMessage = (socket: WebSocket, timeoutMs = 5_000) => new Promise<Record<string, any>>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket message timeout")), timeoutMs);
  const onMessage = (event: MessageEvent) => {
    clearTimeout(timeout);
    socket.removeEventListener("message", onMessage);
    resolve(JSON.parse(String(event.data)) as Record<string, any>);
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    socket.removeEventListener("message", onMessage);
    reject(new Error("WebSocket error"));
  }, { once: true });
});

const waitForOpen = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("WebSocket open error")), { once: true });
});

const socket = new WebSocket(wsUrl);
try {
  await waitForOpen(socket);
  socket.send(JSON.stringify({
    type: "session.start",
    deviceId: "public-live-sample-smoke",
    mode: "learning",
    sensors: [],
  }));
  const started = await waitForMessage(socket);
  if (started.type !== "session.started" || typeof started.session?.sessionId !== "string") {
    throw new Error(`session start failed: ${JSON.stringify(started)}`);
  }
  const sessionId = started.session.sessionId as string;
  const timestampNs = 339_081_869_614;
  const sample = Bun.env.WAY_MEMORY_SAMPLE ? JSON.parse(Bun.env.WAY_MEMORY_SAMPLE) : {
    sampleId: "public-live-sample-1",
    deviceTimestampNs: timestampNs,
    sensorType: "android.sensor.linear_acceleration",
    values: [-0.0033, 0.0029, 0.0051],
    sensorAccuracy: 2,
    relativePosition: { xM: 0, yM: 0, zM: 0, accuracyM: 5.3 },
    pose: {
      deviceTimestampNs: timestampNs,
      xM: 0,
      yM: 0,
      zM: 0,
      velocityXMps: 0,
      velocityYMps: 0,
      velocityZMps: 0,
      accuracyM: 5.3,
      verticalAccuracyM: 1.5,
      confidence: 0.894,
      source: "fused",
      frame: "local-enu",
      sourceFlags: ["imu", "gnss", "barometer"],
      motionMode: "stationary",
      stationary: true,
    },
  };
  socket.send(JSON.stringify({
    type: "samples",
    sessionId,
    samples: [sample],
  }));
  const accepted = await waitForMessage(socket);
  if (accepted.type !== "samples.accepted") throw new Error(`sample upload failed: ${JSON.stringify(accepted)}`);
  const session = await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json() as Record<string, any>;
  const expectedPoseCount = sample.pose ? 1 : 0;
  if (session.sampleCount !== 1 || session.rawSampleCount !== 1 || session.droppedSampleCount !== 0 || session.poseTrack?.length !== expectedPoseCount) {
    throw new Error(`sample was not retained: ${JSON.stringify({ sessionId, sampleCount: session.sampleCount, rawSampleCount: session.rawSampleCount, droppedSampleCount: session.droppedSampleCount, poses: session.poseTrack?.length })}`);
  }
  socket.send(JSON.stringify({ type: "session.stop", sessionId }));
  console.log("Public live sample smoke passed", { baseUrl, sessionId, sampleCount: session.sampleCount, poses: session.poseTrack.length });
} finally {
  socket.close();
}
