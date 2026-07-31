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
          { deviceTimestampNs: 1, sensorType: "accelerometer", values: [0, 0, 9.8] },
          { deviceTimestampNs: 2, sensorType: "location", values: [], location: { lat: 31.23, lng: 121.47, accuracyM: 4 } },
        ],
      }));
      const accepted = await waitForMessage(device);
      const updated = await waitForMessage(dashboard);
      if (accepted.type !== "samples.accepted" || (updated.session as { sampleCount: number }).sampleCount !== 2) {
        throw new Error("Unexpected realtime session update");
      }
      dashboard.close();
      device.close();
      console.log("API and WebSocket smoke passed", { routes: routes.length, samples: 2 });
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
