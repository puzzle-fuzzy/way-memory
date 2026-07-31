import type {
  CreateSessionInput,
  DeviceSnapshot,
  LiveSensorSnapshot,
  ObservationSession,
  RelativeMotionPoint,
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

const MAX_SESSIONS = 20;
const MAX_TRACK_POINTS = 500;
const MAX_RELATIVE_TRACK_POINTS = 500;
const MAX_LIVE_SENSORS = 32;
const MAX_SENSOR_VALUES = 16;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_ROUTE_ID_LENGTH = 128;
const DUPLICATE_LOCATION_DISTANCE_M = 0.5;
const DUPLICATE_LOCATION_WINDOW_NS = 2_000_000_000;
const MAX_WALKING_SPEED_MPS = 15;

type SessionRuntime = {
  lastLocation?: {
    lat: number;
    lng: number;
    accuracyM: number;
    deviceTimestampNs: number;
  };
};

const sessionRuntime = new Map<string, SessionRuntime>();

type RealtimeClient = {
  role: "device" | "dashboard";
  deviceId?: string;
  sessionId?: string;
};

const parseJson = async <T>(request: Request): Promise<T | null> => {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) return null;
  try {
    const reader = request.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_JSON_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body)) as T;
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
    linear_acceleration: "linear-acceleration",
  }[normalized] ?? normalized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const finiteNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizeLocation = (value: unknown): SensorSample["location"] | null => {
  if (!isRecord(value)) return null;
  const lat = finiteNumber(value.lat);
  const lng = finiteNumber(value.lng);
  if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const accuracyM = value.accuracyM === undefined ? undefined : finiteNumber(value.accuracyM);
  const altitudeM = value.altitudeM === undefined ? undefined : finiteNumber(value.altitudeM);
  if (value.accuracyM !== undefined && (accuracyM === null || accuracyM < 0 || accuracyM > 10_000)) return null;
  if (value.altitudeM !== undefined && altitudeM === null) return null;
  return {
    lat,
    lng,
    ...(accuracyM === undefined || accuracyM === null ? {} : { accuracyM }),
    ...(altitudeM === undefined || altitudeM === null ? {} : { altitudeM }),
  };
};

const normalizeRelativePosition = (value: unknown): SensorSample["relativePosition"] | null => {
  if (!isRecord(value)) return null;
  const xM = finiteNumber(value.xM);
  const yM = finiteNumber(value.yM);
  const zM = finiteNumber(value.zM);
  const accuracyM = value.accuracyM === undefined ? undefined : finiteNumber(value.accuracyM);
  if (xM === null || yM === null || zM === null) return null;
  if ([xM, yM, zM].some((coordinate) => Math.abs(coordinate) > 100_000)) return null;
  if (value.accuracyM !== undefined && (accuracyM === null || accuracyM < 0 || accuracyM > 100_000)) return null;
  return {
    xM,
    yM,
    zM,
    ...(accuracyM === undefined || accuracyM === null ? {} : { accuracyM }),
  };
};

const normalizeSensorSample = (value: unknown): SensorSample | null => {
  if (!isRecord(value) || typeof value.sensorType !== "string") return null;
  const sensorType = normalizeSensorType(value.sensorType.trim());
  const deviceTimestampNs = finiteNumber(value.deviceTimestampNs);
  const rawValues = value.values;
  if (!sensorType || sensorType.length > 64 || deviceTimestampNs === null || !Number.isSafeInteger(deviceTimestampNs) || deviceTimestampNs <= 0) return null;
  if (!Array.isArray(rawValues) || rawValues.length > MAX_SENSOR_VALUES) return null;
  const values = rawValues.map(finiteNumber);
  if (values.some((item) => item === null)) return null;
  const accuracy = value.accuracy === undefined ? undefined : finiteNumber(value.accuracy);
  if (value.accuracy !== undefined && (accuracy === null || accuracy < 0 || accuracy > 10_000)) return null;
  const location = value.location === undefined ? undefined : normalizeLocation(value.location);
  if (value.location !== undefined && location === null) return null;
  const relativePosition = value.relativePosition === undefined ? undefined : normalizeRelativePosition(value.relativePosition);
  if (value.relativePosition !== undefined && relativePosition === null) return null;
  return {
    deviceTimestampNs,
    sensorType,
    values: values as number[],
    ...(accuracy === undefined || accuracy === null ? {} : { accuracy }),
    ...(location ? { location } : {}),
    ...(relativePosition ? { relativePosition } : {}),
  };
};

const haversineDistanceM = (left: { lat: number; lng: number }, right: { lat: number; lng: number }) => {
  const earthRadiusM = 6_371_000;
  const toRadians = (value: number) => value * Math.PI / 180;
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);
  const dLat = lat2 - lat1;
  const dLng = toRadians(right.lng - left.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
};

const shouldDropLocation = (session: ObservationSession, location: NonNullable<SensorSample["location"]>, deviceTimestampNs: number) => {
  const runtime = sessionRuntime.get(session.sessionId);
  const previous = runtime?.lastLocation;
  if (!previous) return false;
  if (deviceTimestampNs <= previous.deviceTimestampNs) return true;
  const elapsedNs = deviceTimestampNs - previous.deviceTimestampNs;
  const distanceM = haversineDistanceM(previous, location);
  if (distanceM <= DUPLICATE_LOCATION_DISTANCE_M && elapsedNs <= DUPLICATE_LOCATION_WINDOW_NS) return true;
  const elapsedSeconds = elapsedNs / 1_000_000_000;
  const uncertaintyM = previous.accuracyM + Math.max(0.1, location.accuracyM ?? 50);
  return elapsedSeconds <= 10 && distanceM > Math.max(120, uncertaintyM + elapsedSeconds * MAX_WALKING_SPEED_MPS);
};

const rememberLocation = (session: ObservationSession, location: NonNullable<SensorSample["location"]>, deviceTimestampNs: number) => {
  const runtime = sessionRuntime.get(session.sessionId) ?? {};
  runtime.lastLocation = {
    lat: location.lat,
    lng: location.lng,
    accuracyM: Math.max(0.1, location.accuracyM ?? 50),
    deviceTimestampNs,
  };
  sessionRuntime.set(session.sessionId, runtime);
};

const pruneStoppedSessions = () => {
  const stopped = [...sessions.values()]
    .filter((session) => session.status === "stopped")
    .sort((left, right) => (left.lastReceivedAt ?? left.startedAt).localeCompare(right.lastReceivedAt ?? right.startedAt));
  while (sessions.size >= MAX_SESSIONS && stopped.length) {
    const session = stopped.shift();
    if (!session) break;
    sessions.delete(session.sessionId);
    altitudeReferences.delete(session.sessionId);
    sessionRuntime.delete(session.sessionId);
  }
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
    if (session.latestSensors.length >= MAX_LIVE_SENSORS) session.latestSensors.shift();
    session.latestSensors.push(snapshot);
    return;
  }
  const existing = session.latestSensors[existingIndex];
  session.latestSensors[existingIndex] = {
    ...snapshot,
    sampleCount: existing.sampleCount + 1,
  };
};

const toTrackPoint = (session: ObservationSession, location: NonNullable<SensorSample["location"]>, deviceTimestampNs: number): TrackPoint => {
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
    deviceTimestampNs,
    lat: location.lat,
    lng: location.lng,
    accuracyM,
    confidence: clamp(1 - accuracyM / 50, 0, 1),
    source: "fused",
    ...(typeof altitudeM === "number" && altitudeSource ? { altitudeM, altitudeSource } : {}),
  };
};

const toRelativeMotionPoint = (relativePosition: NonNullable<SensorSample["relativePosition"]>, deviceTimestampNs: number): RelativeMotionPoint => {
  const accuracyM = Math.max(0.1, relativePosition.accuracyM ?? 5);
  return {
    deviceTimestampNs,
    xM: relativePosition.xM,
    yM: relativePosition.yM,
    zM: relativePosition.zM,
    accuracyM,
    confidence: clamp(1 - accuracyM / 20, 0, 1),
    source: "inertial",
  };
};

const createSession = (input: CreateSessionInput): ObservationSession => {
  pruneStoppedSessions();
  if (sessions.size >= MAX_SESSIONS) throw new Error("session_limit");
  const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH) : "";
  if (!deviceId) throw new Error("invalid_session");
  const routeId = typeof input.routeId === "string" ? input.routeId.trim().slice(0, MAX_ROUTE_ID_LENGTH) || undefined : undefined;
  const session: ObservationSession = {
    sessionId: crypto.randomUUID(),
    deviceId,
    mode: input.mode === "navigation" ? "navigation" : "learning",
    routeId,
    startedAt: new Date().toISOString(),
    sampleCount: 0,
    droppedSampleCount: 0,
    track: [],
    relativeTrack: [],
    latestSensors: [],
    status: "active",
  };
  sessions.set(session.sessionId, session);
  altitudeReferences.set(session.sessionId, {});
  sessionRuntime.set(session.sessionId, {});
  device.connected = true;
  device.lastSeen = session.startedAt;
  return session;
};

const acceptSamples = (session: ObservationSession, rawSamples: unknown[]) => {
  const receivedAt = new Date().toISOString();
  const samples = rawSamples
    .map(normalizeSensorSample)
    .filter((sample): sample is SensorSample => sample !== null)
    .sort((left, right) => left.deviceTimestampNs - right.deviceTimestampNs);
  session.droppedSampleCount += rawSamples.length - samples.length;
  session.sampleCount += samples.length;
  if (samples.length) {
    session.lastReceivedAt = receivedAt;
    session.lastSampleAt = receivedAt;
  }
  for (const sample of samples) {
    const sensorType = normalizeSensorType(sample.sensorType);
    if (sample.relativePosition) {
      const motionPoint = toRelativeMotionPoint(sample.relativePosition, sample.deviceTimestampNs);
      session.relativeTrack.push(motionPoint);
      session.latestRelativePosition = motionPoint;
    }
    if (sample.location) {
      if (shouldDropLocation(session, sample.location, sample.deviceTimestampNs)) {
        session.droppedSampleCount += 1;
        continue;
      }
      const point = toTrackPoint(session, sample.location, sample.deviceTimestampNs);
      session.latestLocation = sample.location;
      session.track.push(point);
      rememberLocation(session, sample.location, sample.deviceTimestampNs);
      upsertSensor(session, sample, receivedAt, "gnss");
    } else {
      if (sensorType === "barometer") updateBarometerAltitude(session, sample);
      upsertSensor(session, sample, receivedAt, sensorType);
    }
  }
  if (session.track.length > MAX_TRACK_POINTS) session.track = session.track.slice(-MAX_TRACK_POINTS);
  if (session.relativeTrack.length > MAX_RELATIVE_TRACK_POINTS) session.relativeTrack = session.relativeTrack.slice(-MAX_RELATIVE_TRACK_POINTS);
  device.lastSeen = session.lastReceivedAt ?? device.lastSeen;
  device.connected = true;
  return { accepted: samples.length, dropped: session.droppedSampleCount, session };
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
      if (!input || typeof input.deviceId !== "string" || (input.mode !== "learning" && input.mode !== "navigation")) return json({ error: "invalid_session" }, { status: 400 });
      let session: ObservationSession;
      try {
        session = createSession(input);
      } catch (error) {
        if (error instanceof Error && error.message === "session_limit") return json({ error: "session_limit" }, { status: 429 });
        if (error instanceof Error && error.message === "invalid_session") return json({ error: "invalid_session" }, { status: 400 });
        throw error;
      }
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
        sessionRuntime.delete(session.sessionId);
        device.connected = false;
        return json(session);
      }
      if (url.pathname.endsWith("/samples") && request.method === "POST") {
        const body = await parseJson<{ samples?: unknown[] }>(request);
        const samples = body?.samples;
        if (!Array.isArray(samples) || samples.length > 500) return json({ error: "invalid_samples" }, { status: 400 });
        if (session.status !== "active") return json({ error: "session_stopped" }, { status: 409 });
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
      if (String(raw).length > MAX_JSON_BYTES) {
        ws.send(JSON.stringify({ type: "error", error: "message_too_large" }));
        return;
      }
      let message: { type?: string; deviceId?: string; mode?: CreateSessionInput["mode"]; routeId?: string; sessionId?: string; samples?: unknown[] };
      try {
        message = JSON.parse(String(raw));
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "invalid_json" }));
        return;
      }

      if (ws.data.role === "device" && message.type === "session.start") {
        let session: ObservationSession;
        try {
          session = createSession({
            deviceId: message.deviceId ?? ws.data.deviceId ?? "android-device",
            mode: message.mode ?? "learning",
            routeId: message.routeId,
          });
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", error: error instanceof Error && error.message === "session_limit" ? "session_limit" : "session_start_failed" }));
          return;
        }
        ws.data.sessionId = session.sessionId;
        ws.send(JSON.stringify({ type: "session.started", session }));
        publishSession(server, session);
        return;
      }

      if (ws.data.role === "device" && message.type === "samples") {
        const session = getSession(message.sessionId ?? ws.data.sessionId ?? "");
        const samples = message.samples;
        if (!session || session.status !== "active" || !Array.isArray(samples) || samples.length > 500) {
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
          sessionRuntime.delete(session.sessionId);
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
        sessionRuntime.delete(session.sessionId);
        device.connected = false;
        publishSession(server, session);
      }
    },
  },
});

console.log(`way-memory API listening on ${server.url}`);
