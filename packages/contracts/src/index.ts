export type SensorType =
  | "accelerometer"
  | "linear-acceleration"
  | "gyroscope"
  | "magnetometer"
  | "barometer"
  | "gnss"
  | "rotation-vector"
  | "camera"
  | "depth";

export type SensorStatus = "ready" | "limited" | "unavailable";

export interface SensorCapability {
  type: SensorType;
  label: string;
  status: SensorStatus;
  frequencyHz?: number;
  note?: string;
}

export interface TrackPoint {
  deviceTimestampNs?: number;
  lat: number;
  lng: number;
  accuracyM: number;
  confidence: number;
  source: "gnss" | "fused" | "visual" | "manual";
  altitudeM?: number;
  altitudeSource?: "gnss" | "barometer";
  locationProvider?: string;
}

export interface RelativeMotionPoint {
  deviceTimestampNs: number;
  xM: number;
  yM: number;
  zM: number;
  accuracyM: number;
  confidence: number;
  source: "inertial" | "visual" | "fused";
}

export interface DeviceSnapshot {
  deviceId: string;
  label: string;
  connected: boolean;
  batteryPercent: number;
  temperatureC: number;
  lastSeen: string;
  locationQuality: "high" | "medium" | "low";
  sensors: SensorCapability[];
}

export interface RouteSummary {
  routeId: string;
  name: string;
  status: "draft" | "verified" | "archived";
  distanceM: number;
  observations: number;
  nodes: number;
  confidence: number;
  updatedAt: string;
  track: TrackPoint[];
  poseTrack: PoseEstimate[];
  referenceSessionId?: string;
  observationSummaries: RouteObservationSummary[];
  nodeRecords: RouteNode[];
}

export interface RouteObservationSummary {
  sessionId: string;
  startedAt: string;
  sampleCount: number;
  rawSampleCount: number;
  poseCount: number;
  locationPointCount: number;
  motionMode: MotionMode;
  sourceFlags: string[];
  attachedAt: string;
  alignment: RouteAlignmentSummary;
}

export interface RouteAlignmentSummary {
  method: "reference" | "gnss-nearest";
  status: "reference" | "matched" | "unavailable";
  matchedPoints: number;
  coverage: number;
  residualM?: number;
}

export type RouteNodeType = "start" | "turn" | "door" | "stairs" | "elevator" | "crossing" | "landmark" | "hazard" | "end";

export interface RouteNode {
  nodeId: string;
  nodeType: RouteNodeType;
  instruction: string;
  xM: number;
  yM: number;
  zM: number;
  lat?: number;
  lng?: number;
  confidence: number;
  manualAnnotation: boolean;
  createdAt: string;
}

export type NavigationStatus = "on-route" | "near-route" | "off-route" | "no-fix" | "route-not-ready";

export interface NavigationState {
  routeId: string;
  status: NavigationStatus;
  progressM?: number;
  remainingM?: number;
  distanceToRouteM?: number;
  nearestPointIndex?: number;
  nearestLat?: number;
  nearestLng?: number;
  nearestAltitudeM?: number;
  altitudeDeltaM?: number;
  accuracyM?: number;
  updatedAt: string;
}

export interface NavigationHandoffGrant {
  handoffId: string;
  routeId: string;
  token: string;
  expiresAt: string;
}

export type ObservationMode = "learning" | "navigation";

export type MotionMode =
  | "stationary"
  | "walking"
  | "stairs"
  | "elevator"
  | "vehicle"
  | "unknown";

export type PoseSource = "imu" | "gnss" | "barometer" | "visual" | "fused";
export type PoseFrame = "local-enu" | "arcore-local";

/**
 * The only trajectory point the product is allowed to use as its primary
 * route. Raw sensor samples and legacy relative points remain diagnostic data.
 */
export interface PoseEstimate {
  deviceTimestampNs: number;
  xM: number;
  yM: number;
  zM: number;
  velocityXMps: number;
  velocityYMps: number;
  velocityZMps: number;
  accuracyM: number;
  verticalAccuracyM?: number;
  confidence: number;
  source: PoseSource;
  frame?: PoseFrame;
  sourceFlags: string[];
  motionMode: MotionMode;
  stationary: boolean;
}

export interface MotionEvent {
  eventId: string;
  deviceTimestampNs: number;
  type: "stationary-enter" | "stationary-exit" | "stairs-enter" | "stairs-exit" | "elevator-candidate" | "elevator-exit" | "loop-candidate" | "loop-closed";
  confidence: number;
  details?: Record<string, number | string | boolean>;
}

export interface LoopCorrection {
  xM: number;
  yM: number;
  zM: number;
  startTimestampNs: number;
  endTimestampNs: number;
}

export interface ClosureAnchor {
  deviceTimestampNs: number;
  xM: number;
  yM: number;
  zM: number;
  accuracyM: number;
}

export interface ClosureState {
  status: "open" | "candidate" | "closed";
  gapM?: number;
  confidence: number;
  adjusted: boolean;
  anchor?: ClosureAnchor;
  travelledM?: number;
  correction?: LoopCorrection;
}

export interface SensorSample {
  /** Stable per-sample id used to make crash recovery duplicate-tolerant. */
  sampleId?: string;
  deviceTimestampNs: number;
  sensorType: string;
  /** Android Sensor.getId() when the sample came from a concrete hardware stream. */
  sensorId?: number;
  values: number[];
  /** Bounded primitive diagnostics retained for deterministic raw replay. */
  metadata?: Record<string, number | string | boolean>;
  sensorAccuracy?: number;
  accuracy?: number;
  location?: {
    lat: number;
    lng: number;
    accuracyM?: number;
    altitudeM?: number;
    provider?: string;
  };
  relativePosition?: {
    xM: number;
    yM: number;
    zM: number;
    accuracyM?: number;
  };
  pose?: PoseEstimate;
  motionEvent?: MotionEvent;
}

export interface LiveSensorSnapshot {
  sensorType: string;
  values: number[];
  /** Bounded primitive diagnostics for low-latency device health display. */
  metadata?: Record<string, number | string | boolean>;
  sensorAccuracy?: number;
  accuracy?: number;
  sampleCount: number;
  lastDeviceTimestampNs: number;
  lastReceivedAt: string;
}

export interface SensorSampleStats {
  sensorType: string;
  sampleCount: number;
  firstDeviceTimestampNs: number;
  lastDeviceTimestampNs: number;
  lastSensorAccuracy?: number;
}

export interface SensorInventoryEntry {
  sensorType: string;
  /** Android Sensor.getId(), retained so same-type physical sensors remain distinguishable. */
  sensorId?: number;
  name: string;
  vendor?: string;
  version?: number;
  powerMa?: number;
  maximumRange?: number;
  resolution?: number;
  minDelayUs?: number;
  maxDelayUs?: number;
  fifoReservedEventCount?: number;
  fifoMaxEventCount?: number;
  reportingMode?: number;
  wakeUpSensor?: boolean;
  dynamicSensor?: boolean;
  transportMaxHz?: number;
  registered: boolean;
}

export interface CaptureClientInfo {
  applicationId: string;
  versionName: string;
  buildType: "debug" | "release" | "unknown";
  apiBaseUrl: string;
}

export interface CreateSessionInput {
  deviceId: string;
  mode: ObservationMode;
  routeId?: string;
  sensors?: SensorInventoryEntry[];
  client?: CaptureClientInfo;
}

export interface ObservationSession {
  sessionId: string;
  deviceId: string;
  mode: ObservationMode;
  ownerId: string;
  client?: CaptureClientInfo;
  routeId?: string;
  navigation?: NavigationState;
  startedAt: string;
  lastReceivedAt?: string;
  lastSampleAt?: string;
  sampleCount: number;
  rawSampleCount: number;
  droppedSampleCount: number;
  outOfOrderSampleCount: number;
  latestLocation?: SensorSample["location"];
  latestAltitudeM?: number;
  altitudeSource?: "gnss" | "barometer";
  track: TrackPoint[];
  relativeTrack: RelativeMotionPoint[];
  poseTrack: PoseEstimate[];
  correctedPoseTrack?: PoseEstimate[];
  latestPose?: PoseEstimate;
  motionMode: MotionMode;
  closure: ClosureState;
  motionEvents: MotionEvent[];
  sensorInventory: SensorInventoryEntry[];
  sensorStats: SensorSampleStats[];
  latestRelativePosition?: RelativeMotionPoint;
  latestSensors: LiveSensorSnapshot[];
  /** Present on the lightweight session list view; full snapshots use array lengths. */
  locationPointCount?: number;
  relativePointCount?: number;
  posePointCount?: number;
  correctedPosePointCount?: number;
  status: "active" | "stopped";
}

export interface SessionDelta {
  type: "session.delta";
  sessionId: string;
  status: ObservationSession["status"];
  lastReceivedAt?: string;
  lastSampleAt?: string;
  sampleCount: number;
  rawSampleCount: number;
  droppedSampleCount: number;
  outOfOrderSampleCount: number;
  latestLocation?: ObservationSession["latestLocation"];
  latestAltitudeM?: number;
  altitudeSource?: ObservationSession["altitudeSource"];
  latestRelativePosition?: ObservationSession["latestRelativePosition"];
  trackPoints: TrackPoint[];
  relativePoints: RelativeMotionPoint[];
  posePoints: PoseEstimate[];
  correctedPosePoints?: PoseEstimate[];
  latestPose?: ObservationSession["latestPose"];
  motionMode: ObservationSession["motionMode"];
  closure: ObservationSession["closure"];
  motionEvents: MotionEvent[];
  sensorInventory: SensorInventoryEntry[];
  sensorStats: SensorSampleStats[];
  latestSensors: LiveSensorSnapshot[];
  navigation?: NavigationState;
}
