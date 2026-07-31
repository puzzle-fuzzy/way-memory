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
      console.log("API smoke passed", { routes: routes.length });
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
