export type SensorType =
  | "accelerometer"
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
  lat: number;
  lng: number;
  accuracyM: number;
  confidence: number;
  source: "gnss" | "fused" | "visual" | "manual";
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
  sensorType: SensorType | "location";
  values: number[];
  accuracy?: number;
  location?: {
    lat: number;
    lng: number;
    accuracyM?: number;
    altitudeM?: number;
  };
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
  sampleCount: number;
  latestLocation?: SensorSample["location"];
  status: "active" | "stopped";
}
