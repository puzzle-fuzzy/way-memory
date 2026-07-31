import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

const cwd = process.cwd();
const port = 8862;
const dbPath = resolve(cwd, ".data/retention-check.sqlite");
await rm(dbPath, { force: true });
await rm(`${dbPath}-wal`, { force: true });
await rm(`${dbPath}-shm`, { force: true });

const baseUrl = `http://127.0.0.1:${port}`;
const env = { ...process.env, PORT: String(port), WAY_MEMORY_RETENTION_DAYS: "1", WAY_MEMORY_DB_PATH: dbPath };
const startApi = () => Bun.spawn(["bun", "run", "services/api/src/index.ts"], { cwd, env, stdout: "pipe", stderr: "pipe" });
const waitForHealth = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // The child process is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("retention API did not start");
};
const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, init);
  return { response, body: await response.json() as Record<string, any> };
};

let child: Bun.Subprocess | undefined;
try {
  child = startApi();
  await waitForHealth();
  const session = await json("/api/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "retention-check", mode: "learning" }),
  });
  if (session.response.status !== 201) throw new Error("retention session creation failed");
  const sessionId = session.body.sessionId as string;
  const stopped = await json(`/api/sessions/${sessionId}/stop`, { method: "POST" });
  if (stopped.response.status !== 200) throw new Error("retention session stop failed");
  child.kill();
  await child.exited;

  const database = new Database(dbPath);
  database.query("UPDATE session_snapshots SET updated_at = ? WHERE session_id = ?").run("1970-01-01T00:00:00.000Z", sessionId);
  database.close();

  child = startApi();
  await waitForHealth();
  const sessions = await json("/api/sessions");
  if (sessions.response.status !== 200 || sessions.body.some((item: { sessionId: string }) => item.sessionId === sessionId)) {
    throw new Error("expired session was restored after restart");
  }
  console.log("Retention smoke passed", { retentionDays: 1, expiredSessionRemoved: true });
} finally {
  child?.kill();
  if (child) await child.exited;
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
}
