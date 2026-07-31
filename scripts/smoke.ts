const child = Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
  cwd: process.cwd(),
  stdout: "pipe",
  stderr: "pipe",
});

try {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:8787/health");
      if (!response.ok) throw new Error(`Health status ${response.status}`);
      const health = await response.json() as { ok: boolean };
      const publicHealth = await fetch("http://127.0.0.1:8787/api/health");
      if (!publicHealth.ok || !(await publicHealth.json() as { ok: boolean }).ok) throw new Error("Public health status failed");
      const routes = await (await fetch("http://127.0.0.1:8787/api/routes")).json() as unknown[];
      if (!health.ok || routes.length !== 1) throw new Error("Unexpected API payload");
      const waitForMessage = (socket: WebSocket) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WebSocket message timeout")), 2_000);
        socket.addEventListener("message", (event) => {
          clearTimeout(timeout);
          resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
        }, { once: true });
        socket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket error"));
        }, { once: true });
      });
      const waitForOpen = (socket: WebSocket) => new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket open error")), { once: true });
      });

      const dashboard = new WebSocket("ws://127.0.0.1:8787/realtime?role=dashboard");
      const device = new WebSocket("ws://127.0.0.1:8787/realtime?role=device&deviceId=smoke-device");
      await Promise.all([waitForOpen(dashboard), waitForOpen(device)]);
      device.send(JSON.stringify({ type: "session.start", deviceId: "smoke-device", mode: "learning" }));
      const started = await waitForMessage(device);
      const session = started.session as { sessionId: string };
      await waitForMessage(dashboard);
      device.send(JSON.stringify({
        type: "samples",
        sessionId: session.sessionId,
        samples: [
          { deviceTimestampNs: 1, sensorType: "accelerometer", values: [0, 0, 9.8], relativePosition: { xM: 0, yM: 0, zM: 0, accuracyM: 2 }, pose: { deviceTimestampNs: 1, xM: 0, yM: 0, zM: 0, velocityXMps: 0, velocityYMps: 0, velocityZMps: 0, accuracyM: 2, confidence: 0.9, source: "fused", frame: "local-enu", sourceFlags: ["imu"], motionMode: "stationary", stationary: true } },
          { deviceTimestampNs: 2, sensorType: "android.sensor.pressure", values: [1013.25], relativePosition: { xM: 0.2, yM: 0.1, zM: 0.05, accuracyM: 2 }, pose: { deviceTimestampNs: 2, xM: 0.2, yM: 0.1, zM: 0.05, velocityXMps: 0.2, velocityYMps: 0.1, velocityZMps: 0, accuracyM: 2.2, confidence: 0.88, source: "fused", frame: "local-enu", sourceFlags: ["imu", "barometer"], motionMode: "walking", stationary: false }, motionEvent: { eventId: "smoke-elevator", deviceTimestampNs: 2, type: "elevator-candidate", confidence: 0.7, details: { barometerVerticalSpeedMps: 0.4 } } },
          { deviceTimestampNs: 3, sensorType: "android.sensor.pressure", values: [1012.5] },
          { deviceTimestampNs: 7, sensorType: "location", values: [], location: { lat: 31.2304, lng: 121.47, accuracyM: 4 } },
          { deviceTimestampNs: 5, sensorType: "location", values: [], location: { lat: 31.2301, lng: 121.4703, accuracyM: 4 } },
          { deviceTimestampNs: 4, sensorType: "location", values: [], location: { lat: 31.23, lng: 121.47, accuracyM: 4 } },
          { deviceTimestampNs: 6, sensorType: "location", values: [], location: { lat: 31.2304, lng: 121.4703, accuracyM: 4 } },
          { deviceTimestampNs: 8, sensorType: "location", values: [], location: { lat: 31.2304, lng: 121.47, accuracyM: 4 } },
        ],
      }));
      const accepted = await waitForMessage(device);
      const updated = await waitForMessage(dashboard);
      const updatedDelta = updated as { type: string; sampleCount: number; rawSampleCount: number; droppedSampleCount: number; trackPoints: Array<{ deviceTimestampNs?: number; lat: number; lng: number; altitudeM?: number; altitudeSource?: string }>; relativePoints: Array<{ xM: number; yM: number; zM: number }>; posePoints: Array<{ xM: number; yM: number; zM: number; motionMode: string; frame?: string }>; motionEvents: unknown[]; motionMode: string; latestAltitudeM?: number; altitudeSource?: string; latestSensors: unknown[]; sensorStats: Array<{ sensorType: string; sampleCount: number; firstDeviceTimestampNs: number; lastDeviceTimestampNs: number; lastSensorAccuracy?: number }> };
      if (
        accepted.type !== "samples.accepted"
        || updatedDelta.type !== "session.delta"
        || updatedDelta.sampleCount !== 8
        || updatedDelta.rawSampleCount !== 8
        || updatedDelta.droppedSampleCount !== 1
        || updatedDelta.trackPoints.length !== 4
        || updatedDelta.trackPoints[0].deviceTimestampNs !== 4
        || updatedDelta.trackPoints[1].lat !== 31.2301
        || updatedDelta.trackPoints[2].lng !== 121.4703
        || updatedDelta.trackPoints[3].lng !== 121.47
        || updatedDelta.relativePoints.length !== 2
        || updatedDelta.relativePoints[1].xM !== 0.2
        || updatedDelta.posePoints.length !== 2
        || updatedDelta.posePoints[1].motionMode !== "walking"
        || updatedDelta.posePoints[1].frame !== "local-enu"
        || updatedDelta.motionEvents.length !== 1
        || updatedDelta.motionMode !== "walking"
        || typeof updatedDelta.trackPoints[0].altitudeM !== "number"
        || updatedDelta.trackPoints[0].altitudeSource !== "barometer"
        || typeof updatedDelta.latestAltitudeM !== "number"
        || updatedDelta.altitudeSource !== "barometer"
        || updatedDelta.latestSensors.length !== 3
        || updatedDelta.sensorStats.length !== 3
        || updatedDelta.sensorStats.some((item) => item.sampleCount < 1)
      ) {
        throw new Error("Unexpected realtime session update");
      }
      const rawReplay = await (await fetch(`http://127.0.0.1:8787/api/sessions/${session.sessionId}/raw`)).json() as { totalSamples: number; retainedSamples: number; maxRetainedSamples: number };
      if (rawReplay.totalSamples !== 8 || rawReplay.retainedSamples !== 8 || rawReplay.maxRetainedSamples !== 1024) throw new Error("Unexpected raw replay buffer");
      dashboard.close();
      device.close();
      console.log("API and WebSocket smoke passed", { routes: routes.length, points: 4, dropped: 1, altitude: "barometer" });
      process.exitCode = 0;
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await Bun.sleep(100);
    }
  }
} finally {
  child.kill();
}
