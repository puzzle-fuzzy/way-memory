const sourceSessionId = process.argv.slice(2).find(Boolean)?.replace(/^['"]|['"]$/g, "");
const baseUrl = Bun.env.WAY_MEMORY_API_URL ?? "http://127.0.0.1:8787";
if (!sourceSessionId) throw new Error("Usage: bun run scripts/replay-session.ts <session-id>");

const dashboardToken = Bun.env.WAY_MEMORY_DASHBOARD_TOKEN?.trim();
const deviceToken = Bun.env.WAY_MEMORY_DEVICE_TOKEN?.trim();
if ((dashboardToken && !deviceToken) || (!dashboardToken && deviceToken)) {
  throw new Error("WAY_MEMORY_DASHBOARD_TOKEN and WAY_MEMORY_DEVICE_TOKEN must be supplied together");
}
const apiUrl = new URL(baseUrl);
const localHttp = apiUrl.protocol === "http:" && ["127.0.0.1", "localhost"].includes(apiUrl.hostname);
if ((dashboardToken || deviceToken) && apiUrl.protocol !== "https:" && !localHttp) {
  throw new Error("Replay access tokens require an HTTPS WAY_MEMORY_API_URL outside localhost");
}

const request = async (path: string, init: RequestInit | undefined, token?: string) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
  return response.json() as Promise<any>;
};

const source = await request(`/api/sessions/${encodeURIComponent(sourceSessionId)}/raw`, undefined, dashboardToken) as {
  samples: unknown[];
  retainedSamples: number;
};
const target = await request("/api/sessions", {
  method: "POST",
  body: JSON.stringify({ deviceId: `replay:${sourceSessionId}`, mode: "learning" }),
}, deviceToken) as { sessionId: string };
for (let offset = 0; offset < source.samples.length; offset += 500) {
  await request(`/api/sessions/${target.sessionId}/samples`, {
    method: "POST",
    body: JSON.stringify({ samples: source.samples.slice(offset, offset + 500) }),
  }, deviceToken);
}
const replayed = await request(`/api/sessions/${target.sessionId}/stop`, { method: "POST" }, deviceToken) as { sampleCount: number; rawSampleCount: number; poseTrack: unknown[]; status: string };
if (replayed.status !== "stopped") throw new Error(`stop did not change session state: ${replayed.status}`);
console.log("Session replay completed", {
  sourceSessionId,
  targetSessionId: target.sessionId,
  retainedSamples: source.retainedSamples,
  replayedSamples: replayed.sampleCount,
  posePoints: replayed.poseTrack.length,
});
