const baseUrl = (Bun.env.WAY_MEMORY_API_URL ?? "http://101.35.246.159").replace(/\/$/, "");
let sessionId: string | undefined;

const request = async (path: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
  return response.json() as Promise<any>;
};

const pose = (timestamp: number, x: number, flags: string[]) => ({
  deviceTimestampNs: timestamp,
  xM: x,
  yM: 0,
  zM: 0,
  velocityXMps: 1,
  velocityYMps: 0,
  velocityZMps: 0,
  accuracyM: 0.7,
  confidence: 0.9,
  source: "fused",
  frame: "local-enu",
  sourceFlags: flags,
  motionMode: "walking",
  stationary: false,
});

try {
  const session = await request("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ deviceId: `public-closure-${Date.now()}`, mode: "learning" }),
  }) as { sessionId: string };
  sessionId = session.sessionId;
  const samples = Array.from({ length: 1_205 }, (_, index) => {
    const timestamp = index + 1;
    const x = index < 300 ? index / 30 : 1;
    const isReturn = index === 1_204;
    return {
      sampleId: `public-long-${sessionId}-${timestamp}`,
      deviceTimestampNs: timestamp,
      sensorType: "pose",
      values: [x, 0, 0],
      pose: pose(timestamp, isReturn ? 1 : x, ["imu", "visual-aligned", ...(isReturn ? ["loop-closure"] : [])]),
    };
  });
  for (let offset = 0; offset < samples.length; offset += 500) {
    await request(`/api/sessions/${sessionId}/samples`, {
      method: "POST",
      body: JSON.stringify({ samples: samples.slice(offset, offset + 500) }),
    });
  }
  const restored = await request(`/api/sessions/${sessionId}?view=integrity`) as {
    closure: { status: string; adjusted: boolean; anchor?: { deviceTimestampNs: number }; travelledM?: number; correction?: { startTimestampNs: number } };
    posePointCount: number;
    latestPose?: { xM: number };
    latestCorrectedPose?: { xM: number };
  };
  if (
    restored.closure.status !== "closed"
    || !restored.closure.adjusted
    || restored.closure.anchor?.deviceTimestampNs !== 1
    || (restored.closure.travelledM ?? 0) < 8
    || restored.closure.correction?.startTimestampNs !== 1
    || restored.posePointCount !== 1_200
    || restored.latestPose?.xM !== 1
    || restored.latestCorrectedPose?.xM !== 0
  ) throw new Error("public long closure assertion failed");
  console.log("Public long closure smoke passed", {
    sessionId,
    retainedPosePoints: restored.posePointCount,
    travelledM: restored.closure.travelledM,
    anchorTimestampNs: restored.closure.anchor?.deviceTimestampNs,
  });
} finally {
  if (sessionId) {
    await request(`/api/sessions/${sessionId}/stop`, { method: "POST" }).catch(() => undefined);
  }
}
