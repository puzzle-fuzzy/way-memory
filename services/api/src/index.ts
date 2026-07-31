import type {
  CreateSessionInput,
  DeviceSnapshot,
  LiveSensorSnapshot,
  ObservationSession,
  RouteSummary,
  SensorSample,
  TrackPoint,
} from "@way-memory/contracts";

const port = Number(Bun.env.PORT ?? 8787);

const device: DeviceSnapshot = {
  deviceId: "demo-pixel-01",
  label: "演示手机 · Android",
  connected: false,
  batteryPercent: 82,
  temperatureC: 31.4,
  lastSeen: new Date().toISOString(),
  locationQuality: "high",
  sensors: [
    { type: "gnss", label: "GNSS 定位", status: "ready", frequencyHz: 1 },
    { type: "accelerometer", label: "加速度计", status: "ready", frequencyHz: 50 },
    { type: "gyroscope", label: "陀螺仪", status: "ready", frequencyHz: 50 },
    { type: "magnetometer", label: "磁力计", status: "limited", note: "建议校准" },
    { type: "barometer", label: "气压计", status: "ready", frequencyHz: 10 },
    { type: "camera", label: "视觉采集", status: "ready", frequencyHz: 5 },
    { type: "depth", label: "深度感知", status: "unavailable", note: "设备不支持" },
  ],
};

const track = [
  [31.23041, 121.47370], [31.23058, 121.47402], [31.23076, 121.47428],
  [31.23104, 121.47455], [31.23132, 121.47440], [31.23151, 121.47408],
  [31.23175, 121.47382], [31.23203, 121.47398], [31.23230, 121.47426],
].map(([lat, lng], index) => ({
  lat, lng, accuracyM: index > 5 ? 4.8 : 3.2,
  confidence: index > 5 ? 0.86 : 0.96,
  source: index === 4 ? "manual" : "fused",
} as const));

const route: RouteSummary = {
  routeId: "route-home-metro",
  name: "家 · 地铁站入口",
  status: "verified",
  distanceM: 486,
  observations: 4,
  nodes: 7,
  confidence: 0.91,
  updatedAt: "今天 09:42",
  track,
};

const sessions = new Map<string, ObservationSession>();
const altitudeReferences = new Map<string, { gnssM?: number; pressureHpa?: number }>();

type RealtimeClient = {
  role: "device" | "dashboard";
  deviceId?: string;
  sessionId?: string;
};

const parseJson = async <T>(request: Request): Promise<T | null> => {
  try {
    return await request.json() as T;
  } catch {
    return null;
  }
};

const getSession = (sessionId: string) => sessions.get(sessionId);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeSensorType = (sensorType: string) => {
  const normalized = sensorType.split(".").at(-1)?.replaceAll("-", "_") ?? sensorType;
  return {
    magnetic_field: "magnetometer",
    pressure: "barometer",
    rotation_vector: "rotation-vector",
  }[normalized] ?? normalized;
};

const pressureToRelativeAltitudeM = (pressureHpa: number, referenceHpa: number) =>
  44330 * (1 - Math.pow(pressureHpa / referenceHpa, 0.190294957));

const updateBarometerAltitude = (session: ObservationSession, sample: SensorSample) => {
  if (session.altitudeSource === "gnss") return;
  const pressureHpa = sample.values[0];
  if (typeof pressureHpa !== "number" || !Number.isFinite(pressureHpa) || pressureHpa < 300 || pressureHpa > 1100) return;
  const reference = altitudeReferences.get(session.sessionId) ?? {};
  reference.pressureHpa ??= pressureHpa;
  altitudeReferences.set(session.sessionId, reference);
  session.latestAltitudeM = pressureToRelativeAltitudeM(pressureHpa, reference.pressureHpa);
  session.altitudeSource = "barometer";
};

const upsertSensor = (
  session: ObservationSession,
  sample: SensorSample,
  receivedAt: string,
  sensorType = normalizeSensorType(sample.sensorType),
) => {
  const snapshot: LiveSensorSnapshot = {
    sensorType,
    values: sample.values.slice(0, 16),
    accuracy: sample.accuracy ?? sample.location?.accuracyM,
    sampleCount: 1,
    lastDeviceTimestampNs: sample.deviceTimestampNs,
    lastReceivedAt: receivedAt,
  };
  const existingIndex = session.latestSensors.findIndex((item) => item.sensorType === sensorType);
  if (existingIndex === -1) {
    session.latestSensors.push(snapshot);
    return;
  }
  const existing = session.latestSensors[existingIndex];
  session.latestSensors[existingIndex] = {
    ...snapshot,
    sampleCount: existing.sampleCount + 1,
  };
};

const toTrackPoint = (session: ObservationSession, location: NonNullable<SensorSample["location"]>): TrackPoint => {
  const accuracyM = Math.max(0.1, location.accuracyM ?? 50);
  const reference = altitudeReferences.get(session.sessionId) ?? {};
  let altitudeM = session.latestAltitudeM;
  let altitudeSource = session.altitudeSource;
  if (typeof location.altitudeM === "number" && Number.isFinite(location.altitudeM)) {
    reference.gnssM ??= location.altitudeM;
    altitudeM = location.altitudeM - reference.gnssM;
    altitudeSource = "gnss";
    session.latestAltitudeM = altitudeM;
    session.altitudeSource = altitudeSource;
    altitudeReferences.set(session.sessionId, reference);
  }
  return {
    lat: location.lat,
    lng: location.lng,
    accuracyM,
    confidence: clamp(1 - accuracyM / 50, 0, 1),
    source: "fused",
    ...(typeof altitudeM === "number" && altitudeSource ? { altitudeM, altitudeSource } : {}),
  };
};

const createSession = (input: CreateSessionInput): ObservationSession => {
  const session: ObservationSession = {
    sessionId: crypto.randomUUID(),
    deviceId: input.deviceId,
    mode: input.mode,
    routeId: input.routeId,
    startedAt: new Date().toISOString(),
    sampleCount: 0,
    track: [],
    latestSensors: [],
    status: "active",
  };
  sessions.set(session.sessionId, session);
  altitudeReferences.set(session.sessionId, {});
  device.connected = true;
  device.lastSeen = session.startedAt;
  return session;
};

const acceptSamples = (session: ObservationSession, samples: SensorSample[]) => {
  const receivedAt = new Date().toISOString();
  session.sampleCount += samples.length;
  session.lastReceivedAt = receivedAt;
  session.lastSampleAt = receivedAt;
  for (const sample of samples) {
    if (normalizeSensorType(sample.sensorType) === "barometer") updateBarometerAltitude(session, sample);
  }
  for (const sample of samples) {
    if (sample.location) {
      const point = toTrackPoint(session, sample.location);
      session.latestLocation = sample.location;
      session.track.push(point);
      upsertSensor(session, sample, receivedAt, "gnss");
    } else {
      upsertSensor(session, sample, receivedAt);
    }
  }
  if (session.track.length > 500) session.track = session.track.slice(-500);
  device.lastSeen = session.lastReceivedAt;
  device.connected = true;
  return { accepted: samples.length, session };
};

const publishSession = (server: Bun.Server<RealtimeClient>, session: ObservationSession) => {
  server.publish("dashboard", JSON.stringify({ type: "session.updated", session }));
};

const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, {
  ...init,
  headers: { "access-control-allow-origin": "*", ...init.headers },
});

const server = Bun.serve<RealtimeClient>({
  port,
  hostname: "0.0.0.0",
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/realtime") {
      const role = url.searchParams.get("role");
      if (role !== "device" && role !== "dashboard") return new Response("Invalid realtime role", { status: 400 });
      const upgraded = server.upgrade(request, {
        data: {
          role,
          deviceId: url.searchParams.get("deviceId") ?? undefined,
        },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS" } });
    if (url.pathname === "/health") return json({ ok: true, service: "way-memory-api", time: new Date().toISOString() });
    if (url.pathname === "/api/devices") return json([device]);
    if (url.pathname === "/api/routes") return json([route]);
    if (url.pathname === "/api/routes/route-home-metro") return json(route);
    if (url.pathname === "/api/sessions" && request.method === "GET") {
      return json([...sessions.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)));
    }
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const input = await parseJson<CreateSessionInput>(request);
      if (!input?.deviceId || !input.mode) return json({ error: "invalid_session" }, { status: 400 });
      const session = createSession(input);
      return json(session, { status: 201 });
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/samples|\/stop)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const session = getSession(sessionId);
      if (!session) return json({ error: "session_not_found" }, { status: 404 });
      if (url.pathname.endsWith("/stop") && request.method === "POST") {
        session.status = "stopped";
        session.lastReceivedAt = new Date().toISOString();
        altitudeReferences.delete(session.sessionId);
        device.connected = false;
        return json(session);
      }
      if (url.pathname.endsWith("/samples") && request.method === "POST") {
        const body = await parseJson<{ samples?: SensorSample[] }>(request);
        const samples = body?.samples;
        if (!Array.isArray(samples) || samples.length > 500) return json({ error: "invalid_samples" }, { status: 400 });
        return json(acceptSamples(session, samples));
      }
      if (request.method === "GET") return json(session);
    }
    return json({ error: "not_found" }, { status: 404 });
  },
  websocket: {
    idleTimeout: 120,
    open(ws) {
      if (ws.data.role === "dashboard") ws.subscribe("dashboard");
    },
    message(ws, raw) {
      let message: { type?: string; deviceId?: string; mode?: CreateSessionInput["mode"]; routeId?: string; sessionId?: string; samples?: SensorSample[] };
      try {
        message = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
        return;
      }

      if (ws.data.role === "device" && message.type === "session.start") {
        const session = createSession({
          deviceId: message.deviceId ?? ws.data.deviceId ?? "android-device",
          mode: message.mode ?? "learning",
          routeId: message.routeId,
        });
        ws.data.sessionId = session.sessionId;
        ws.send(JSON.stringify({ type: "session.started", session }));
        publishSession(server, session);
        return;
      }

      if (ws.data.role === "device" && message.type === "samples") {
        const session = getSession(message.sessionId ?? ws.data.sessionId ?? "");
        const samples = message.samples;
        if (!session || !Array.isArray(samples) || samples.length > 500) {
          ws.send(JSON.stringify({ type: "error", error: "invalid_samples" }));
          return;
        }
        const result = acceptSamples(session, samples);
        ws.send(JSON.stringify({ type: "samples.accepted", accepted: result.accepted, sampleCount: session.sampleCount }));
        publishSession(server, session);
        return;
      }

      if (ws.data.role === "device" && message.type === "session.stop") {
        const session = getSession(message.sessionId ?? ws.data.sessionId ?? "");
        if (session) {
          session.status = "stopped";
          session.lastReceivedAt = new Date().toISOString();
          altitudeReferences.delete(session.sessionId);
          device.connected = false;
          publishSession(server, session);
        }
        return;
      }

      ws.send(JSON.stringify({ type: "error", error: "unsupported_message" }));
    },
    close(ws) {
      const session = getSession(ws.data.sessionId ?? "");
      if (session && session.status === "active") {
        session.status = "stopped";
        session.lastReceivedAt = new Date().toISOString();
        altitudeReferences.delete(session.sessionId);
        device.connected = false;
        publishSession(server, session);
      }
    },
  },
});

console.log(`way-memory API listening on ${server.url}`);
