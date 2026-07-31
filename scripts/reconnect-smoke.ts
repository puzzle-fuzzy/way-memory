import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const cwd = process.cwd();
const dbPath = resolve(cwd, ".data/reconnect-check.sqlite");
const files = [dbPath, `${dbPath}-shm`, `${dbPath}-wal`];
const baseUrl = "ws://127.0.0.1:8820/realtime";

const waitForOpen = (socket: WebSocket) => new Promise<void>((resolvePromise, reject) => {
  socket.addEventListener("open", () => resolvePromise(), { once: true });
  socket.addEventListener("error", () => reject(new Error("WebSocket open failed")), { once: true });
});

const waitForMessage = (socket: WebSocket) => new Promise<Record<string, any>>((resolvePromise, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket message timeout")), 2_000);
  socket.addEventListener("message", (event) => {
    clearTimeout(timeout);
    resolvePromise(JSON.parse(String(event.data)) as Record<string, any>);
  }, { once: true });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    reject(new Error("WebSocket error"));
  }, { once: true });
});

const startApi = () => Bun.spawn(["bun", "run", "services/api/src/index.ts"], {
  cwd,
  env: { ...process.env, PORT: "8820", WAY_MEMORY_DB_PATH: dbPath },
  stdout: "pipe",
  stderr: "pipe",
});

let api: ReturnType<typeof startApi> | undefined;
let first: WebSocket | undefined;
let second: WebSocket | undefined;
try {
  await Promise.all(files.map((path) => rm(path, { force: true })));
  api = startApi();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await (await fetch("http://127.0.0.1:8820/health")).json() as { ok: boolean }).ok) break;
    } catch {}
    await Bun.sleep(100);
  }

  first = new WebSocket(`${baseUrl}?role=device&deviceId=reconnect-check`);
  await waitForOpen(first);
  const startedMessage = waitForMessage(first);
  first.send(JSON.stringify({ type: "session.start", deviceId: "reconnect-check", mode: "learning" }));
  const started = await startedMessage;
  const sessionId = started.session?.sessionId as string | undefined;
  if (started.type !== "session.started" || !sessionId) throw new Error("session did not start");
  first.close(1000, "simulated network interruption");
  await Bun.sleep(250);

  second = new WebSocket(`${baseUrl}?role=device&deviceId=reconnect-check`);
  await waitForOpen(second);
  const resumedMessage = waitForMessage(second);
  second.send(JSON.stringify({ type: "session.resume", sessionId, deviceId: "reconnect-check" }));
  const resumed = await resumedMessage;
  if (resumed.type !== "session.resumed" || resumed.session?.sessionId !== sessionId) throw new Error("session did not resume");

  const acceptedMessage = waitForMessage(second);
  second.send(JSON.stringify({
    type: "samples",
    sessionId,
    samples: [{ deviceTimestampNs: 1, sensorType: "android.sensor.test", values: [1], sensorAccuracy: 3 }],
  }));
  const accepted = await acceptedMessage;
  if (accepted.type !== "samples.accepted" || accepted.accepted !== 1) throw new Error("resumed session did not accept samples");
  second.send(JSON.stringify({ type: "session.stop", sessionId }));
  console.log("Reconnect smoke passed", { sessionId, resumed: true, accepted: accepted.accepted });
} finally {
  first?.close();
  second?.close();
  if (api && !api.killed) api.kill();
  await api?.exited;
  await Promise.all(files.map((path) => rm(path, { force: true })));
}
