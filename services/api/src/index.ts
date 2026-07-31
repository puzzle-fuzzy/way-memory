import type {
  ClosureState,
  CreateSessionInput,
  DeviceSnapshot,
  LiveSensorSnapshot,
  MotionEvent,
  MotionMode,
  ObservationSession,
  PoseEstimate,
  RelativeMotionPoint,
  RouteSummary,
  SessionDelta,
  SensorSample,
  TrackPoint,
} from "@way-memory/contracts";
import { SessionStore } from "./sessionStore";

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
const MAX_POSE_TRACK_POINTS = 1_200;
const MAX_MOTION_EVENTS = 128;
const MAX_RAW_REPLAY_SAMPLES = 1_024;
const MAX_SENSOR_STATS = 128;
const MAX_LIVE_SENSORS = 32;
const MAX_SENSOR_VALUES = 16;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_ROUTE_ID_LENGTH = 128;
const MAX_SAMPLE_ID_LENGTH = 128;
const MAX_SEEN_SAMPLE_IDS = 8_192;
const SESSION_RESUME_GRACE_MS = 2 * 60 * 1_000;
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
  startPose?: PoseEstimate;
  lastPose?: PoseEstimate;
  travelledM?: number;
  rawSamples?: SensorSample[];
  seenSampleIds?: Set<string>;
  seenSampleIdOrder?: string[];
};

const sessionRuntime = new Map<string, SessionRuntime>();
const sessionResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_PERSISTED_SESSIONS = 100;
const sessionStore = new SessionStore(Bun.env.WAY_MEMORY_DB_PATH ?? ".data/way-memory.sqlite");
const dirtySessionIds = new Set<string>();

const persistSession = (session: ObservationSession) => {
  const runtime = sessionRuntime.get(session.sessionId);
  sessionStore.save(session, runtime?.rawSamples ?? []);
  dirtySessionIds.delete(session.sessionId);
  sessionStore.prune(MAX_PERSISTED_SESSIONS);
};

const markSessionDirty = (session: ObservationSession) => {
  dirtySessionIds.add(session.sessionId);
};

const flushDirtySessions = () => {
  for (const sessionId of dirtySessionIds) {
    const session = sessions.get(sessionId);
    if (session) persistSession(session);
    else dirtySessionIds.delete(sessionId);
  }
};

for (const snapshot of sessionStore.load(MAX_PERSISTED_SESSIONS)) {
  // A restart cannot prove that a previously active capture ended cleanly.
  snapshot.session.sensorStats ??= [];
  snapshot.session.status = "stopped";
  sessions.set(snapshot.session.sessionId, snapshot.session);
  sessionRuntime.set(snapshot.session.sessionId, { rawSamples: snapshot.rawSamples });
}
sessionStore.prune(MAX_PERSISTED_SESSIONS);
const persistenceTimer = setInterval(flushDirtySessions, 2_000);
persistenceTimer.unref?.();

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

const cancelSessionResume = (sessionId: string) => {
  const timer = sessionResumeTimers.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  sessionResumeTimers.delete(sessionId);
};

const scheduleSessionStopAfterDisconnect = (session: ObservationSession) => {
  cancelSessionResume(session.sessionId);
  const timer = setTimeout(() => {
    sessionResumeTimers.delete(session.sessionId);
    const current = getSession(session.sessionId);
    if (!current || current.status !== "active") return;
    current.status = "stopped";
    current.lastReceivedAt = new Date().toISOString();
    altitudeReferences.delete(current.sessionId);
    device.connected = false;
    persistSession(current);
    publishSession(server, current);
  }, SESSION_RESUME_GRACE_MS);
  timer.unref?.();
  sessionResumeTimers.set(session.sessionId, timer);
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeSensorType = (sensorType: string) => {
  const normalized = sensorType.split(".").at(-1)?.replaceAll("-", "_") ?? sensorType;
  return {
    magnetic_field: "magnetometer",
    pressure: "barometer",
    game_rotation_vector: "rotation-vector",
    geomagnetic_rotation_vector: "rotation-vector",
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

const motionModes = new Set<MotionMode>(["stationary", "walking", "stairs", "elevator", "vehicle", "unknown"]);
const poseSources = new Set<PoseEstimate["source"]>(["imu", "gnss", "barometer", "visual", "fused"]);
const poseFrames = new Set(["local-enu", "arcore-local"]);

const normalizePose = (value: unknown): PoseEstimate | null => {
  if (!isRecord(value)) return null;
  const deviceTimestampNs = finiteNumber(value.deviceTimestampNs);
  const xM = finiteNumber(value.xM);
  const yM = finiteNumber(value.yM);
  const zM = finiteNumber(value.zM);
  const velocityXMps = finiteNumber(value.velocityXMps);
  const velocityYMps = finiteNumber(value.velocityYMps);
  const velocityZMps = finiteNumber(value.velocityZMps);
  const accuracyM = finiteNumber(value.accuracyM);
  const verticalAccuracyM = value.verticalAccuracyM === undefined ? undefined : finiteNumber(value.verticalAccuracyM);
  const confidence = finiteNumber(value.confidence);
  const source = value.source;
  const frame = value.frame === undefined ? "local-enu" : value.frame;
  const motionMode = value.motionMode;
  const sourceFlags = value.sourceFlags;
  if (
    deviceTimestampNs === null || !Number.isSafeInteger(deviceTimestampNs) || deviceTimestampNs <= 0
    || xM === null || yM === null || zM === null
    || velocityXMps === null || velocityYMps === null || velocityZMps === null
    || accuracyM === null || accuracyM < 0 || accuracyM > 100_000
    || confidence === null || confidence < 0 || confidence > 1
    || typeof source !== "string" || !poseSources.has(source as PoseEstimate["source"])
    || typeof frame !== "string" || !poseFrames.has(frame)
    || typeof motionMode !== "string" || !motionModes.has(motionMode as MotionMode)
    || !Array.isArray(sourceFlags) || sourceFlags.length > 16
    || sourceFlags.some((item) => typeof item !== "string" || item.length > 32)
    || typeof value.stationary !== "boolean"
  ) return null;
  if ([xM, yM, zM, velocityXMps, velocityYMps, velocityZMps].some((coordinate) => Math.abs(coordinate) > 100_000)) return null;
  return {
    deviceTimestampNs,
    xM,
    yM,
    zM,
    velocityXMps,
    velocityYMps,
    velocityZMps,
    accuracyM,
    ...(verticalAccuracyM === undefined || verticalAccuracyM === null ? {} : { verticalAccuracyM }),
    confidence,
    source: source as PoseEstimate["source"],
    frame: frame as NonNullable<PoseEstimate["frame"]>,
    sourceFlags: sourceFlags as string[],
    motionMode: motionMode as MotionMode,
    stationary: value.stationary,
  };
};

const motionEventTypes = new Set<MotionEvent["type"]>([
  "stationary-enter",
  "stationary-exit",
  "stairs-enter",
  "stairs-exit",
  "elevator-candidate",
  "elevator-exit",
  "loop-candidate",
  "loop-closed",
]);

const normalizeMotionEvent = (value: unknown): MotionEvent | null => {
  if (!isRecord(value)) return null;
  const eventId = typeof value.eventId === "string" ? value.eventId.trim() : "";
  const deviceTimestampNs = finiteNumber(value.deviceTimestampNs);
  const type = value.type;
  const confidence = finiteNumber(value.confidence);
  if (
    !eventId || eventId.length > 128
    || deviceTimestampNs === null || !Number.isSafeInteger(deviceTimestampNs) || deviceTimestampNs <= 0
    || typeof type !== "string" || !motionEventTypes.has(type as MotionEvent["type"])
    || confidence === null || confidence < 0 || confidence > 1
  ) return null;
  const details = isRecord(value.details)
    ? Object.fromEntries(Object.entries(value.details).filter(([key, item]) => key.length <= 64 && (typeof item === "number" || typeof item === "string" || typeof item === "boolean")))
    : undefined;
  return {
    eventId,
    deviceTimestampNs,
    type: type as MotionEvent["type"],
    confidence,
    ...(details && Object.keys(details).length ? { details } : {}),
  };
};

const normalizeSensorSample = (value: unknown): SensorSample | null => {
  if (!isRecord(value) || typeof value.sensorType !== "string") return null;
  const sampleId = value.sampleId === undefined ? undefined : typeof value.sampleId === "string" ? value.sampleId.trim() : null;
  if (sampleId === null || (sampleId !== undefined && (!sampleId || sampleId.length > MAX_SAMPLE_ID_LENGTH))) return null;
  const sensorType = normalizeSensorType(value.sensorType.trim());
  const deviceTimestampNs = finiteNumber(value.deviceTimestampNs);
  const rawValues = value.values;
  if (!sensorType || sensorType.length > 64 || deviceTimestampNs === null || !Number.isSafeInteger(deviceTimestampNs) || deviceTimestampNs <= 0) return null;
  if (!Array.isArray(rawValues) || rawValues.length > MAX_SENSOR_VALUES) return null;
  const values = rawValues.map(finiteNumber);
  if (values.some((item) => item === null)) return null;
  const sensorAccuracy = value.sensorAccuracy === undefined ? undefined : finiteNumber(value.sensorAccuracy);
  if (value.sensorAccuracy !== undefined && (sensorAccuracy === null || !Number.isInteger(sensorAccuracy) || sensorAccuracy < 0 || sensorAccuracy > 3)) return null;
  const accuracy = value.accuracy === undefined ? undefined : finiteNumber(value.accuracy);
  if (value.accuracy !== undefined && (accuracy === null || accuracy < 0 || accuracy > 10_000)) return null;
  const location = value.location === undefined ? undefined : normalizeLocation(value.location);
  if (value.location !== undefined && location === null) return null;
  const relativePosition = value.relativePosition === undefined ? undefined : normalizeRelativePosition(value.relativePosition);
  if (value.relativePosition !== undefined && relativePosition === null) return null;
  const pose = value.pose === undefined ? undefined : normalizePose(value.pose);
  if (value.pose !== undefined && pose === null) return null;
  const motionEvent = value.motionEvent === undefined ? undefined : normalizeMotionEvent(value.motionEvent);
  if (value.motionEvent !== undefined && motionEvent === null) return null;
  return {
    ...(sampleId ? { sampleId } : {}),
    deviceTimestampNs,
    sensorType,
    values: values as number[],
    ...(sensorAccuracy === undefined || sensorAccuracy === null ? {} : { sensorAccuracy }),
    ...(accuracy === undefined || accuracy === null ? {} : { accuracy }),
    ...(location ? { location } : {}),
    ...(relativePosition ? { relativePosition } : {}),
    ...(pose ? { pose } : {}),
    ...(motionEvent ? { motionEvent } : {}),
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
  const stats = session.sensorStats.find((item) => item.sensorType === sensorType);
  if (stats) {
    stats.sampleCount += 1;
    stats.firstDeviceTimestampNs = Math.min(stats.firstDeviceTimestampNs, sample.deviceTimestampNs);
    stats.lastDeviceTimestampNs = Math.max(stats.lastDeviceTimestampNs, sample.deviceTimestampNs);
    if (sample.sensorAccuracy !== undefined) stats.lastSensorAccuracy = sample.sensorAccuracy;
  } else {
    if (session.sensorStats.length >= MAX_SENSOR_STATS) session.sensorStats.shift();
    session.sensorStats.push({
      sensorType,
      sampleCount: 1,
      firstDeviceTimestampNs: sample.deviceTimestampNs,
      lastDeviceTimestampNs: sample.deviceTimestampNs,
      ...(sample.sensorAccuracy === undefined ? {} : { lastSensorAccuracy: sample.sensorAccuracy }),
    });
  }
  const snapshot: LiveSensorSnapshot = {
    sensorType,
    values: sample.values.slice(0, 16),
    sensorAccuracy: sample.sensorAccuracy,
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

const poseDistanceM = (left: PoseEstimate, right: PoseEstimate) => Math.sqrt(
  (left.xM - right.xM) ** 2
  + (left.yM - right.yM) ** 2
  + (left.zM - right.zM) ** 2,
);

const applyLoopCorrection = (session: ObservationSession) => {
  if (session.poseTrack.length < 2) return;
  const start = session.poseTrack[0];
  const end = session.poseTrack.at(-1);
  if (!end) return;
  const correction = {
    xM: end.xM - start.xM,
    yM: end.yM - start.yM,
    zM: end.zM - start.zM,
  };
  const denominator = Math.max(1, session.poseTrack.length - 1);
  session.correctedPoseTrack = session.poseTrack.map((pose, index) => {
    const ratio = index / denominator;
    return {
      ...pose,
      xM: pose.xM - correction.xM * ratio,
      yM: pose.yM - correction.yM * ratio,
      zM: pose.zM - correction.zM * ratio,
      sourceFlags: [...new Set([...pose.sourceFlags, "loop-corrected"])],
    };
  });
};

const updateClosureState = (session: ObservationSession, pose: PoseEstimate) => {
  const runtime = sessionRuntime.get(session.sessionId) ?? {};
  if (!runtime.startPose) {
    runtime.startPose = pose;
    runtime.lastPose = pose;
    runtime.travelledM = 0;
    sessionRuntime.set(session.sessionId, runtime);
    session.closure = { status: "open", confidence: 0, adjusted: false };
    return;
  }
  if (runtime.lastPose) runtime.travelledM = (runtime.travelledM ?? 0) + poseDistanceM(runtime.lastPose, pose);
  runtime.lastPose = pose;
  sessionRuntime.set(session.sessionId, runtime);

  const startPose = runtime.startPose;
  const gapM = poseDistanceM(startPose, pose);
  const uncertaintyM = Math.max(1.5, Math.min(12, startPose.accuracyM + pose.accuracyM));
  const travelledM = runtime.travelledM ?? 0;
  const candidate = travelledM >= 8 && gapM <= Math.max(2, uncertaintyM * 0.75);
  const visualLoop = pose.sourceFlags.includes("loop-closure") && pose.sourceFlags.includes("visual-aligned");
  const wasAdjusted = session.closure.adjusted;
  const confidence = candidate
    ? clamp(1 - gapM / Math.max(2, uncertaintyM), 0, 1) * 0.85
    : 0;
  session.closure = {
    status: visualLoop && candidate ? "closed" : candidate ? "candidate" : "open",
    gapM,
    confidence,
    // Never alter raw points until a visual loop-closure source is present.
    adjusted: false,
  } satisfies ClosureState;
  if (session.closure.status === "closed" && !wasAdjusted) {
    applyLoopCorrection(session);
    session.closure = {
      ...session.closure,
      adjusted: true,
    };
  }
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
    rawSampleCount: 0,
    droppedSampleCount: 0,
    track: [],
    relativeTrack: [],
    poseTrack: [],
    correctedPoseTrack: [],
    motionMode: "unknown",
    closure: { status: "open", confidence: 0, adjusted: false },
    motionEvents: [],
    sensorStats: [],
    latestSensors: [],
    status: "active",
  };
  sessions.set(session.sessionId, session);
  altitudeReferences.set(session.sessionId, {});
  sessionRuntime.set(session.sessionId, { rawSamples: [] });
  persistSession(session);
  device.connected = true;
  device.lastSeen = session.startedAt;
  return session;
};

const acceptSamples = (session: ObservationSession, rawSamples: unknown[]) => {
  const receivedAt = new Date().toISOString();
  const trackPoints: TrackPoint[] = [];
  const relativePoints: RelativeMotionPoint[] = [];
  const posePoints: PoseEstimate[] = [];
  const correctedPosePoints: PoseEstimate[] = [];
  const motionEvents: MotionEvent[] = [];
  const wasClosureAdjusted = session.closure.adjusted;
  const runtime = sessionRuntime.get(session.sessionId) ?? { rawSamples: [] };
  runtime.seenSampleIds ??= new Set<string>();
  runtime.seenSampleIdOrder ??= [];
  const normalizedSamples = rawSamples
    .map(normalizeSensorSample)
    .filter((sample): sample is SensorSample => sample !== null)
    .sort((left, right) => left.deviceTimestampNs - right.deviceTimestampNs);
  let duplicateCount = 0;
  const samples = normalizedSamples.filter((sample) => {
    if (!sample.sampleId) return true;
    if (runtime.seenSampleIds!.has(sample.sampleId)) {
      duplicateCount += 1;
      return false;
    }
    runtime.seenSampleIds!.add(sample.sampleId);
    runtime.seenSampleIdOrder!.push(sample.sampleId);
    while (runtime.seenSampleIdOrder!.length > MAX_SEEN_SAMPLE_IDS) {
      const evicted = runtime.seenSampleIdOrder!.shift();
      if (evicted) runtime.seenSampleIds!.delete(evicted);
    }
    return true;
  });
  session.droppedSampleCount += rawSamples.length - normalizedSamples.length + duplicateCount;
  session.sampleCount += samples.length;
  session.rawSampleCount += samples.length;
  runtime.rawSamples = [...(runtime.rawSamples ?? []), ...samples].slice(-MAX_RAW_REPLAY_SAMPLES);
  sessionRuntime.set(session.sessionId, runtime);
  markSessionDirty(session);
  if (samples.length) {
    session.lastReceivedAt = receivedAt;
    session.lastSampleAt = receivedAt;
  }
  for (const sample of samples) {
    const sensorType = normalizeSensorType(sample.sensorType);
    if (sample.pose) {
      session.poseTrack.push(sample.pose);
      session.correctedPoseTrack?.push(sample.pose);
      posePoints.push(sample.pose);
      session.latestPose = sample.pose;
      session.motionMode = sample.pose.motionMode;
      updateClosureState(session, sample.pose);
    }
    if (sample.motionEvent) {
      session.motionEvents.push(sample.motionEvent);
      motionEvents.push(sample.motionEvent);
    }
    if (sample.relativePosition) {
      const motionPoint = toRelativeMotionPoint(sample.relativePosition, sample.deviceTimestampNs);
      session.relativeTrack.push(motionPoint);
      relativePoints.push(motionPoint);
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
      trackPoints.push(point);
      rememberLocation(session, sample.location, sample.deviceTimestampNs);
      upsertSensor(session, sample, receivedAt, "gnss");
    } else {
      if (sensorType === "barometer") updateBarometerAltitude(session, sample);
      upsertSensor(session, sample, receivedAt, sensorType);
    }
  }
  if (session.track.length > MAX_TRACK_POINTS) session.track = session.track.slice(-MAX_TRACK_POINTS);
  if (session.relativeTrack.length > MAX_RELATIVE_TRACK_POINTS) session.relativeTrack = session.relativeTrack.slice(-MAX_RELATIVE_TRACK_POINTS);
  if (session.poseTrack.length > MAX_POSE_TRACK_POINTS) session.poseTrack = session.poseTrack.slice(-MAX_POSE_TRACK_POINTS);
  if (session.correctedPoseTrack && session.correctedPoseTrack.length > MAX_POSE_TRACK_POINTS) session.correctedPoseTrack = session.correctedPoseTrack.slice(-MAX_POSE_TRACK_POINTS);
  if (session.motionEvents.length > MAX_MOTION_EVENTS) session.motionEvents = session.motionEvents.slice(-MAX_MOTION_EVENTS);
  if (!wasClosureAdjusted && session.closure.adjusted) correctedPosePoints.push(...(session.correctedPoseTrack ?? []));
  device.lastSeen = session.lastReceivedAt ?? device.lastSeen;
  device.connected = true;
  return { accepted: samples.length, dropped: session.droppedSampleCount, session, trackPoints, relativePoints, posePoints, correctedPosePoints, motionEvents };
};

const publishSession = (server: Bun.Server<RealtimeClient>, session: ObservationSession) => {
  server.publish("dashboard", JSON.stringify({ type: "session.updated", session }));
};

const publishSessionDelta = (
  server: Bun.Server<RealtimeClient>,
  result: ReturnType<typeof acceptSamples>,
) => {
  const session = result.session;
  const delta: SessionDelta = {
    type: "session.delta",
    sessionId: session.sessionId,
    status: session.status,
    lastReceivedAt: session.lastReceivedAt,
    lastSampleAt: session.lastSampleAt,
    sampleCount: session.sampleCount,
    rawSampleCount: session.rawSampleCount,
    droppedSampleCount: session.droppedSampleCount,
    latestLocation: session.latestLocation,
    latestAltitudeM: session.latestAltitudeM,
    altitudeSource: session.altitudeSource,
    latestRelativePosition: session.latestRelativePosition,
    trackPoints: result.trackPoints,
    relativePoints: result.relativePoints,
    posePoints: result.posePoints,
    ...(result.correctedPosePoints.length ? { correctedPosePoints: result.correctedPosePoints } : {}),
    latestPose: session.latestPose,
    motionMode: session.motionMode,
    closure: session.closure,
    motionEvents: result.motionEvents,
    sensorStats: session.sensorStats,
    latestSensors: session.latestSensors,
  };
  server.publish("dashboard", JSON.stringify(delta));
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
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return json({ ok: true, service: "way-memory-api", time: new Date().toISOString() });
    }
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

    const rawSessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/raw$/);
    if (rawSessionMatch && request.method === "GET") {
      const sessionId = rawSessionMatch[1];
      const session = getSession(sessionId);
      if (!session) return json({ error: "session_not_found" }, { status: 404 });
      const runtime = sessionRuntime.get(sessionId);
      return json({
        sessionId,
        totalSamples: session.rawSampleCount,
        retainedSamples: runtime?.rawSamples?.length ?? 0,
        maxRetainedSamples: MAX_RAW_REPLAY_SAMPLES,
        samples: runtime?.rawSamples ?? [],
      });
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/samples|\/stop)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const session = getSession(sessionId);
      if (!session) return json({ error: "session_not_found" }, { status: 404 });
      if (url.pathname.endsWith("/stop") && request.method === "POST") {
        session.status = "stopped";
        session.lastReceivedAt = new Date().toISOString();
        cancelSessionResume(session.sessionId);
        altitudeReferences.delete(session.sessionId);
        device.connected = false;
        persistSession(session);
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

      if (ws.data.role === "device" && message.type === "session.resume") {
        const session = getSession(message.sessionId ?? "");
        const deviceId = message.deviceId ?? ws.data.deviceId ?? "android-device";
        if (!session || session.status !== "active" || session.deviceId !== deviceId) {
          ws.send(JSON.stringify({ type: "error", error: "session_resume_failed" }));
          return;
        }
        cancelSessionResume(session.sessionId);
        ws.data.sessionId = session.sessionId;
        device.connected = true;
        ws.send(JSON.stringify({ type: "session.resumed", session }));
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
        publishSessionDelta(server, result);
        return;
      }

      if (ws.data.role === "device" && message.type === "session.stop") {
        const session = getSession(message.sessionId ?? ws.data.sessionId ?? "");
        if (session) {
          session.status = "stopped";
          session.lastReceivedAt = new Date().toISOString();
          cancelSessionResume(session.sessionId);
          altitudeReferences.delete(session.sessionId);
          device.connected = false;
          persistSession(session);
          publishSession(server, session);
        }
        return;
      }

      ws.send(JSON.stringify({ type: "error", error: "unsupported_message" }));
    },
    close(ws) {
      const session = getSession(ws.data.sessionId ?? "");
      if (session && session.status === "active") {
        device.connected = false;
        scheduleSessionStopAfterDisconnect(session);
      }
    },
  },
});

console.log(`way-memory API listening on ${server.url}`);
