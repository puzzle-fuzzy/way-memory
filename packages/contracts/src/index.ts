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
  status: "draft" | "verified";
  distanceM: number;
  observations: number;
  nodes: number;
  confidence: number;
  updatedAt: string;
  track: TrackPoint[];
}

export type ObservationMode = "learning" | "navigation";

export interface SensorSample {
  deviceTimestampNs: number;
  sensorType: string;
  values: number[];
  accuracy?: number;
  location?: {
    lat: number;
    lng: number;
    accuracyM?: number;
    altitudeM?: number;
  };
  relativePosition?: {
    xM: number;
    yM: number;
    zM: number;
    accuracyM?: number;
  };
}

export interface LiveSensorSnapshot {
  sensorType: string;
  values: number[];
  accuracy?: number;
  sampleCount: number;
  lastDeviceTimestampNs: number;
  lastReceivedAt: string;
}

export interface CreateSessionInput {
  deviceId: string;
  mode: ObservationMode;
  routeId?: string;
}

export interface ObservationSession {
  sessionId: string;
  deviceId: string;
  mode: ObservationMode;
  routeId?: string;
  startedAt: string;
  lastReceivedAt?: string;
  lastSampleAt?: string;
  sampleCount: number;
  droppedSampleCount: number;
  latestLocation?: SensorSample["location"];
  latestAltitudeM?: number;
  altitudeSource?: "gnss" | "barometer";
  track: TrackPoint[];
  relativeTrack: RelativeMotionPoint[];
  latestRelativePosition?: RelativeMotionPoint;
  latestSensors: LiveSensorSnapshot[];
  status: "active" | "stopped";
}
