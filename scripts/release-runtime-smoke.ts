import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const releaseRoot = resolve(repositoryRoot, ".release", "way-memory");
const apiPath = resolve(releaseRoot, "api", "way-memory-api.js");
const port = Number(Bun.env.WAY_MEMORY_RELEASE_SMOKE_PORT ?? 18_787);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid_release_smoke_port");

const probeDirectory = await mkdtemp(join(tmpdir(), "way-memory-release-smoke-"));
const databasePath = join(probeDirectory, "way-memory.sqlite");
const process = Bun.spawn(["bun", apiPath], {
  cwd: releaseRoot,
  env: {
    ...Bun.env,
    PORT: String(port),
    WAY_MEMORY_ENV: "test",
    WAY_MEMORY_DB_PATH: databasePath,
  },
  stdout: "ignore",
  stderr: "ignore",
});

async function waitForHealth(path: string): Promise<number> {
  const url = `http://127.0.0.1:${port}${path}`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await Bun.sleep(200);
    try {
      const response = await fetch(url);
      if (response.status === 200) return response.status;
    } catch {
      // The server may still be binding its socket.
    }
  }
  throw new Error(`release_api_health_timeout: ${url}`);
}

try {
  const serviceHealth = await waitForHealth("/health");
  const publicHealth = await waitForHealth("/api/health");
  console.log(`release API runtime health: ${serviceHealth} / ${publicHealth}`);
} finally {
  process.kill();
  await process.exited;
  await rm(probeDirectory, { recursive: true, force: true });
}
