const baseUrl = (Bun.env.WAY_MEMORY_PUBLIC_BASE_URL ?? "http://101.35.246.159").replace(/\/$/, "");
const batchSize = Math.max(1, Math.min(100, Number(Bun.env.WAY_MEMORY_ANDROID_BATCH_SIZE ?? 100)));

const loadSamples = async () => {
  const serial = Bun.env.WAY_MEMORY_ANDROID_SERIAL;
  if (!serial) return [{
    sampleId: "public-android-batch-smoke-1",
    deviceTimestampNs: 339_081_869_614,
    sensorType: "android.sensor.linear_acceleration",
    values: [0.1, 0.2, 0.3],
  }];
  const stdout = await Bun.stdin.text();
  const samples = stdout.split(/\r?\n/).filter(Boolean).slice(0, batchSize).map((line) => JSON.parse(line));
  if (!samples.length) throw new Error("Android queue is empty");
  return samples;
};

const waitForMessage = (socket: WebSocket, timeoutMs = 8_000) => new Promise<Record<string, any>>((resolve, reject) => {
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

const socket = new WebSocket(baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
  + "/realtime?role=device&deviceId=public-android-batch-smoke");
try {
  const samples = await loadSamples();
  await waitForOpen(socket);
  socket.send(JSON.stringify({ type: "session.start", deviceId: "public-android-batch-smoke", mode: "learning", sensors: [] }));
  const started = await waitForMessage(socket);
  if (started.type !== "session.started" || typeof started.session?.sessionId !== "string") throw new Error(`session start failed: ${JSON.stringify(started)}`);
  const sessionId = started.session.sessionId as string;
  socket.send(JSON.stringify({ type: "samples", sessionId, samples }));
  const accepted = await waitForMessage(socket);
  if (accepted.type !== "samples.accepted") throw new Error(`sample upload failed: ${JSON.stringify(accepted)}`);
  const session = await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json() as Record<string, any>;
  const result = {
    baseUrl,
    sessionId,
    sent: samples.length,
    accepted: session.sampleCount,
    rawSamples: session.rawSampleCount,
    dropped: session.droppedSampleCount,
    poses: session.poseTrack?.length ?? 0,
    sensors: session.sensorStats?.length ?? 0,
  };
  socket.send(JSON.stringify({ type: "session.stop", sessionId }));
  if (result.accepted !== result.sent || result.rawSamples !== result.sent || result.dropped !== 0) {
    throw new Error(`Android batch was not retained: ${JSON.stringify(result)}`);
  }
  console.log("Public Android batch smoke passed", result);
} finally {
  socket.close();
}
