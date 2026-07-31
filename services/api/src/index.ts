import type {
  ClosureState,
  ClosureAnchor,
  CaptureClientInfo,
  CreateSessionInput,
  DeviceSnapshot,
  LiveSensorSnapshot,
  MotionEvent,
  MotionMode,
  NavigationState,
  ObservationSession,
  PoseEstimate,
  RelativeMotionPoint,
  RouteAlignmentSummary,
  RouteNode,
  RouteObservationSummary,
  SessionDelta,
  SensorSample,
  SensorInventoryEntry,
  TrackPoint,
} from "@way-memory/contracts";
import { AuthStore, type AuthPrincipal, type AuthRole } from "./authStore";
import { RouteStore, type StoredRoute } from "./routeStore";
import { SessionStore } from "./sessionStore";

const port = Number(Bun.env.PORT ?? 8787);
const runtimeEnvironment = Bun.env.WAY_MEMORY_ENV ?? "test";
if (runtimeEnvironment !== "test" && runtimeEnvironment !== "production") throw new Error("invalid_runtime_environment");
const allowedOrigin = Bun.env.WAY_MEMORY_ALLOWED_ORIGIN ?? "*";

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

const sessions = new Map<string, ObservationSession>();
const altitudeReferences = new Map<string, { gnssM?: number; pressureHpa?: number }>();

const MAX_SESSIONS = 20;
const MAX_ROUTES = 100;
const MAX_ROUTE_OBSERVATIONS = 50;
const MAX_ROUTE_NODES = 128;
const MAX_ROUTE_TRACK_POINTS = 500;
const MAX_ROUTE_POSE_POINTS = 1_200;
const MAX_TRACK_POINTS = 500;
const MAX_RELATIVE_TRACK_POINTS = 500;
const MAX_POSE_TRACK_POINTS = 1_200;
const MAX_MOTION_EVENTS = 128;
const MAX_RAW_REPLAY_SAMPLES = 1_024;
const MAX_SENSOR_STATS = 128;
const MAX_SENSOR_INVENTORY = 128;
const MAX_LIVE_SENSORS = 32;
const MAX_SENSOR_VALUES = 16;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_ROUTE_ID_LENGTH = 128;
const MAX_CLIENT_FIELD_LENGTH = 128;
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
  lastPoseTimestampNs?: number;
  lastRelativeTimestampNs?: number;
  lastMotionEventTimestampNs?: number;
};

const sessionRuntime = new Map<string, SessionRuntime>();
const sessionResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_PERSISTED_SESSIONS = 100;
const sessionStore = new SessionStore(Bun.env.WAY_MEMORY_DB_PATH ?? ".data/way-memory.sqlite");
const routeStore = new RouteStore(Bun.env.WAY_MEMORY_DB_PATH ?? ".data/way-memory.sqlite");
const authMode = Bun.env.WAY_MEMORY_AUTH_MODE ?? "off";
if (authMode !== "off" && authMode !== "enforced") throw new Error("invalid_auth_mode");
if (authMode === "enforced" && !Bun.env.WAY_MEMORY_BOOTSTRAP_TOKEN) throw new Error("production_auth_requires_bootstrap_token");
if (runtimeEnvironment === "production" && (authMode !== "enforced" || !Bun.env.WAY_MEMORY_PUBLIC_ORIGIN?.startsWith("https://") || !allowedOrigin.startsWith("https://"))) {
  throw new Error("production_requires_enforced_auth_https_origin_and_cors_origin");
}
const authStore = new AuthStore(Bun.env.WAY_MEMORY_DB_PATH ?? ".data/way-memory.sqlite");
const LOCAL_OWNER_ID = "local-test-owner";
const dirtySessionIds = new Set<string>();
const routes = new Map<string, StoredRoute>();

const poseDistanceM = (left: PoseEstimate, right: PoseEstimate) => Math.sqrt(
  (left.xM - right.xM) ** 2
  + (left.yM - right.yM) ** 2
  + (left.zM - right.zM) ** 2,
);

const poseTrackDistanceM = (poses: PoseEstimate[]) => {
  let distanceM = 0;
  for (let index = 1; index < poses.length; index += 1) distanceM += poseDistanceM(poses[index - 1], poses[index]);
  return distanceM;
};

const geographicDistanceM = (left: TrackPoint, right: TrackPoint) => {
  const earthRadiusM = 6_371_000;
  const toRadians = (value: number) => value * Math.PI / 180;
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);
  const dLat = lat2 - lat1;
  const dLng = toRadians(right.lng - left.lng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
};

const trackDistanceM = (track: TrackPoint[]) => {
  let distanceM = 0;
  for (let index = 1; index < track.length; index += 1) distanceM += geographicDistanceM(track[index - 1], track[index]);
  return distanceM;
};

const navigationStateFor = (route: StoredRoute, location: TrackPoint): NavigationState => {
  const updatedAt = new Date().toISOString();
  const track = route.track;
  if (track.length < 2) return { routeId: route.routeId, status: "route-not-ready", updatedAt };
  const earthRadiusM = 6_371_000;
  const origin = track[0];
  const latitudeScale = Math.PI / 180 * earthRadiusM;
  const longitudeScale = latitudeScale * Math.cos(origin.lat * Math.PI / 180);
  const toLocal = (point: TrackPoint) => ({
    x: (point.lng - origin.lng) * longitudeScale,
    y: (point.lat - origin.lat) * latitudeScale,
  });
  const target = toLocal(location);
  let cumulativeM = 0;
  let totalM = 0;
  let bestDistanceM = Number.POSITIVE_INFINITY;
  let bestProgressM = 0;
  let bestIndex = 0;
  let bestT = 0;
  for (let index = 1; index < track.length; index += 1) {
    const start = toLocal(track[index - 1]);
    const end = toLocal(track[index]);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const segmentLengthM = Math.hypot(dx, dy);
    totalM += segmentLengthM;
    if (segmentLengthM < 0.01) continue;
    const segmentLengthSquared = segmentLengthM ** 2;
    const t = Math.max(0, Math.min(1, ((target.x - start.x) * dx + (target.y - start.y) * dy) / segmentLengthSquared));
    const nearestX = start.x + dx * t;
    const nearestY = start.y + dy * t;
    const distanceM = Math.hypot(target.x - nearestX, target.y - nearestY);
    if (distanceM < bestDistanceM) {
      bestDistanceM = distanceM;
      bestProgressM = cumulativeM + segmentLengthM * t;
      bestIndex = index - 1;
      bestT = t;
    }
    cumulativeM += segmentLengthM;
  }
  if (!Number.isFinite(bestDistanceM) || totalM < 0.01) return { routeId: route.routeId, status: "route-not-ready", updatedAt };
  const start = track[bestIndex];
  const end = track[Math.min(bestIndex + 1, track.length - 1)];
  const nearestLat = start.lat + (end.lat - start.lat) * bestT;
  const nearestLng = start.lng + (end.lng - start.lng) * bestT;
  const nearestAltitudeM = typeof start.altitudeM === "number" && typeof end.altitudeM === "number"
    ? start.altitudeM + (end.altitudeM - start.altitudeM) * bestT
    : undefined;
  const accuracyM = Math.max(0.1, location.accuracyM);
  const status = bestDistanceM <= Math.max(8, accuracyM * 2)
    ? "on-route"
    : bestDistanceM <= 25
      ? "near-route"
      : "off-route";
  return {
    routeId: route.routeId,
    status,
    progressM: Math.min(totalM, bestProgressM),
    remainingM: Math.max(0, totalM - bestProgressM),
    distanceToRouteM: bestDistanceM,
    nearestPointIndex: bestIndex,
    nearestLat,
    nearestLng,
    ...(nearestAltitudeM === undefined ? {} : { nearestAltitudeM }),
    ...(typeof location.altitudeM === "number" && nearestAltitudeM !== undefined ? { altitudeDeltaM: location.altitudeM - nearestAltitudeM } : {}),
    accuracyM,
    updatedAt,
  };
};

const observationConfidence = (session: ObservationSession) => {
  const values = session.poseTrack.length
    ? session.poseTrack.map((pose) => pose.confidence)
    : session.track.map((point) => point.confidence);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
};

type TrackAlignment = {
  summary: RouteAlignmentSummary;
  track?: TrackPoint[];
};

const alignGnssTrack = (reference: TrackPoint[], candidate: TrackPoint[]): TrackAlignment => {
  const unavailable = (matchedPoints: number, coverage: number, residualM?: number): TrackAlignment => ({
    summary: { method: "gnss-nearest", status: "unavailable", matchedPoints, coverage, ...(residualM === undefined ? {} : { residualM }) },
  });
  if (reference.length < 2 || candidate.length < 2) return unavailable(0, 0);
  const matches: Array<{ referenceIndex: number; point: TrackPoint; distanceM: number }> = [];
  let nextReferenceIndex = 0;
  for (const point of candidate) {
    let best: { referenceIndex: number; distanceM: number } | undefined;
    for (let index = nextReferenceIndex; index < reference.length; index += 1) {
      const distanceM = geographicDistanceM(reference[index], point);
      if (!best || distanceM < best.distanceM) best = { referenceIndex: index, distanceM };
    }
    if (best && best.distanceM <= 25) {
      matches.push({ referenceIndex: best.referenceIndex, point, distanceM: best.distanceM });
      nextReferenceIndex = best.referenceIndex;
    }
  }
  const coverage = matches.length / candidate.length;
  const residualM = matches.length ? matches.reduce((sum, match) => sum + match.distanceM, 0) / matches.length : undefined;
  const distinctReferencePoints = new Set(matches.map((match) => match.referenceIndex)).size;
  if (matches.length < 2 || distinctReferencePoints < 2 || coverage < 0.5 || (residualM !== undefined && residualM > 25)) return unavailable(matches.length, coverage, residualM);
  const buckets = reference.map((point) => [point] as TrackPoint[]);
  for (const match of matches) buckets[match.referenceIndex].push(match.point);
  const merged = buckets.map((points) => {
    if (points.length === 1) return points[0];
    const latitude = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
    const longitude = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
    const accuracyM = points.reduce((sum, point) => sum + point.accuracyM, 0) / points.length;
    const confidence = points.reduce((sum, point) => sum + point.confidence, 0) / points.length;
    const altitudes = points.flatMap((point) => typeof point.altitudeM === "number" ? [point.altitudeM] : []);
    return {
      ...points[0],
      lat: latitude,
      lng: longitude,
      accuracyM,
      confidence,
      ...(altitudes.length ? { altitudeM: altitudes.reduce((sum, value) => sum + value, 0) / altitudes.length } : {}),
    };
  });
  return {
    summary: { method: "gnss-nearest", status: "matched", matchedPoints: matches.length, coverage, residualM },
    track: merged,
  };
};

const toObservationSummary = (session: ObservationSession, attachedAt: string, alignment: RouteAlignmentSummary): RouteObservationSummary => ({
  sessionId: session.sessionId,
  startedAt: session.startedAt,
  sampleCount: session.sampleCount,
  rawSampleCount: session.rawSampleCount,
  poseCount: session.poseTrack.length,
  locationPointCount: session.track.length,
  motionMode: session.motionMode,
  sourceFlags: [...new Set(session.poseTrack.flatMap((pose) => pose.sourceFlags))].slice(0, 32),
  attachedAt,
  alignment,
});

const publicRoute = (route: StoredRoute) => {
  const { ownerId: _ownerId, ...response } = route;
  return response;
};

const createRoute = (ownerId: string, name: string): StoredRoute => {
  const now = new Date().toISOString();
  return {
    routeId: crypto.randomUUID(),
    ownerId,
    name,
    status: "draft",
    distanceM: 0,
    observations: 0,
    nodes: 0,
    confidence: 0,
    updatedAt: now,
    track: [],
    poseTrack: [],
    observationSummaries: [],
    nodeRecords: [],
  };
};

const attachObservation = (route: StoredRoute, session: ObservationSession) => {
  if (session.status !== "stopped") throw new Error("route_observation_must_be_stopped");
  if (route.observationSummaries.some((observation) => observation.sessionId === session.sessionId)) return route;
  if (route.observationSummaries.length >= MAX_ROUTE_OBSERVATIONS) throw new Error("route_observation_limit");
  const attachedAt = new Date().toISOString();
  const isReference = !route.referenceSessionId;
  const alignmentResult: TrackAlignment = isReference
    ? {
      summary: {
        method: "reference",
        status: "reference",
        matchedPoints: session.track.length,
        coverage: session.track.length ? 1 : 0,
      },
    }
    : alignGnssTrack(route.track, session.track);
  const observation = toObservationSummary(session, attachedAt, alignmentResult.summary);
  route.observationSummaries.push(observation);
  route.observations = route.observationSummaries.length;
  if (isReference) {
    route.referenceSessionId = session.sessionId;
    route.track = session.track.slice(-MAX_ROUTE_TRACK_POINTS);
    route.poseTrack = session.poseTrack.slice(-MAX_ROUTE_POSE_POINTS);
    route.distanceM = route.poseTrack.length > 1 ? poseTrackDistanceM(route.poseTrack) : trackDistanceM(route.track);
    route.confidence = observationConfidence(session);
  } else {
    // GNSS alignment only changes the geographic reference track. A later
    // capture's local ENU/AR pose remains session-scoped until a visual or
    // heading transform can prove that the two local frames are compatible.
    const aligned = alignmentResult.track;
    if (aligned) {
      route.track = aligned.slice(-MAX_ROUTE_TRACK_POINTS);
      route.distanceM = route.track.length > 1 ? trackDistanceM(route.track) : route.distanceM;
      route.confidence = ((route.confidence * (route.observations - 1)) + observationConfidence(session)) / route.observations;
    }
  }
  route.updatedAt = attachedAt;
  return route;
};

const routeNodeTypes = new Set<RouteNode["nodeType"]>(["start", "turn", "door", "stairs", "elevator", "crossing", "landmark", "hazard", "end"]);

const normalizeRouteNode = (input: unknown): RouteNode | null => {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const nodeType = value.nodeType;
  const instruction = typeof value.instruction === "string" ? value.instruction.trim().slice(0, 256) : "";
  const xM = typeof value.xM === "number" && Number.isFinite(value.xM) ? value.xM : null;
  const yM = typeof value.yM === "number" && Number.isFinite(value.yM) ? value.yM : null;
  const zM = typeof value.zM === "number" && Number.isFinite(value.zM) ? value.zM : null;
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence) ? value.confidence : null;
  const lat = value.lat === undefined ? undefined : typeof value.lat === "number" && Number.isFinite(value.lat) ? value.lat : null;
  const lng = value.lng === undefined ? undefined : typeof value.lng === "number" && Number.isFinite(value.lng) ? value.lng : null;
  if (
    typeof nodeType !== "string" || !routeNodeTypes.has(nodeType as RouteNode["nodeType"])
    || !instruction || xM === null || yM === null || zM === null
    || Math.abs(xM) > 100_000 || Math.abs(yM) > 100_000 || Math.abs(zM) > 100_000
    || confidence === null || confidence < 0 || confidence > 1
    || lat === null || lng === null
    || (lat === undefined) !== (lng === undefined)
    || (lat !== undefined && (lat < -90 || lat > 90))
    || (lng !== undefined && (lng < -180 || lng > 180))
  ) return null;
  return {
    nodeId: crypto.randomUUID(),
    nodeType: nodeType as RouteNode["nodeType"],
    instruction,
    xM,
    yM,
    zM,
    ...(lat === undefined ? {} : { lat }),
    ...(lng === undefined ? {} : { lng }),
    confidence,
    manualAnnotation: true,
    createdAt: new Date().toISOString(),
  };
};

const sortByDeviceTimestamp = <T extends { deviceTimestampNs?: number }>(points: T[]) => [...points].sort(
  (left, right) => (left.deviceTimestampNs ?? 0) - (right.deviceTimestampNs ?? 0),
);

const toClosureAnchor = (pose: PoseEstimate): ClosureAnchor => ({
  deviceTimestampNs: pose.deviceTimestampNs,
  xM: pose.xM,
  yM: pose.yM,
  zM: pose.zM,
  accuracyM: pose.accuracyM,
});

const anchorToPose = (anchor: ClosureAnchor, template: PoseEstimate): PoseEstimate => ({
  ...template,
  deviceTimestampNs: anchor.deviceTimestampNs,
  xM: anchor.xM,
  yM: anchor.yM,
  zM: anchor.zM,
  accuracyM: anchor.accuracyM,
});

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
  snapshot.session.track = sortByDeviceTimestamp(snapshot.session.track ?? []);
  snapshot.session.relativeTrack = sortByDeviceTimestamp(snapshot.session.relativeTrack ?? []);
  snapshot.session.poseTrack = sortByDeviceTimestamp(snapshot.session.poseTrack ?? []);
  if (snapshot.session.correctedPoseTrack) snapshot.session.correctedPoseTrack = sortByDeviceTimestamp(snapshot.session.correctedPoseTrack);
  snapshot.session.motionEvents = sortByDeviceTimestamp(snapshot.session.motionEvents ?? []);
  snapshot.session.sensorStats ??= [];
  snapshot.session.sensorInventory ??= [];
  snapshot.session.outOfOrderSampleCount ??= 0;
  snapshot.session.ownerId ??= LOCAL_OWNER_ID;
  snapshot.session.status = "stopped";
  sessions.set(snapshot.session.sessionId, snapshot.session);
  const poses = snapshot.session.poseTrack ?? [];
  const locations = snapshot.session.track ?? [];
  const anchor = snapshot.session.closure.anchor;
  const sampleIds = snapshot.rawSamples.map((sample) => sample.sampleId).filter((sampleId): sampleId is string => Boolean(sampleId));
  sessionRuntime.set(snapshot.session.sessionId, {
    rawSamples: snapshot.rawSamples,
    lastLocation: locations.at(-1)?.deviceTimestampNs === undefined || !locations.at(-1)
      ? undefined
      : {
        lat: locations.at(-1)!.lat,
        lng: locations.at(-1)!.lng,
        accuracyM: locations.at(-1)!.accuracyM,
        deviceTimestampNs: locations.at(-1)!.deviceTimestampNs!,
      },
    startPose: anchor && poses[0] ? anchorToPose(anchor, poses[0]) : poses[0],
    lastPose: poses.at(-1),
    travelledM: snapshot.session.closure.travelledM ?? poseTrackDistanceM(poses),
    seenSampleIds: new Set(sampleIds.slice(-MAX_SEEN_SAMPLE_IDS)),
    seenSampleIdOrder: sampleIds.slice(-MAX_SEEN_SAMPLE_IDS),
    lastPoseTimestampNs: poses.at(-1)?.deviceTimestampNs,
    lastRelativeTimestampNs: snapshot.session.relativeTrack.at(-1)?.deviceTimestampNs,
    lastMotionEventTimestampNs: snapshot.session.motionEvents.at(-1)?.deviceTimestampNs,
  });
}
sessionStore.prune(MAX_PERSISTED_SESSIONS);
for (const route of routeStore.load(MAX_ROUTES)) routes.set(route.routeId, route);
routeStore.prune(MAX_ROUTES);
const persistenceTimer = setInterval(flushDirtySessions, 2_000);
persistenceTimer.unref?.();

type RealtimeClient = {
  role: "device" | "dashboard";
  ownerId: string;
  deviceId?: string;
  sessionId?: string;
  tokenId?: string;
};

const normalizeCaptureClient = (input: unknown): CaptureClientInfo | undefined => {
  if (!input || typeof input !== "object") return undefined;
  const candidate = input as Partial<CaptureClientInfo>;
  const applicationId = typeof candidate.applicationId === "string"
    ? candidate.applicationId.trim().slice(0, MAX_CLIENT_FIELD_LENGTH)
    : "";
  const versionName = typeof candidate.versionName === "string"
    ? candidate.versionName.trim().slice(0, MAX_CLIENT_FIELD_LENGTH)
    : "";
  const buildType = candidate.buildType === "debug" || candidate.buildType === "release"
    ? candidate.buildType
    : "unknown";
  if (!applicationId || !versionName || typeof candidate.apiBaseUrl !== "string") return undefined;
  try {
    const url = new URL(candidate.apiBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    // Store only an origin. This prevents accidental credentials, query strings,
    // or path tokens from entering the session evidence.
    return { applicationId, versionName, buildType, apiBaseUrl: url.origin };
  } catch {
    return undefined;
  }
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

const normalizeSensorInventory = (value: unknown): SensorInventoryEntry[] => {
  if (!Array.isArray(value)) return [];
  const result: SensorInventoryEntry[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.sensorType !== "string" || typeof item.name !== "string" || typeof item.registered !== "boolean") continue;
    const sensorType = item.sensorType.trim().slice(0, 64);
    const name = item.name.trim().slice(0, 128);
    if (!sensorType || !name) continue;
    const vendor = item.vendor === undefined ? undefined : typeof item.vendor === "string" ? item.vendor.trim().slice(0, 128) : null;
    const version = item.version === undefined ? undefined : finiteNumber(item.version);
    const powerMa = item.powerMa === undefined ? undefined : finiteNumber(item.powerMa);
    const minDelayUs = item.minDelayUs === undefined ? undefined : finiteNumber(item.minDelayUs);
    const maxDelayUs = item.maxDelayUs === undefined ? undefined : finiteNumber(item.maxDelayUs);
    const reportingMode = item.reportingMode === undefined ? undefined : finiteNumber(item.reportingMode);
    const transportMaxHz = item.transportMaxHz === undefined ? undefined : finiteNumber(item.transportMaxHz);
    if (
      vendor === null
      || (version !== undefined && (version === null || !Number.isInteger(version) || version < 0 || version > 1_000_000))
      || (powerMa !== undefined && (powerMa === null || powerMa < 0 || powerMa > 100_000))
      || (minDelayUs !== undefined && (minDelayUs === null || !Number.isInteger(minDelayUs) || minDelayUs < 0 || minDelayUs > 1_000_000_000))
      || (maxDelayUs !== undefined && (maxDelayUs === null || !Number.isInteger(maxDelayUs) || maxDelayUs < 0 || maxDelayUs > 1_000_000_000))
      || (reportingMode !== undefined && (reportingMode === null || !Number.isInteger(reportingMode) || reportingMode < 0 || reportingMode > 16))
      || (transportMaxHz !== undefined && (transportMaxHz === null || !Number.isInteger(transportMaxHz) || transportMaxHz < 1 || transportMaxHz > 1_000))
    ) continue;
    result.push({
      sensorType,
      name,
      ...(vendor ? { vendor } : {}),
      ...(version === undefined || version === null ? {} : { version }),
      ...(powerMa === undefined || powerMa === null ? {} : { powerMa }),
      ...(minDelayUs === undefined || minDelayUs === null ? {} : { minDelayUs }),
      ...(maxDelayUs === undefined || maxDelayUs === null ? {} : { maxDelayUs }),
      ...(reportingMode === undefined || reportingMode === null ? {} : { reportingMode }),
      ...(transportMaxHz === undefined || transportMaxHz === null ? {} : { transportMaxHz }),
      registered: item.registered,
    });
    if (result.length >= MAX_SENSOR_INVENTORY) break;
  }
  return result;
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
  session.latestSensors[existingIndex] = sample.deviceTimestampNs > existing.lastDeviceTimestampNs
    ? {
      ...snapshot,
      sampleCount: existing.sampleCount + 1,
    }
    : {
      ...existing,
      sampleCount: existing.sampleCount + 1,
      lastReceivedAt: receivedAt,
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

const applyPoseLoopCorrection = (pose: PoseEstimate, correction: NonNullable<ClosureState["correction"]>) => {
  const durationNs = Math.max(1, correction.endTimestampNs - correction.startTimestampNs);
  const ratio = clamp((pose.deviceTimestampNs - correction.startTimestampNs) / durationNs, 0, 1);
  return {
    ...pose,
    xM: pose.xM - correction.xM * ratio,
    yM: pose.yM - correction.yM * ratio,
    zM: pose.zM - correction.zM * ratio,
    sourceFlags: [...new Set([...pose.sourceFlags, "loop-corrected"])],
  };
};

const applyLoopCorrection = (session: ObservationSession) => {
  if (session.poseTrack.length < 2) return;
  const start = session.poseTrack[0];
  const end = session.poseTrack.at(-1);
  if (!end) return;
  const anchor = session.closure.anchor;
  const startX = anchor?.xM ?? start.xM;
  const startY = anchor?.yM ?? start.yM;
  const startZ = anchor?.zM ?? start.zM;
  const correction = {
    xM: end.xM - startX,
    yM: end.yM - startY,
    zM: end.zM - startZ,
    startTimestampNs: anchor?.deviceTimestampNs ?? start.deviceTimestampNs,
    endTimestampNs: end.deviceTimestampNs,
  };
  session.closure = { ...session.closure, correction };
  session.correctedPoseTrack = session.poseTrack.map((pose) => applyPoseLoopCorrection(pose, correction));
};

const updateClosureState = (session: ObservationSession, pose: PoseEstimate) => {
  const runtime = sessionRuntime.get(session.sessionId) ?? {};
  if (!runtime.startPose) {
    if (session.closure.anchor) runtime.startPose = anchorToPose(session.closure.anchor, pose);
  }
  if (!runtime.startPose) {
    runtime.startPose = pose;
    runtime.lastPose = pose;
    runtime.travelledM = 0;
    sessionRuntime.set(session.sessionId, runtime);
    session.closure = {
      status: "open",
      confidence: 0,
      adjusted: false,
      anchor: toClosureAnchor(pose),
      travelledM: 0,
    };
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
  if (session.closure.adjusted) {
    session.closure = {
      ...session.closure,
      status: "closed",
      gapM,
      adjusted: true,
      travelledM,
    } satisfies ClosureState;
    return;
  }
  const confidence = candidate
    ? clamp(1 - gapM / Math.max(2, uncertaintyM), 0, 1) * 0.85
    : 0;
  session.closure = {
    status: visualLoop && candidate ? "closed" : candidate ? "candidate" : "open",
    gapM,
    confidence,
    // Never alter raw points until a visual loop-closure source is present.
    adjusted: false,
    anchor: session.closure.anchor ?? toClosureAnchor(startPose),
    travelledM,
  } satisfies ClosureState;
  if (session.closure.status === "closed") {
    applyLoopCorrection(session);
    session.closure = {
      ...session.closure,
      adjusted: true,
    };
  }
};

const createSession = (input: CreateSessionInput, ownerId = LOCAL_OWNER_ID): ObservationSession => {
  pruneStoppedSessions();
  if (sessions.size >= MAX_SESSIONS) throw new Error("session_limit");
  const deviceId = typeof input.deviceId === "string" ? input.deviceId.trim().slice(0, MAX_DEVICE_ID_LENGTH) : "";
  if (!deviceId) throw new Error("invalid_session");
  const routeId = typeof input.routeId === "string" ? input.routeId.trim().slice(0, MAX_ROUTE_ID_LENGTH) || undefined : undefined;
  const route = routeId ? routes.get(routeId) : undefined;
  if (routeId && route?.ownerId !== ownerId) throw new Error("invalid_route");
  if (input.mode === "navigation" && (!routeId || route?.status !== "verified")) throw new Error("invalid_navigation_route");
  const navigation = input.mode === "navigation" && routeId
    ? { routeId, status: route.track.length >= 2 ? "no-fix" as const : "route-not-ready" as const, updatedAt: new Date().toISOString() }
    : undefined;
  const session: ObservationSession = {
    sessionId: crypto.randomUUID(),
    deviceId,
    mode: input.mode === "navigation" ? "navigation" : "learning",
    ownerId,
    client: normalizeCaptureClient(input.client),
    routeId,
    navigation,
    startedAt: new Date().toISOString(),
    sampleCount: 0,
    rawSampleCount: 0,
    droppedSampleCount: 0,
    outOfOrderSampleCount: 0,
    track: [],
    relativeTrack: [],
    poseTrack: [],
    correctedPoseTrack: [],
    motionMode: "unknown",
    closure: { status: "open", confidence: 0, adjusted: false },
    motionEvents: [],
    sensorInventory: normalizeSensorInventory(input.sensors),
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
  const navigationRoute = session.mode === "navigation" && session.routeId ? routes.get(session.routeId) : undefined;
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
    let sampleOutOfOrder = false;
    if (sample.pose) {
      const previousTimestampNs = runtime.lastPoseTimestampNs;
      if (previousTimestampNs !== undefined && sample.pose.deviceTimestampNs <= previousTimestampNs) {
        sampleOutOfOrder = true;
      } else {
        runtime.lastPoseTimestampNs = sample.pose.deviceTimestampNs;
        session.poseTrack.push(sample.pose);
        session.correctedPoseTrack?.push(sample.pose);
        posePoints.push(sample.pose);
        session.latestPose = sample.pose;
        session.motionMode = sample.pose.motionMode;
        updateClosureState(session, sample.pose);
        const correction = session.closure.correction;
        if (correction && session.correctedPoseTrack?.length) {
          session.correctedPoseTrack[session.correctedPoseTrack.length - 1] = applyPoseLoopCorrection(sample.pose, correction);
        }
      }
    }
    if (sample.motionEvent) {
      const previousTimestampNs = runtime.lastMotionEventTimestampNs;
      if (previousTimestampNs !== undefined && sample.motionEvent.deviceTimestampNs <= previousTimestampNs) {
        sampleOutOfOrder = true;
      } else {
        runtime.lastMotionEventTimestampNs = sample.motionEvent.deviceTimestampNs;
        session.motionEvents.push(sample.motionEvent);
        motionEvents.push(sample.motionEvent);
      }
    }
    if (sample.relativePosition) {
      const previousTimestampNs = runtime.lastRelativeTimestampNs;
      if (previousTimestampNs !== undefined && sample.deviceTimestampNs <= previousTimestampNs) {
        sampleOutOfOrder = true;
      } else {
        runtime.lastRelativeTimestampNs = sample.deviceTimestampNs;
        const motionPoint = toRelativeMotionPoint(sample.relativePosition, sample.deviceTimestampNs);
        session.relativeTrack.push(motionPoint);
        relativePoints.push(motionPoint);
        session.latestRelativePosition = motionPoint;
      }
    }
    if (sample.location) {
      const previousLocationTimestampNs = runtime.lastLocation?.deviceTimestampNs;
      if (previousLocationTimestampNs !== undefined && sample.deviceTimestampNs <= previousLocationTimestampNs) {
        sampleOutOfOrder = true;
      }
      if (shouldDropLocation(session, sample.location, sample.deviceTimestampNs)) {
        if (previousLocationTimestampNs === undefined || sample.deviceTimestampNs > previousLocationTimestampNs) {
          session.droppedSampleCount += 1;
        }
      } else {
        const point = toTrackPoint(session, sample.location, sample.deviceTimestampNs);
        session.latestLocation = sample.location;
        session.track.push(point);
        trackPoints.push(point);
        if (navigationRoute) session.navigation = navigationStateFor(navigationRoute, point);
        rememberLocation(session, sample.location, sample.deviceTimestampNs);
        upsertSensor(session, sample, receivedAt, "gnss");
      }
    } else {
      if (sensorType === "barometer") updateBarometerAltitude(session, sample);
      upsertSensor(session, sample, receivedAt, sensorType);
    }
    if (sampleOutOfOrder) {
      session.outOfOrderSampleCount += 1;
      session.droppedSampleCount += 1;
    }
  }
  if (session.track.length > MAX_TRACK_POINTS) session.track = session.track.slice(-MAX_TRACK_POINTS);
  if (session.relativeTrack.length > MAX_RELATIVE_TRACK_POINTS) session.relativeTrack = session.relativeTrack.slice(-MAX_RELATIVE_TRACK_POINTS);
  if (session.poseTrack.length > MAX_POSE_TRACK_POINTS) session.poseTrack = session.poseTrack.slice(-MAX_POSE_TRACK_POINTS);
  if (session.correctedPoseTrack && session.correctedPoseTrack.length > MAX_POSE_TRACK_POINTS) session.correctedPoseTrack = session.correctedPoseTrack.slice(-MAX_POSE_TRACK_POINTS);
  if (session.motionEvents.length > MAX_MOTION_EVENTS) session.motionEvents = session.motionEvents.slice(-MAX_MOTION_EVENTS);
  if (!wasClosureAdjusted && session.closure.adjusted) {
    correctedPosePoints.push(...(session.correctedPoseTrack ?? []));
  } else if (wasClosureAdjusted && posePoints.length) {
    correctedPosePoints.push(...(session.correctedPoseTrack?.slice(-posePoints.length) ?? []));
  }
  device.lastSeen = session.lastReceivedAt ?? device.lastSeen;
  device.connected = true;
  return { accepted: samples.length, dropped: session.droppedSampleCount, session, trackPoints, relativePoints, posePoints, correctedPosePoints, motionEvents };
};

const dashboardTopic = (ownerId: string) => `dashboard:${ownerId}`;

const publishSession = (server: Bun.Server<RealtimeClient>, session: ObservationSession) => {
  server.publish(dashboardTopic(session.ownerId), JSON.stringify({ type: "session.updated", session }));
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
    outOfOrderSampleCount: session.outOfOrderSampleCount,
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
    sensorInventory: session.sensorInventory,
    sensorStats: session.sensorStats,
    latestSensors: session.latestSensors,
    navigation: session.navigation,
  };
  server.publish(dashboardTopic(session.ownerId), JSON.stringify(delta));
};

const json = (data: unknown, init: ResponseInit = {}) => Response.json(data, {
  ...init,
  headers: {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-headers": "authorization, content-type",
    ...init.headers,
  },
});

const localPrincipal = (role: AuthRole): AuthPrincipal => ({
  tokenId: "local-test-token",
  ownerId: LOCAL_OWNER_ID,
  role,
  kind: "access",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});

const bearerToken = (request: Request) => {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
};

const requestPrincipal = async (request: Request, role: AuthRole): Promise<AuthPrincipal | null> => {
  if (authMode === "off") return localPrincipal(role);
  return authStore.authenticate(bearerToken(request), role, "access");
};

const sessionBelongsTo = (session: ObservationSession, principal: { ownerId: string }) => session.ownerId === principal.ownerId;

const sessionListView = (session: ObservationSession): ObservationSession => ({
  ...session,
  track: [],
  relativeTrack: [],
  poseTrack: [],
  correctedPoseTrack: [],
  motionEvents: [],
  sensorInventory: [],
  sensorStats: [],
  latestSensors: [],
  locationPointCount: session.track.length,
  relativePointCount: session.relativeTrack.length,
  posePointCount: session.poseTrack.length,
  correctedPosePointCount: session.correctedPoseTrack?.length ?? session.poseTrack.length,
});

const sessionIntegrityView = (session: ObservationSession) => ({
  sessionId: session.sessionId,
  deviceId: session.deviceId,
  status: session.status,
  mode: session.mode,
  routeId: session.routeId,
  startedAt: session.startedAt,
  lastReceivedAt: session.lastReceivedAt,
  lastSampleAt: session.lastSampleAt,
  sampleCount: session.sampleCount,
  rawSampleCount: session.rawSampleCount,
  droppedSampleCount: session.droppedSampleCount,
  outOfOrderSampleCount: session.outOfOrderSampleCount,
  trackPointCount: session.track.length,
  relativePointCount: session.relativeTrack.length,
  posePointCount: session.poseTrack.length,
  correctedPosePointCount: session.correctedPoseTrack?.length ?? session.poseTrack.length,
  latestLocation: session.latestLocation,
  latestPose: session.latestPose,
  latestCorrectedPose: session.correctedPoseTrack?.at(-1),
  closure: session.closure,
  motionMode: session.motionMode,
  navigation: session.navigation,
});

const server = Bun.serve<RealtimeClient>({
  port,
  hostname: "0.0.0.0",
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/realtime") {
      const role = url.searchParams.get("role");
      if (role !== "device" && role !== "dashboard") return new Response("Invalid realtime role", { status: 400 });
      const principal = authMode === "off"
        ? localPrincipal(role)
        : await authStore.authenticate(url.searchParams.get("ticket") ?? "", role, "ws-ticket");
      if (!principal) return new Response("Unauthorized", { status: 401 });
      const upgraded = server.upgrade(request, {
        data: {
          role,
          ownerId: principal.ownerId,
          tokenId: principal.tokenId,
          deviceId: url.searchParams.get("deviceId") ?? undefined,
        },
      });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, x-way-memory-bootstrap", "access-control-allow-methods": "GET,POST,OPTIONS" } });
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return json({ ok: true, service: "way-memory-api", time: new Date().toISOString() });
    }
    if (url.pathname === "/api/auth/bootstrap" && request.method === "POST") {
      if (authMode !== "enforced") return json({ error: "auth_disabled" }, { status: 404 });
      const body = await parseJson<{ ownerId?: string }>(request);
      try {
        const credentials = await authStore.bootstrap(request.headers.get("x-way-memory-bootstrap") ?? "", body?.ownerId?.trim().slice(0, 128) || undefined);
        return json(credentials, { status: 201 });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "bootstrap_failed";
        return json({ error: reason }, { status: reason === "bootstrap_already_used" ? 409 : 401 });
      }
    }
    if (url.pathname === "/api/auth/me" && request.method === "GET") {
      const principal = authMode === "off" ? localPrincipal("dashboard") : await authStore.authenticate(bearerToken(request));
      if (!principal) return json({ error: "unauthorized" }, { status: 401 });
      return json({ ownerId: principal.ownerId, role: principal.role, expiresAt: principal.expiresAt });
    }
    if (url.pathname === "/api/auth/ws-ticket" && request.method === "POST") {
      if (authMode !== "enforced") return json({ error: "auth_disabled" }, { status: 404 });
      const principal = authMode === "off" ? localPrincipal("dashboard") : await authStore.authenticate(bearerToken(request));
      if (!principal) return json({ error: "unauthorized" }, { status: 401 });
      return json(await authStore.issueWebSocketTicket(principal));
    }
    if (url.pathname === "/api/auth/devices" && (request.method === "GET" || request.method === "POST")) {
      if (authMode !== "enforced") return json({ error: "auth_disabled" }, { status: 404 });
      const principal = await authStore.authenticate(bearerToken(request), "dashboard");
      if (!principal) return json({ error: "unauthorized" }, { status: 401 });
      if (request.method === "GET") {
        return json(authStore.listAccessTokens(principal.ownerId).map((token) => ({
          tokenId: token.token_id,
          role: token.role,
          createdAt: new Date(token.created_at).toISOString(),
          expiresAt: new Date(token.expires_at).toISOString(),
          revokedAt: token.revoked_at ? new Date(token.revoked_at).toISOString() : undefined,
        })));
      }
      const issued = await authStore.issueAccessToken(principal.ownerId, "device");
      return json({ ownerId: principal.ownerId, tokenId: issued.tokenId, deviceToken: issued.token, expiresAt: issued.expiresAt }, { status: 201 });
    }
    const revokeDeviceMatch = url.pathname.match(/^\/api\/auth\/devices\/([^/]+)\/revoke$/);
    if (revokeDeviceMatch && request.method === "POST") {
      if (authMode !== "enforced") return json({ error: "auth_disabled" }, { status: 404 });
      const principal = await authStore.authenticate(bearerToken(request), "dashboard");
      if (!principal) return json({ error: "unauthorized" }, { status: 401 });
      authStore.revokeTokenId(principal.ownerId, revokeDeviceMatch[1]);
      return json({ revoked: true });
    }
    if (url.pathname === "/api/auth/rotate" && request.method === "POST") {
      const token = bearerToken(request);
      const principal = authMode === "off" ? localPrincipal("dashboard") : await authStore.authenticate(token);
      if (!principal || authMode === "off") return json({ error: authMode === "off" ? "auth_disabled" : "unauthorized" }, { status: authMode === "off" ? 404 : 401 });
      return json(await authStore.rotate(token, principal));
    }
    if (url.pathname === "/api/auth/revoke" && request.method === "POST") {
      const token = bearerToken(request);
      const principal = await authStore.authenticate(token);
      if (!principal) return json({ error: "unauthorized" }, { status: 401 });
      await authStore.revoke(token);
      return json({ revoked: true });
    }
    const dashboard = await requestPrincipal(request, "dashboard");
    if (url.pathname === "/api/devices") {
      if (!dashboard) return json({ error: "unauthorized" }, { status: 401 });
      return json([device]);
    }
    if (url.pathname === "/api/routes" && (request.method === "GET" || request.method === "POST")) {
      if (!dashboard) return json({ error: "unauthorized" }, { status: 401 });
      if (request.method === "GET") return json(routeStore.list(dashboard.ownerId, MAX_ROUTES).map(publicRoute));
      if (routes.size >= MAX_ROUTES) return json({ error: "route_limit" }, { status: 429 });
      const body = await parseJson<{ name?: unknown }>(request);
      const name = typeof body?.name === "string" ? body.name.trim().slice(0, MAX_CLIENT_FIELD_LENGTH) : "";
      if (!name) return json({ error: "invalid_route" }, { status: 400 });
      const route = createRoute(dashboard.ownerId, name);
      routes.set(route.routeId, route);
      routeStore.save(route);
      return json(publicRoute(route), { status: 201 });
    }
    const routeMatch = url.pathname.match(/^\/api\/routes\/([^/]+)(?:\/(observations|nodes|publish))?$/);
    if (routeMatch) {
      if (!dashboard) return json({ error: "unauthorized" }, { status: 401 });
      const route = routes.get(routeMatch[1]);
      if (!route || route.ownerId !== dashboard.ownerId) return json({ error: "route_not_found" }, { status: 404 });
      const action = routeMatch[2];
      if (!action && request.method === "GET") return json(publicRoute(route));
      if (!action && request.method === "DELETE") {
        routes.delete(route.routeId);
        routeStore.delete(dashboard.ownerId, route.routeId);
        return json({ deleted: true });
      }
      if (action === "observations" && request.method === "POST") {
        const body = await parseJson<{ sessionId?: unknown }>(request);
        const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
        const session = sessions.get(sessionId);
        if (!session || !sessionBelongsTo(session, dashboard)) return json({ error: "session_not_found" }, { status: 404 });
        try {
          attachObservation(route, session);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "route_observation_failed";
          const status = reason === "route_observation_limit" ? 429 : 409;
          return json({ error: reason }, { status });
        }
        routeStore.save(route);
        return json(publicRoute(route));
      }
      if (action === "nodes" && request.method === "POST") {
        if (route.nodeRecords.length >= MAX_ROUTE_NODES) return json({ error: "route_node_limit" }, { status: 429 });
        const node = normalizeRouteNode(await parseJson<unknown>(request));
        if (!node) return json({ error: "invalid_route_node" }, { status: 400 });
        route.nodeRecords.push(node);
        route.nodes = route.nodeRecords.length;
        route.updatedAt = new Date().toISOString();
        routeStore.save(route);
        return json(publicRoute(route), { status: 201 });
      }
      if (action === "publish" && request.method === "POST") {
        const repeatedObservations = route.observationSummaries.filter((observation) => observation.alignment.method !== "reference");
        const aligned = route.observations >= 3
          && Boolean(route.referenceSessionId)
          && route.track.length > 1
          && route.poseTrack.length > 1
          && repeatedObservations.length >= 2
          && repeatedObservations.every((observation) => observation.alignment.status === "matched");
        if (!aligned) return json({ error: "route_alignment_required" }, { status: 409 });
        route.status = "verified";
        route.updatedAt = new Date().toISOString();
        routeStore.save(route);
        return json(publicRoute(route));
      }
      return json({ error: "route_not_found" }, { status: 404 });
    }
    if (url.pathname === "/api/sessions" && request.method === "GET") {
      if (!dashboard) return json({ error: "unauthorized" }, { status: 401 });
      return json([...sessions.values()]
        .filter((session) => sessionBelongsTo(session, dashboard))
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .map(sessionListView));
    }
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const devicePrincipal = await requestPrincipal(request, "device");
      if (!devicePrincipal) return json({ error: "unauthorized" }, { status: 401 });
      const input = await parseJson<CreateSessionInput>(request);
      if (!input || typeof input.deviceId !== "string" || (input.mode !== "learning" && input.mode !== "navigation")) return json({ error: "invalid_session" }, { status: 400 });
      let session: ObservationSession;
      try {
        session = createSession(input, devicePrincipal.ownerId);
      } catch (error) {
        if (error instanceof Error && error.message === "session_limit") return json({ error: "session_limit" }, { status: 429 });
        if (error instanceof Error && error.message === "invalid_session") return json({ error: "invalid_session" }, { status: 400 });
        if (error instanceof Error && error.message === "invalid_route") return json({ error: "invalid_route" }, { status: 404 });
        if (error instanceof Error && error.message === "invalid_navigation_route") return json({ error: "invalid_navigation_route" }, { status: 409 });
        throw error;
      }
      return json(session, { status: 201 });
    }

    const rawSessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/raw$/);
    if (rawSessionMatch && request.method === "GET") {
      if (!dashboard) return json({ error: "unauthorized" }, { status: 401 });
      const sessionId = rawSessionMatch[1];
      const session = getSession(sessionId);
      if (!session || !sessionBelongsTo(session, dashboard)) return json({ error: "session_not_found" }, { status: 404 });
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
      const actor = url.pathname.endsWith("/samples") || url.pathname.endsWith("/stop")
        ? await requestPrincipal(request, "device")
        : dashboard;
      if (!actor) return json({ error: "unauthorized" }, { status: 401 });
      if (!session || !sessionBelongsTo(session, actor)) return json({ error: "session_not_found" }, { status: 404 });
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
      if (request.method === "GET") {
        if (url.searchParams.get("view") === "summary") return json(sessionListView(session));
        if (url.searchParams.get("view") === "integrity") return json(sessionIntegrityView(session));
        return json(session);
      }
    }
    return json({ error: "not_found" }, { status: 404 });
  },
  websocket: {
    idleTimeout: 120,
    open(ws) {
      if (ws.data.role === "dashboard") ws.subscribe(dashboardTopic(ws.data.ownerId));
    },
    message(ws, raw) {
      if (String(raw).length > MAX_JSON_BYTES) {
        ws.send(JSON.stringify({ type: "error", error: "message_too_large" }));
        return;
      }
      let message: { type?: string; deviceId?: string; mode?: CreateSessionInput["mode"]; routeId?: string; sessionId?: string; samples?: unknown[]; sensors?: unknown[]; client?: CreateSessionInput["client"] };
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
            sensors: message.sensors as SensorInventoryEntry[] | undefined,
            client: message.client,
          }, ws.data.ownerId);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "session_start_failed";
          ws.send(JSON.stringify({ type: "error", error: reason === "session_limit" || reason === "invalid_route" || reason === "invalid_navigation_route" ? reason : "session_start_failed" }));
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
        if (!session || session.status !== "active" || session.deviceId !== deviceId || !sessionBelongsTo(session, ws.data)) {
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
        if (!session || session.status !== "active" || !sessionBelongsTo(session, ws.data) || !Array.isArray(samples) || samples.length > 500) {
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
        if (session && sessionBelongsTo(session, ws.data)) {
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
