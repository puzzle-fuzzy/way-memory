<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { LiveSensorSnapshot, TrackPoint } from "@way-memory/contracts";
import { useRealtimeSession } from "./composables/useRealtimeSession";
import { useRoutes } from "./composables/useRoutes";

const { connection, authRequired, authenticated, latestSession, availableSessions, selectedSessionId, followingLive, selectSession, followLatest, setAuthToken, enrollDevice } = useRealtimeSession();
const { routes, routeBusy, routeError, refreshRoutes, createRoute, attachObservation, publishRoute } = useRoutes();
const dashboardToken = ref("");
const newDeviceToken = ref("");
const enrollmentError = ref("");
const enrollmentBusy = ref(false);
const selectedRouteId = ref("");
const routeName = ref("盲人路线");
const routeActionError = ref("");
const routeManagementAvailable = computed(() => !authRequired.value || authenticated.value);
const selectedRoute = computed(() => routes.value.find((route) => route.routeId === selectedRouteId.value));

async function createDeviceCredential() {
  enrollmentBusy.value = true;
  enrollmentError.value = "";
  try {
    newDeviceToken.value = (await enrollDevice()).deviceToken;
  } catch (error) {
    enrollmentError.value = error instanceof Error ? error.message : "设备 enrollment 失败";
  } finally {
    enrollmentBusy.value = false;
  }
}

async function createRouteRecord() {
  routeActionError.value = "";
  try {
    const route = await createRoute(routeName.value.trim() || "盲人路线");
    selectedRouteId.value = route.routeId;
  } catch (error) {
    routeActionError.value = error instanceof Error ? error.message : "路线创建失败";
  }
}

async function bindCurrentObservation() {
  if (!selectedRoute.value || !session.value || session.value.status !== "stopped") return;
  routeActionError.value = "";
  try {
    await attachObservation(selectedRoute.value.routeId, session.value.sessionId);
  } catch (error) {
    routeActionError.value = error instanceof Error ? error.message : "观测绑定失败";
  }
}

async function verifySelectedRoute() {
  if (!selectedRoute.value) return;
  routeActionError.value = "";
  try {
    await publishRoute(selectedRoute.value.routeId);
  } catch (error) {
    routeActionError.value = error instanceof Error ? error.message : "路线尚未满足发布条件";
  }
}

const connectionLabel = computed(() => ({
  connecting: "连接中",
  connected: "实时同步",
  offline: "服务端离线",
}[connection.value]));

const session = computed(() => latestSession.value);
const hasSession = computed(() => Boolean(session.value));
const isCollecting = computed(() => session.value?.status === "active");
const sessionLabel = computed(() => {
  if (!session.value) return "等待 Android 连接";
  return isCollecting.value ? "Android 正在采集" : "最近一次采集已结束";
});

const sessionHistoryLabel = (item: { status: string; startedAt: string; poseTrack?: unknown[]; posePointCount?: number; sampleCount: number }) => {
  const time = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(item.startedAt));
  return `${item.status === "active" ? "LIVE" : "已结束"} · ${time} · ${item.posePointCount ?? item.poseTrack?.length ?? 0} Pose · ${item.sampleCount} samples`;
};

const onSessionChange = (event: Event) => {
  const value = (event.target as HTMLSelectElement).value;
  if (value) void selectSession(value);
};

const locationLabel = computed(() => {
  const location = session.value?.latestLocation;
  if (!location) return "等待位置样本";
  const altitudeM = session.value?.latestAltitudeM;
  const altitude = typeof altitudeM === "number" ? ` · Z ${altitudeM >= 0 ? "+" : ""}${altitudeM.toFixed(1)}m` : "";
  return `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}${altitude}`;
});

const routeLabel = computed(() => {
  if (!session.value) return "等待 Android 会话";
  return session.value.routeId ? `路线 ${session.value.routeId}` : "未绑定路线";
});

const routeStatusLabel = computed(() => {
  if (!session.value) return "未开始";
  return isCollecting.value ? "实时采集中" : "已停止";
});

const navigationLabel = computed(() => {
  const navigation = session.value?.navigation;
  if (!navigation) return "";
  const progress = typeof navigation.progressM === "number" ? `${navigation.progressM.toFixed(1)}m` : "等待定位";
  const distance = typeof navigation.distanceToRouteM === "number" ? ` · 偏离 ${navigation.distanceToRouteM.toFixed(1)}m` : "";
  return `导航 ${navigation.status} · ${progress}${distance}`;
});

const track = computed(() => session.value?.track ?? []);
const relativeTrack = computed(() => session.value?.relativeTrack ?? []);
const poseTrack = computed(() => session.value?.poseTrack ?? []);
const correctedPoseTrack = computed(() => session.value?.closure.adjusted && session.value.correctedPoseTrack?.length
  ? session.value.correctedPoseTrack
  : poseTrack.value);
const totalSampleCount = computed(() => session.value?.sampleCount ?? 0);
const locationPointCount = computed(() => track.value.length);
const motionPointCount = computed(() => relativeTrack.value.length);
const posePointCount = computed(() => correctedPoseTrack.value.length);
const displayedPointCount = computed(() => visualMode.value === "fused" ? posePointCount.value : visualMode.value === "inertial" ? motionPointCount.value : locationPointCount.value);
const visualMode = computed<"fused" | "location" | "inertial" | "empty">(() => {
  if (poseTrack.value.length > 1) return "fused";
  if (relativeTrack.value.length > 1) return "inertial";
  if (track.value.length) return "location";
  return "empty";
});
const coordinateBoundsLabel = computed(() => {
  if (visualMode.value === "fused") {
    const east = correctedPoseTrack.value.map((point) => point.xM);
    const north = correctedPoseTrack.value.map((point) => point.yM);
    const up = correctedPoseTrack.value.map((point) => point.zM);
    return `x ${Math.min(...east).toFixed(2)}–${Math.max(...east).toFixed(2)}m · y ${Math.min(...north).toFixed(2)}–${Math.max(...north).toFixed(2)}m · z ${Math.min(...up).toFixed(2)}–${Math.max(...up).toFixed(2)}m`;
  }
  if (visualMode.value === "inertial") {
    const east = relativeTrack.value.map((point) => point.xM);
    const north = relativeTrack.value.map((point) => point.yM);
    const up = relativeTrack.value.map((point) => point.zM);
    return `x ${Math.min(...east).toFixed(2)}…${Math.max(...east).toFixed(2)}m · y ${Math.min(...north).toFixed(2)}…${Math.max(...north).toFixed(2)}m · z ${Math.min(...up).toFixed(2)}…${Math.max(...up).toFixed(2)}m`;
  }
  if (!track.value.length) return "等待真实定位点";
  const latitudes = track.value.map((point) => point.lat);
  const longitudes = track.value.map((point) => point.lng);
  return `lat ${Math.min(...latitudes).toFixed(6)}…${Math.max(...latitudes).toFixed(6)} · lng ${Math.min(...longitudes).toFixed(6)}…${Math.max(...longitudes).toFixed(6)}`;
});

const haversineDistanceM = (left: TrackPoint, right: TrackPoint) => {
  const earthRadiusM = 6371000;
  const toRadians = (value: number) => value * Math.PI / 180;
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);
  const dLat = lat2 - lat1;
  const dLng = toRadians(right.lng - left.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
};

const routeDistanceM = computed(() => {
  if (visualMode.value === "fused") {
    let distance = 0;
    for (let index = 1; index < correctedPoseTrack.value.length; index += 1) {
      const previous = correctedPoseTrack.value[index - 1];
      const current = correctedPoseTrack.value[index];
      distance += Math.sqrt(
        (current.xM - previous.xM) ** 2
        + (current.yM - previous.yM) ** 2
        + (current.zM - previous.zM) ** 2,
      );
    }
    return Math.round(distance);
  }
  if (visualMode.value === "inertial") {
    let distance = 0;
    for (let index = 1; index < relativeTrack.value.length; index += 1) {
      const previous = relativeTrack.value[index - 1];
      const current = relativeTrack.value[index];
      distance += Math.sqrt(
        (current.xM - previous.xM) ** 2
        + (current.yM - previous.yM) ** 2
        + (current.zM - previous.zM) ** 2,
      );
    }
    return Math.round(distance);
  }
  let distance = 0;
  for (let index = 1; index < track.value.length; index += 1) {
    const planarDistance = haversineDistanceM(track.value[index - 1], track.value[index]);
    const heightDelta = (track.value[index].altitudeM ?? 0) - (track.value[index - 1].altitudeM ?? 0);
    distance += Math.sqrt(planarDistance ** 2 + heightDelta ** 2);
  }
  return Math.round(distance);
});

const altitudeValues = computed(() => visualMode.value === "inertial"
  ? relativeTrack.value.map((point) => point.zM)
  : visualMode.value === "fused"
    ? poseTrack.value.map((point) => point.zM)
  : track.value.flatMap((point) => typeof point.altitudeM === "number" ? [point.altitudeM] : []));
const hasAltitude = computed(() => altitudeValues.value.length > 0);
const altitudeDeltaM = computed(() => {
  if (!altitudeValues.value.length) return null;
  return Math.max(...altitudeValues.value) - Math.min(...altitudeValues.value);
});
const latestAltitudeLabel = computed(() => {
  const altitudeM = session.value?.latestAltitudeM;
  if (typeof altitudeM !== "number") return "等待高度数据";
  return `${altitudeM >= 0 ? "+" : ""}${altitudeM.toFixed(1)}m`;
});
const altitudeSourceLabel = computed(() => {
  if (visualMode.value === "fused") return session.value?.latestPose?.sourceFlags.join("+") ?? "fused pose";
  if (visualMode.value === "inertial") return "传感器融合 Z 轴";
  return session.value?.altitudeSource === "gnss" ? "GNSS 相对高度" : session.value?.altitudeSource === "barometer" ? "气压计相对高度" : "尚未建立 Z 轴";
});

const poseFrameLabel = computed(() => {
  const frame = session.value?.latestPose?.frame;
  if (frame === "arcore-local") return "ARCore 局部坐标 · 尚未对齐 ENU";
  if (frame === "local-enu") return "统一局部 ENU 坐标";
  return "等待坐标参考系";
});

const confidencePercent = computed(() => {
  const accuracyM = session.value?.latestLocation?.accuracyM;
  if (typeof accuracyM !== "number") return null;
  return Math.round(Math.min(1, Math.max(0, 1 - accuracyM / 50)) * 100);
});

const formatTime = (value?: string) => {
  if (!value) return "等待数据";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
};

const formatSensorValues = (sensor: LiveSensorSnapshot) => {
  if (sensor.sensorType === "gnss") {
    return typeof sensor.accuracy === "number" ? `精度 ${sensor.accuracy.toFixed(1)}m` : "已收到定位";
  }
  const values = sensor.values.slice(0, 3).map((value) => value.toFixed(2)).join(", ");
  return `${values || "无数值"} · ${sensor.sampleCount} 个样本`;
};

const sensorNames: Record<string, string> = {
  accelerometer: "加速度计",
  "linear-acceleration": "线性加速度",
  gyroscope: "陀螺仪",
  magnetometer: "磁力计",
  barometer: "气压计",
  gnss: "GNSS 定位",
  "rotation-vector": "旋转向量",
};

const sensorIcons: Record<string, string> = {
  accelerometer: "↗",
  "linear-acceleration": "⇢",
  gyroscope: "⟳",
  magnetometer: "⌁",
  barometer: "◒",
  gnss: "⌖",
  "rotation-vector": "◌",
};

const sensors = computed(() => (session.value?.latestSensors ?? []).map((sensor) => ({
  ...sensor,
  label: sensorNames[sensor.sensorType] ?? sensor.sensorType,
  icon: sensorIcons[sensor.sensorType] ?? "·",
  detail: formatSensorValues(sensor),
})));
const sensorInventory = computed(() => session.value?.sensorInventory ?? []);
const registeredSensorCount = computed(() => sensorInventory.value.filter((sensor) => sensor.registered).length);
const sensorTypeCount = computed(() => Math.max(sensorInventory.value.length, session.value?.sensorStats?.length ?? 0, sensors.value.length));

const cameraYaw = ref(-0.72);
const cameraPitch = ref(0.62);
const dragState = ref<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
const pointCanvas = ref<HTMLCanvasElement | null>(null);
const pointCanvasHost = ref<HTMLElement | null>(null);
let canvasResizeObserver: ResizeObserver | undefined;
let canvasDrawFrame: number | undefined;
let canvasDrawTimer: number | undefined;
let lastCanvasDrawAt = 0;
const CANVAS_FRAME_INTERVAL_MS = 1000 / 60;

const beginCameraDrag = (event: PointerEvent) => {
  const target = event.currentTarget as HTMLElement | null;
  target?.setPointerCapture(event.pointerId);
  dragState.value = { x: event.clientX, y: event.clientY, yaw: cameraYaw.value, pitch: cameraPitch.value };
};

const moveCameraDrag = (event: PointerEvent) => {
  if (!dragState.value) return;
  cameraYaw.value = dragState.value.yaw + (event.clientX - dragState.value.x) * 0.008;
  cameraPitch.value = Math.min(1.15, Math.max(0.3, dragState.value.pitch + (event.clientY - dragState.value.y) * 0.006));
};

const endCameraDrag = () => { dragState.value = null; };
const resetCamera = () => { cameraYaw.value = -0.72; cameraPitch.value = 0.62; };

type WorldPoint = {
  index: number;
  eastM: number;
  northM: number;
  altitudeM: number;
  hasAltitude: boolean;
  accuracyM: number;
};

type ProjectedWorldPoint = WorldPoint & {
  x: number;
  y: number;
  depth: number;
  perspective: number;
};

type ProjectionSegment = {
  left: ProjectedWorldPoint;
  right: ProjectedWorldPoint;
  depth: number;
};

type ProjectionAxis = {
  start: ProjectedWorldPoint;
  end: ProjectedWorldPoint;
  color: string;
  label: string;
};

type ProjectionScene = {
  points: ProjectedWorldPoint[];
  projectPoint: (point: WorldPoint) => ProjectedWorldPoint;
  gridSegments: ProjectionSegment[];
  axes: ProjectionAxis[];
  gridRadiusM: number;
  gridStepM: number;
  axisLengthM: number;
  altitudeMinM: number;
  altitudeMaxM: number;
};

const chooseGridStep = (radiusM: number) => {
  if (radiusM <= 3) return 0.5;
  if (radiusM <= 12) return 1;
  if (radiusM <= 30) return 5;
  if (radiusM <= 75) return 10;
  return 25;
};

const sceneWorldPoint = (eastM: number, northM: number, altitudeM: number): WorldPoint => ({
  index: -1,
  eastM,
  northM,
  altitudeM,
  hasAltitude: true,
  accuracyM: 0,
});

const buildProjectionScene = (worldPoints: WorldPoint[]): ProjectionScene => {
  if (!worldPoints.length) {
    const emptyPoint = { index: -1, eastM: 0, northM: 0, altitudeM: 0, hasAltitude: true, accuracyM: 0 };
    return {
      points: [],
      projectPoint: (point) => ({ ...point, x: 310, y: 165, depth: 0, perspective: 1 }),
      gridSegments: [],
      axes: [],
      gridRadiusM: 2,
      gridStepM: 0.5,
      axisLengthM: 2.4,
      altitudeMinM: emptyPoint.altitudeM,
      altitudeMaxM: emptyPoint.altitudeM,
    };
  }

  const eastValues = worldPoints.map((point) => point.eastM).concat(0);
  const northValues = worldPoints.map((point) => point.northM).concat(0);
  const altitudeValues = worldPoints.filter((point) => point.hasAltitude).map((point) => point.altitudeM).concat(0);
  const eastMin = Math.min(...eastValues);
  const eastMax = Math.max(...eastValues);
  const northMin = Math.min(...northValues);
  const northMax = Math.max(...northValues);
  const altitudeMinM = Math.min(...altitudeValues);
  const altitudeMaxM = Math.max(...altitudeValues);
  const eastCenter = (eastMin + eastMax) / 2;
  const northCenter = (northMin + northMax) / 2;
  const altitudeCenter = (altitudeMinM + altitudeMaxM) / 2;
  const horizontalRadius = Math.max(Math.abs(eastMin), Math.abs(eastMax), Math.abs(northMin), Math.abs(northMax), 2);
  const gridRadiusM = Math.min(100, Math.max(2, horizontalRadius * 1.15));
  const gridStepM = chooseGridStep(gridRadiusM);
  const axisLengthM = gridRadiusM * 1.08;
  const worldExtent = Math.max(eastMax - eastMin, northMax - northMin, (altitudeMaxM - altitudeMinM) * 1.35, 4);
  const viewScale = 128 / worldExtent;
  const focalLength = Math.max(8, worldExtent * 2.4);
  const yawCos = Math.cos(cameraYaw.value);
  const yawSin = Math.sin(cameraYaw.value);
  const pitchSin = Math.sin(cameraPitch.value);
  const pitchCos = Math.cos(cameraPitch.value);

  const projectPoint = (point: WorldPoint): ProjectedWorldPoint => {
    const centeredEast = point.eastM - eastCenter;
    const centeredNorth = point.northM - northCenter;
    const centeredAltitude = (point.hasAltitude ? point.altitudeM : 0) - altitudeCenter;
    const rotatedX = centeredEast * yawCos - centeredNorth * yawSin;
    const forward = centeredEast * yawSin + centeredNorth * yawCos;
    const vertical = forward * pitchSin + centeredAltitude * pitchCos;
    const depth = forward * pitchCos - centeredAltitude * pitchSin;
    const perspective = Math.min(1.45, Math.max(0.68, focalLength / (focalLength + depth)));
    return {
      ...point,
      x: 310 + rotatedX * viewScale * perspective,
      y: 165 - vertical * viewScale * perspective,
      depth,
      perspective,
    };
  };

  const gridSegments: ProjectionSegment[] = [];
  for (let coordinate = -gridRadiusM; coordinate <= gridRadiusM + gridStepM * 0.5; coordinate += gridStepM) {
    const xLeft = sceneWorldPoint(coordinate, -gridRadiusM, 0);
    const xRight = sceneWorldPoint(coordinate, gridRadiusM, 0);
    const yLeft = sceneWorldPoint(-gridRadiusM, coordinate, 0);
    const yRight = sceneWorldPoint(gridRadiusM, coordinate, 0);
    const xLeftProjection = projectPoint(xLeft);
    const xRightProjection = projectPoint(xRight);
    const yLeftProjection = projectPoint(yLeft);
    const yRightProjection = projectPoint(yRight);
    gridSegments.push(
      { left: xLeftProjection, right: xRightProjection, depth: (xLeftProjection.depth + xRightProjection.depth) / 2 },
      { left: yLeftProjection, right: yRightProjection, depth: (yLeftProjection.depth + yRightProjection.depth) / 2 },
    );
  }
  gridSegments.sort((left, right) => left.depth - right.depth);
  const origin = projectPoint(sceneWorldPoint(0, 0, 0));
  const axes: ProjectionAxis[] = [
    { start: origin, end: projectPoint(sceneWorldPoint(axisLengthM, 0, 0)), color: "#e05c3b", label: "X" },
    { start: origin, end: projectPoint(sceneWorldPoint(0, axisLengthM, 0)), color: "#3f8b68", label: "Y" },
    { start: origin, end: projectPoint(sceneWorldPoint(0, 0, axisLengthM)), color: "#6384a5", label: "Z" },
  ];

  return {
    points: worldPoints.map(projectPoint),
    projectPoint,
    gridSegments,
    axes,
    gridRadiusM,
    gridStepM,
    axisLengthM,
    altitudeMinM,
    altitudeMaxM,
  };
};

const geographicWorldTrack = computed(() => {
  if (!track.value.length) return [];
  const origin = track.value[0];
  const originLatRad = origin.lat * Math.PI / 180;
  return track.value.map((point, index) => ({
    index,
    eastM: (point.lng - origin.lng) * Math.PI / 180 * 6371000 * Math.cos(originLatRad),
    northM: (point.lat - origin.lat) * Math.PI / 180 * 6371000,
    altitudeM: point.altitudeM ?? 0,
    hasAltitude: typeof point.altitudeM === "number",
    accuracyM: point.accuracyM,
  }));
});

const inertialWorldTrack = computed(() => relativeTrack.value.map((point, index) => ({
  index,
  eastM: point.xM,
  northM: point.yM,
  altitudeM: point.zM,
  hasAltitude: true,
  accuracyM: point.accuracyM,
})));

const fusedWorldTrack = computed(() => correctedPoseTrack.value.map((point, index) => ({
  index,
  eastM: point.xM,
  northM: point.yM,
  altitudeM: point.zM,
  hasAltitude: true,
  accuracyM: point.accuracyM,
})));

const displayedWorldTrack = computed(() => visualMode.value === "fused"
  ? fusedWorldTrack.value
  : visualMode.value === "inertial" ? inertialWorldTrack.value : geographicWorldTrack.value);
const projectionScene = computed(() => buildProjectionScene(displayedWorldTrack.value));
const displayedTrack = computed(() => projectionScene.value.points);

const motionModeLabel = computed(() => ({
  stationary: "静止",
  walking: "步行",
  stairs: "楼梯候选",
  elevator: "电梯候选",
  vehicle: "交通工具",
  unknown: "状态未知",
}[session.value?.motionMode ?? "unknown"]));
const closureLabel = computed(() => {
  const closure = session.value?.closure;
  if (!closure || closure.status === "open") return "未检测到闭环";
  if (closure.status === "closed") return `已闭环 · ${closure.gapM?.toFixed(1) ?? "—"}m`;
  return `闭环候选 · 间隙 ${closure.gapM?.toFixed(1) ?? "—"}m`;
});

const routeRenderModeLabel = computed(() => visualMode.value === "fused"
  ? "传感器融合相对运动点 · 每个圆点对应一个真实样本"
  : "实时定位点展示 · 每个圆点对应一个真实样本");

const drawPointCanvasLegacy = () => {
  const canvas = pointCanvas.value;
  const host = pointCanvasHost.value;
  if (!canvas || !host) return;

  const bounds = host.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(bounds.width));
  const cssHeight = Math.max(1, Math.round(bounds.height));
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(cssWidth * devicePixelRatio));
  const pixelHeight = Math.max(1, Math.round(cssHeight * devicePixelRatio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = "#e9f0eb";
  context.fillRect(0, 0, cssWidth, cssHeight);

  const viewWidth = 620;
  const viewHeight = 300;
  const viewScale = Math.min(cssWidth / viewWidth, cssHeight / viewHeight);
  const offsetX = (cssWidth - viewWidth * viewScale) / 2;
  const offsetY = (cssHeight - viewHeight * viewScale) / 2;
  const toCanvasPoint = (x: number, y: number) => ({
    x: offsetX + x * viewScale,
    y: offsetY + y * viewScale,
  });

  const points = displayedTrack.value;
  if (!points.length) return;

  const currentIndex = points.length - 1;
  const orderedPoints = [...points]
    .filter((point) => point.index !== currentIndex)
    .sort((left, right) => left.depth - right.depth || left.index - right.index);

  for (const point of orderedPoints) {
    const position = toCanvasPoint(point.x, point.y);
    const radius = Math.max(1.8, Math.min(4.5, 5.5 - point.accuracyM * 0.04) * viewScale);
    context.beginPath();
    context.arc(position.x, position.y, radius, 0, Math.PI * 2);
    context.globalAlpha = 0.35 + ((point.index + 1) / Math.max(points.length, 1)) * 0.65;
    context.fillStyle = "#3f8b68";
    context.fill();
    context.globalAlpha = Math.min(1, context.globalAlpha + 0.15);
    context.lineWidth = Math.max(0.75, 1.5 * viewScale);
    context.strokeStyle = "#ffffff";
    context.stroke();
  }

  const firstPoint = toCanvasPoint(points[0].x, points[0].y);
  context.globalAlpha = 1;
  context.beginPath();
  context.arc(firstPoint.x, firstPoint.y, Math.max(4, 8 * viewScale), 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = Math.max(2, 4 * viewScale);
  context.strokeStyle = "#e05c3b";
  context.stroke();
  context.fillStyle = "#19352d";
  context.font = `${Math.max(9, 10 * viewScale)}px Manrope, sans-serif`;
  context.textAlign = "center";
  context.fillText("起点", firstPoint.x, firstPoint.y - Math.max(10, 16 * viewScale));

  const latestPoint = toCanvasPoint(points[currentIndex].x, points[currentIndex].y);
  context.beginPath();
  context.arc(latestPoint.x, latestPoint.y, Math.max(9, 15 * viewScale), 0, Math.PI * 2);
  context.fillStyle = "#e05c3b33";
  context.fill();
  context.lineWidth = Math.max(1, 2 * viewScale);
  context.strokeStyle = "#e05c3b99";
  context.stroke();
  context.beginPath();
  context.arc(latestPoint.x, latestPoint.y, Math.max(3.5, 6 * viewScale), 0, Math.PI * 2);
  context.fillStyle = "#e05c3b";
  context.fill();
};

const drawPointCanvas = () => {
  const canvas = pointCanvas.value;
  const host = pointCanvasHost.value;
  if (!canvas || !host) return;

  const bounds = host.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.round(bounds.width));
  const cssHeight = Math.max(1, Math.round(bounds.height));
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(cssWidth * devicePixelRatio));
  const pixelHeight = Math.max(1, Math.round(cssHeight * devicePixelRatio));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = "#e8f0eb";
  context.fillRect(0, 0, cssWidth, cssHeight);

  const viewWidth = 620;
  const viewHeight = 300;
  const canvasScale = Math.min(cssWidth / viewWidth, cssHeight / viewHeight);
  const offsetX = (cssWidth - viewWidth * canvasScale) / 2;
  const offsetY = (cssHeight - viewHeight * canvasScale) / 2;
  const toCanvasPoint = (x: number, y: number) => ({
    x: offsetX + x * canvasScale,
    y: offsetY + y * canvasScale,
  });

  const scene = projectionScene.value;
  context.setLineDash([2 * canvasScale, 4 * canvasScale]);
  context.strokeStyle = "#b9cec0";
  context.globalAlpha = 0.48;
  context.lineWidth = Math.max(0.5, 0.8 * canvasScale);
  for (const segment of scene.gridSegments) {
    const start = toCanvasPoint(segment.left.x, segment.left.y);
    const end = toCanvasPoint(segment.right.x, segment.right.y);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
  context.setLineDash([]);

  const drawAxis = (axis: ProjectionAxis) => {
    const originProjection = axis.start;
    const endProjection = axis.end;
    const start = toCanvasPoint(originProjection.x, originProjection.y);
    const end = toCanvasPoint(endProjection.x, endProjection.y);
    const direction = Math.atan2(end.y - start.y, end.x - start.x);
    const headSize = 7 * canvasScale;
    context.save();
    context.globalAlpha = 0.96;
    context.strokeStyle = axis.color;
    context.fillStyle = axis.color;
    context.lineWidth = Math.max(1.1, 2 * canvasScale);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(end.x - Math.cos(direction - 0.5) * headSize, end.y - Math.sin(direction - 0.5) * headSize);
    context.lineTo(end.x - Math.cos(direction + 0.5) * headSize, end.y - Math.sin(direction + 0.5) * headSize);
    context.closePath();
    context.fill();
    context.font = `${Math.max(10, 12 * canvasScale)}px Manrope, sans-serif`;
    context.textAlign = "center";
    context.fillText(axis.label, end.x, end.y - 8 * canvasScale);
    context.restore();
  };
  scene.axes.forEach(drawAxis);

  const points = displayedTrack.value;
  if (!points.length) return;

  const currentIndex = points.length - 1;
  const orderedPoints = [...points]
    .filter((point) => point.index !== currentIndex)
    .sort((left, right) => left.depth - right.depth || left.index - right.index);
  const altitudeRange = Math.max(0.001, scene.altitudeMaxM - scene.altitudeMinM);
  const worldPoints = displayedWorldTrack.value;

  for (const point of orderedPoints) {
    const source = worldPoints[point.index];
    if (!source?.hasAltitude || Math.abs(source.altitudeM) < 0.15 || point.index % 4 !== 0) continue;
    const groundProjection = scene.projectPoint({ ...source, altitudeM: 0, hasAltitude: true });
    const pointProjection = point;
    const start = toCanvasPoint(groundProjection.x, groundProjection.y);
    const end = toCanvasPoint(pointProjection.x, pointProjection.y);
    context.save();
    context.globalAlpha = 0.18;
    context.strokeStyle = "#6384a5";
    context.lineWidth = Math.max(0.45, 0.65 * canvasScale);
    context.setLineDash([2 * canvasScale, 3 * canvasScale]);
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = "#6384a5";
    context.beginPath();
    context.arc(start.x, start.y, Math.max(1, 1.6 * canvasScale), 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  for (const point of orderedPoints) {
    const position = toCanvasPoint(point.x, point.y);
    const heightRatio = Math.max(0, Math.min(1, (point.altitudeM - scene.altitudeMinM) / altitudeRange));
    const radius = Math.max(1.1, Math.min(2.8, 2.6 - point.accuracyM * 0.015) * canvasScale * point.perspective);
    context.beginPath();
    context.arc(position.x, position.y, radius, 0, Math.PI * 2);
    context.globalAlpha = 0.32 + ((point.index + 1) / Math.max(points.length, 1)) * 0.68;
    context.fillStyle = heightRatio > 0.58 ? "#e07a4e" : "#3f8b68";
    context.fill();
    context.globalAlpha = Math.min(1, context.globalAlpha + 0.15);
    context.lineWidth = Math.max(0.45, 0.7 * canvasScale);
    context.strokeStyle = "#ffffff";
    context.stroke();
  }

  const firstPoint = toCanvasPoint(points[0].x, points[0].y);
  context.globalAlpha = 1;
  context.beginPath();
  context.arc(firstPoint.x, firstPoint.y, Math.max(3, 5 * canvasScale), 0, Math.PI * 2);
  context.fillStyle = "#ffffff";
  context.fill();
  context.lineWidth = Math.max(1.2, 2 * canvasScale);
  context.strokeStyle = "#e05c3b";
  context.stroke();
  context.fillStyle = "#19352d";
  context.font = `${Math.max(9, 10 * canvasScale)}px Manrope, sans-serif`;
  context.textAlign = "center";
  context.fillText("START", firstPoint.x, firstPoint.y - Math.max(10, 16 * canvasScale));

  const latestPoint = toCanvasPoint(points[currentIndex].x, points[currentIndex].y);
  context.beginPath();
  context.arc(latestPoint.x, latestPoint.y, Math.max(5, 8 * canvasScale), 0, Math.PI * 2);
  context.fillStyle = "#e05c3b33";
  context.fill();
  context.lineWidth = Math.max(0.8, 1.2 * canvasScale);
  context.strokeStyle = "#e05c3b99";
  context.stroke();
  context.beginPath();
  context.arc(latestPoint.x, latestPoint.y, Math.max(2, 3.5 * canvasScale), 0, Math.PI * 2);
  context.fillStyle = "#e05c3b";
  context.fill();
};

const scheduleCanvasDraw = () => {
  if (canvasDrawFrame !== undefined || canvasDrawTimer !== undefined) return;
  const elapsed = performance.now() - lastCanvasDrawAt;
  const delay = Math.max(0, CANVAS_FRAME_INTERVAL_MS - elapsed);
  canvasDrawTimer = window.setTimeout(() => {
    canvasDrawTimer = undefined;
    canvasDrawFrame = window.requestAnimationFrame(() => {
      canvasDrawFrame = undefined;
      lastCanvasDrawAt = performance.now();
      drawPointCanvas();
    });
  }, delay);
};

watch([displayedTrack, cameraYaw, cameraPitch], scheduleCanvasDraw, { flush: "post" });

onMounted(() => {
  void refreshRoutes();
  canvasResizeObserver = new ResizeObserver(scheduleCanvasDraw);
  if (pointCanvasHost.value) canvasResizeObserver.observe(pointCanvasHost.value);
  scheduleCanvasDraw();
});

watch(routeManagementAvailable, (available) => {
  if (available) void refreshRoutes();
});

watch(routes, (items) => {
  if (!selectedRouteId.value && items[0]) selectedRouteId.value = items[0].routeId;
});

onBeforeUnmount(() => {
  canvasResizeObserver?.disconnect();
  if (canvasDrawTimer !== undefined) window.clearTimeout(canvasDrawTimer);
  if (canvasDrawFrame !== undefined) window.cancelAnimationFrame(canvasDrawFrame);
});

const activities = computed(() => {
  if (!session.value) return [];
  const current = session.value;
  return [
    {
      icon: isCollecting.value ? "●" : "✓",
      tone: isCollecting.value ? "bg-[#eaf4eb] text-sage" : "bg-[#fff0e8] text-ember",
      title: isCollecting.value ? "Android 采集进行中" : "最近一次采集已结束",
      detail: `${formatTime(current.lastReceivedAt ?? current.startedAt)} · 全部样本 ${current.sampleCount} · 位置点 ${current.track.length}`,
    },
    {
      icon: "⌁",
      tone: "bg-[#eaf4eb] text-sage",
          title: `已收到 ${current.sensorStats?.length ?? current.latestSensors.length} 类传感器数据`,
          detail: `${formatTime(current.lastSampleAt ?? current.lastReceivedAt)} · 最新展示 ${current.latestSensors.length} 类 · WebSocket 实时更新`,
    },
    {
      icon: "⌖",
      tone: "bg-[#edf3f8] text-[#6788a8]",
      title: current.latestLocation ? "位置样本已更新" : "等待位置样本",
      detail: current.latestLocation ? locationLabel.value : "Android 尚未上报 GNSS",
    },
  ];
});
</script>

<template>
  <div class="min-h-screen overflow-hidden bg-paper text-ink selection:bg-ember/20">
    <section class="relative flex min-h-screen flex-col overflow-hidden bg-[#e8f0eb]">
      <header class="z-10 flex shrink-0 items-center justify-between gap-4 border-b border-[#d3e0d7] bg-[#f5f9f5]/95 px-4 py-3 backdrop-blur sm:px-7">
        <div class="min-w-0">
          <div class="flex items-center gap-3">
            <span class="grid size-8 shrink-0 place-items-center rounded-xl bg-ink font-mono text-xs font-bold text-paper">wm</span>
            <div class="min-w-0">
              <p class="truncate text-sm font-extrabold tracking-[-0.04em]">way-memory / 3D route viewer</p>
              <p class="truncate text-[10px] text-muted">{{ routeLabel }} · {{ visualMode === 'inertial' ? 'sensor relative motion' : 'location track' }}</p>
            </div>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2 text-[10px] text-muted sm:gap-3">
          <span class="hidden rounded-full border border-[#d3e0d7] bg-white/80 px-3 py-1.5 md:inline-flex">{{ sensorTypeCount }} sensors</span>
          <span class="hidden rounded-full border border-[#d3e0d7] bg-white/80 px-3 py-1.5 sm:inline-flex">{{ displayedPointCount }} points · {{ routeDistanceM }}m</span>
           <span class="rounded-full border border-[#d3e0d7] bg-white/80 px-3 py-1.5">{{ motionModeLabel }}</span>
           <span class="hidden rounded-full border border-[#d3e0d7] bg-white/80 px-3 py-1.5 md:inline-flex">{{ poseFrameLabel }}</span>
           <span class="rounded-full border border-[#d3e0d7] bg-white/80 px-3 py-1.5">{{ closureLabel }}</span>
           <span v-if="navigationLabel" class="hidden rounded-full border border-[#d3e0d7] bg-white/80 px-3 py-1.5 lg:inline-flex">{{ navigationLabel }}</span>
           <span class="connection-pill"><span :class="['connection-dot', connection === 'connected' ? 'bg-sage' : connection === 'connecting' ? 'bg-amber' : 'bg-ember']" />{{ connectionLabel }}</span>
        </div>
      </header>
      <div class="z-10 flex items-center justify-end gap-2 border-b border-[#d3e0d7] bg-[#eef5ef] px-4 py-2 text-[10px] text-muted sm:px-7">
        <button v-if="!followingLive" class="rounded-full border border-ember/30 bg-[#fff8ee] px-3 py-1.5 text-ember" type="button" @click="followLatest">跟随实时</button>
        <select class="max-w-[320px] rounded-full border border-[#d3e0d7] bg-white/80 px-3 py-1.5 outline-none" :value="selectedSessionId ?? ''" aria-label="选择历史采集会话" @change="onSessionChange">
          <option value="" disabled>历史采集会话</option>
         <option v-for="item in availableSessions" :key="item.sessionId" :value="item.sessionId">{{ sessionHistoryLabel(item) }}</option>
        </select>
        <template v-if="routeManagementAvailable">
          <select v-model="selectedRouteId" class="max-w-[260px] rounded-full border border-[#c8ddd0] bg-[#f8fcf8] px-3 py-1.5 outline-none" aria-label="选择路线">
            <option value="">路线工作区</option>
            <option v-for="route in routes" :key="route.routeId" :value="route.routeId">{{ route.name }} · {{ route.status }} · {{ route.observations }} 次</option>
          </select>
          <input v-model="routeName" class="hidden w-[150px] rounded-full border border-[#d3e0d7] bg-white/80 px-3 py-1.5 outline-none md:inline-flex" aria-label="新路线名称" placeholder="新路线名称" @keyup.enter="createRouteRecord" />
          <button class="rounded-full border border-[#cddbd1] bg-white/80 px-3 py-1.5 text-muted disabled:cursor-not-allowed disabled:opacity-50" type="button" :disabled="routeBusy" @click="createRouteRecord">新建路线</button>
          <button v-if="selectedRoute && session?.status === 'stopped'" class="rounded-full border border-[#cddbd1] bg-white/80 px-3 py-1.5 text-muted disabled:cursor-not-allowed disabled:opacity-50" type="button" :disabled="routeBusy" @click="bindCurrentObservation">绑定当前记录</button>
          <button v-if="selectedRoute && selectedRoute.status === 'draft'" class="rounded-full bg-ink px-3 py-1.5 text-paper disabled:cursor-not-allowed disabled:opacity-50" type="button" :disabled="routeBusy" @click="verifySelectedRoute">发布验证</button>
        </template>
        <button v-if="authenticated" class="rounded-full border border-[#cddbd1] bg-white/80 px-3 py-1.5 text-muted" type="button" :disabled="enrollmentBusy" @click="createDeviceCredential">{{ enrollmentBusy ? "生成中" : "生成设备凭据" }}</button>
      </div>
      <div v-if="routeManagementAvailable && (routeActionError || routeError)" class="z-10 border-b border-[#ead7bf] bg-[#fff8ee] px-4 py-1.5 text-[10px] text-[#8c6845] sm:px-7">路线工作区：{{ routeActionError || routeError }}</div>

      <div v-if="authRequired" class="z-10 flex flex-wrap items-center gap-3 border-b border-[#ead7bf] bg-[#fff8ee] px-4 py-3 text-xs text-[#8c6845] sm:px-7">
        <span class="font-semibold">服务端已开启访问控制，请输入 dashboard token 才能查看轨迹。</span>
        <input v-model="dashboardToken" class="min-w-[240px] flex-1 rounded-full border border-[#e3c9a7] bg-white px-3 py-2 font-mono text-[10px] outline-none" type="password" autocomplete="off" placeholder="dashboard token" @keyup.enter="setAuthToken(dashboardToken)" />
        <button class="rounded-full bg-ink px-4 py-2 text-[10px] text-paper" type="button" @click="setAuthToken(dashboardToken)">安全连接</button>
      </div>
      <div v-if="newDeviceToken || enrollmentError" class="z-10 flex flex-wrap items-center gap-3 border-b border-[#d7e4db] bg-[#f3f8f3] px-4 py-3 text-xs text-[#4d715c] sm:px-7">
        <span v-if="newDeviceToken">请立即复制 device token 到 Android；它只在这里明文显示一次：</span>
        <input v-if="newDeviceToken" :value="newDeviceToken" readonly class="min-w-[280px] flex-1 rounded-full border border-[#c9ddce] bg-white px-3 py-2 font-mono text-[10px] text-ink" type="text" />
        <span v-if="enrollmentError" class="text-ember">{{ enrollmentError }}</span>
      </div>

      <div ref="pointCanvasHost" class="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-[#e8f0eb]" @pointerdown="beginCameraDrag" @pointermove="moveCameraDrag" @pointerup="endCameraDrag" @pointercancel="endCameraDrag" @pointerleave="endCameraDrag">
        <canvas ref="pointCanvas" class="point-canvas block h-full w-full" width="620" height="300" role="img" aria-label="可旋转的三维实时运动轨迹" />
        <div class="pointer-events-none absolute left-4 top-4 rounded-2xl border border-white/70 bg-white/70 px-3 py-2 text-[10px] leading-5 text-muted shadow-sm backdrop-blur sm:left-7 sm:top-6">
          <strong class="block text-ink">{{ displayedPointCount }} 个实时点</strong>
           <span>{{ coordinateBoundsLabel }}</span>
           <span class="block">{{ session?.latestPose ? `Pose ±${session.latestPose.accuracyM.toFixed(1)}m` : "等待统一 Pose" }}</span>
        </div>
        <div v-if="!displayedTrack.length" class="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted">等待 Android 上报轨迹点</div>
        <div class="pointer-events-none absolute bottom-4 left-4 flex flex-wrap items-center gap-2 text-[10px] text-muted sm:bottom-6 sm:left-7">
          <span class="rounded-full border border-white/80 bg-white/75 px-3 py-1.5 shadow-sm backdrop-blur">X 左右</span>
          <span class="rounded-full border border-white/80 bg-white/75 px-3 py-1.5 shadow-sm backdrop-blur">Y 前后</span>
          <span class="rounded-full border border-white/80 bg-white/75 px-3 py-1.5 shadow-sm backdrop-blur">Z 上下</span>
          <span class="rounded-full border border-white/80 bg-white/75 px-3 py-1.5 shadow-sm backdrop-blur">{{ altitudeSourceLabel }}</span>
        </div>
        <button class="absolute right-4 top-4 rounded-full border border-[#cddbd1] bg-white/85 px-3 py-2 text-[10px] text-muted shadow-sm backdrop-blur transition hover:border-ember hover:text-ember sm:right-7 sm:top-6" type="button" @click="resetCamera">重置视角</button>
      </div>

      <footer class="z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[#d3e0d7] bg-[#f5f9f5]/95 px-4 py-2 text-[10px] text-muted backdrop-blur sm:px-7">
        <span>拖动旋转视角 · 每个点对应一个服务端样本 · {{ totalSampleCount }} samples</span>
        <span class="font-mono">{{ coordinateBoundsLabel }}</span>
      </footer>
    </section>

    <!--
    <aside class="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-line bg-mist px-5 py-7 lg:flex">
      <div class="mb-16 flex items-center gap-3 px-2">
        <span class="grid size-8 place-items-center rounded-xl bg-ink font-mono text-xs font-bold text-paper">wm</span>
        <span class="text-lg font-extrabold tracking-[-0.06em]">way-memory</span>
      </div>
      <p class="section-label px-3">工作台</p>
      <nav class="mt-3 space-y-1">
        <a class="nav-link nav-link-active" href="#overview"><span>◉</span>路线总览</a>
        <a class="nav-link" href="#observations"><span>◌</span>行走记录</a>
        <a class="nav-link" href="#annotations"><span>◇</span>人工标注</a>
        <a class="nav-link" href="#devices"><span>⌁</span>设备状态</a>
      </nav>
      <div class="mt-auto flex gap-3 border-t border-line px-2 pt-5 text-[11px]">
        <span class="mt-1 size-2 rounded-full bg-sage shadow-[0_0_0_4px_#dcecdf]" />
        <div><strong class="block">局域网实时模式</strong><small class="mt-1 block text-muted">数据来自 API 与 WebSocket</small></div>
      </div>
    </aside>

    <main class="mx-auto max-w-[1440px] px-5 py-7 sm:px-8 lg:ml-64 lg:px-12 lg:py-10">
      <header class="mb-8 flex items-start justify-between gap-5">
        <div><p class="section-label">路线学习 · 2026.07.31</p><h1 class="mt-2 max-w-xl text-3xl font-extrabold leading-tight tracking-[-0.06em]">你好，今天继续理解这条路。</h1></div>
        <div class="connection-pill"><span :class="['connection-dot', connection === 'connected' ? 'bg-sage' : connection === 'connecting' ? 'bg-amber' : 'bg-ember']" />{{ connectionLabel }}</div>
      </header>

      <section class="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,.75fr)]">
        <article class="panel p-5 sm:p-7">
          <div class="flex items-start justify-between gap-3"><div><p class="section-label">当前路线</p><h2 class="mt-1 text-xl font-extrabold tracking-[-0.05em]">{{ routeLabel }}</h2></div><span class="status-pill">{{ routeStatusLabel }}</span></div>
          <div class="mt-6 flex gap-8 sm:gap-14"><div><strong class="metric">{{ routeDistanceM }}</strong><span class="metric-label">米 · 当前相对轨迹</span></div><div><strong class="metric">{{ displayedPointCount }}</strong><span class="metric-label">个当前显示点</span></div><div><strong class="metric">{{ totalSampleCount }}</strong><span class="metric-label">个传感器样本</span></div></div>
          <div class="map-frame mt-6 overflow-hidden">
            <div class="flex items-center justify-between gap-3 border-b border-[#dce5df] bg-[#f7faf7] px-4 py-3"><div><p class="section-label">{{ visualMode === 'inertial' ? '3D 实时运动点 · X / Y / Z' : '3D 实时定位点 · X / Y / Z' }}</p><p class="mt-1 text-[11px] text-muted">X 左右 · Y 前后 · Z 上下；点的大小代表深度，颜色代表高度</p></div><button class="rounded-full border border-line bg-white px-3 py-1.5 text-[10px] text-muted transition hover:border-ember hover:text-ember" type="button" @click="resetCamera">重置视角</button></div>
            <div ref="pointCanvasHost" class="relative touch-none select-none bg-[#e9f0eb]" @pointerdown="beginCameraDrag" @pointermove="moveCameraDrag" @pointerup="endCameraDrag" @pointercancel="endCameraDrag" @pointerleave="endCameraDrag">
               <canvas ref="pointCanvas" class="point-canvas block w-full" width="620" height="300" role="img" aria-label="可旋转的三维实时定位点" />
               <div v-if="!displayedTrack.length" class="pointer-events-none absolute inset-0 grid place-items-center text-[13px] text-muted">等待 Android 上报位置或传感器运动样本</div>
               <div class="pointer-events-none absolute bottom-3 left-3 rounded-full bg-white/80 px-3 py-1.5 text-[9px] text-muted shadow-sm backdrop-blur">按住拖动旋转 · 高度视觉放大 2.2×</div>
             </div>
            <div class="flex flex-wrap gap-x-5 gap-y-2 bg-white px-3 py-3 text-[10px] text-muted"><span><i class="legend-dot bg-ember" />X 左右</span><span><i class="legend-dot bg-sage" />Y 前后</span><span><i class="legend-dot bg-[#6384a5]" />Z 上下</span><span><i class="legend-dot bg-[#3f8b68]" />{{ visualMode === 'inertial' ? '传感器运动点' : '真实定位点' }}</span><span><i class="legend-dot bg-ember" />最新点</span><span class="ml-auto">{{ altitudeSourceLabel }}</span></div>
          </div>
          <div class="border-t border-[#e5ebe6] bg-[#fbfdfb] px-3 py-2 font-mono text-[9px] text-muted">{{ displayedPointCount }} displayed points · {{ locationPointCount }} location · {{ motionPointCount }} inertial · {{ totalSampleCount }} total samples · {{ coordinateBoundsLabel }}<span v-if="session?.droppedSampleCount"> · dropped {{ session.droppedSampleCount }}</span><span v-if="session?.outOfOrderSampleCount"> · late {{ session.outOfOrderSampleCount }}</span></div>
          <div class="mt-2 px-1 text-[10px] text-muted">{{ routeRenderModeLabel }}<span v-if="hasAltitude"> · {{ altitudeSourceLabel }}</span><span v-else> · 当前按经纬度平面路线显示</span></div>
          <div v-if="visualMode === 'inertial'" class="mt-3 rounded-xl border border-[#d7e4db] bg-[#f3f8f3] px-3 py-2 text-[10px] leading-5 text-[#4d715c]">当前没有足够的 GNSS 轨迹，网页正在显示手机传感器融合出的局部相对运动点；该轨迹会随时间漂移，不能替代最终导航定位。</div>
          <div v-else-if="session && totalSampleCount > Math.max(locationPointCount * 20, 100)" class="mt-3 rounded-xl border border-[#f1d8bd] bg-[#fff8ee] px-3 py-2 text-[10px] leading-5 text-[#8c6845]">当前收到大量传感器样本，但还没有足够的位置或相对运动点；请继续采集，或检查 Android 传感器能力。</div>
        </article>

        <div class="flex flex-col gap-5">
          <article class="panel flex-1 p-6"><div class="flex items-start justify-between"><div><p class="section-label">当前判断</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">{{ confidencePercent === null ? "等待定位" : confidencePercent >= 75 ? "位置可靠" : "位置仍在收敛" }}</h3></div><span class="confidence-ring">{{ confidencePercent === null ? '—' : confidencePercent }}</span></div><p class="mt-5 text-xs leading-6 text-muted">{{ session?.latestLocation ? `最新位置 ${locationLabel}，服务端已收到 ${track.length} 个轨迹点。` : "页面不会伪造路线；请先在 Android 端授予定位权限并开始采集。" }}</p><div class="mt-6 h-1 rounded-full bg-[#edf1ec]"><span class="block h-full rounded-full bg-sage" :style="{ width: `${confidencePercent ?? 0}%` }" /></div><div class="mt-3 flex justify-between text-[10px] text-muted"><span>融合定位</span><strong class="text-sage">{{ confidencePercent === null ? '等待数据' : '由真实精度计算' }}</strong></div></article>
          <article class="panel flex gap-4 border-[#f1e3d0] bg-[#fff8ee] p-6"><span class="grid size-9 shrink-0 place-items-center rounded-xl bg-[#f7dfbd] text-ember">✦</span><div><p class="section-label">实时观察会话</p><h3 class="mt-1 text-base font-extrabold tracking-[-0.03em]">{{ sessionLabel }}</h3><p class="mt-1 text-xs leading-6 text-muted">样本 {{ session?.sampleCount ?? 0 }} · {{ locationLabel }}</p></div></article>
        </div>
      </section>

      <section class="mt-5 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <article class="panel p-5 sm:p-7"><div class="flex items-start justify-between"><div><p class="section-label">实时遥测</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">设备传感器</h3><p class="mt-1 text-[10px] text-muted">设备发现 {{ sensorInventory.length }} 类，成功注册 {{ registeredSensorCount }} 类；已收到样本 {{ sensors.length }} 类</p></div><span class="live-label"><i />{{ connection === 'connected' ? 'LIVE' : 'WAITING' }}</span></div><div v-if="sensors.length" class="mt-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"><div v-for="sensor in sensors" :key="sensor.sensorType" class="sensor-card"><span class="text-lg text-sage">{{ sensor.icon }}</span><div><strong class="block text-[11px]">{{ sensor.label }}</strong><small class="mt-1 block text-[10px] text-muted">{{ sensor.detail }}</small></div><b class="ml-auto text-[10px] text-sage">●</b></div></div><div v-else class="mt-6 rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs leading-6 text-muted">尚未收到 Android 传感器样本<br />开始采集后，这里会显示真实数值与样本计数。</div></article>
        <article class="panel p-5 sm:p-7"><div class="flex items-start justify-between"><div><p class="section-label">最近活动</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">实时会话</h3></div><span class="text-[10px] text-muted">{{ session ? formatTime(session.lastReceivedAt) : '暂无' }}</span></div><div v-if="activities.length"><div v-for="activity in activities" :key="activity.title" class="activity-row"><span :class="['activity-mark', activity.tone]">{{ activity.icon }}</span><div><strong>{{ activity.title }}</strong><small>{{ activity.detail }}</small></div></div></div><div v-else class="mt-6 rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs leading-6 text-muted">暂无会话活动<br />等待 Android 通过局域网连接服务端。</div></article>
      </section>
      <footer class="mt-8 flex flex-col justify-between gap-2 px-1 font-mono text-[9px] text-[#9aa79f] sm:flex-row"><span>way-memory / LAN realtime console</span><span>页面数据来自 API 与 WebSocket，不使用演示轨迹</span></footer>
    </main>
    -->
  </div>
</template>
