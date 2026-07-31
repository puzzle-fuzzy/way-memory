const [sourceSessionId] = process.argv.slice(2);
const baseUrl = Bun.env.WAY_MEMORY_API_URL ?? "http://127.0.0.1:8787";
if (!sourceSessionId) throw new Error("Usage: bun run scripts/replay-session.ts <session-id>");

const request = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
  return response.json() as Promise<any>;
};

const source = await request(`/api/sessions/${encodeURIComponent(sourceSessionId)}/raw`) as {
  samples: unknown[];
  retainedSamples: number;
};
const target = await request("/api/sessions", {
  method: "POST",
  body: JSON.stringify({ deviceId: `replay:${sourceSessionId}`, mode: "learning" }),
}) as { sessionId: string };
for (let offset = 0; offset < source.samples.length; offset += 500) {
  await request(`/api/sessions/${target.sessionId}/samples`, {
    method: "POST",
    body: JSON.stringify({ samples: source.samples.slice(offset, offset + 500) }),
  });
}
const replayed = await request(`/api/sessions/${target.sessionId}/stop`, { method: "POST" }) as { sampleCount: number; rawSampleCount: number; poseTrack: unknown[]; status: string };
if (replayed.status !== "stopped") throw new Error(`stop did not change session state: ${replayed.status}`);
console.log("Session replay completed", {
  sourceSessionId,
  targetSessionId: target.sessionId,
  retainedSamples: source.retainedSamples,
  replayedSamples: replayed.sampleCount,
  posePoints: replayed.poseTrack.length,
});
