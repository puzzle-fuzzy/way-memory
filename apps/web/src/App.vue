<script setup lang="ts">
import { computed, ref } from "vue";
import type { LiveSensorSnapshot, TrackPoint } from "@way-memory/contracts";
import { useRealtimeSession } from "./composables/useRealtimeSession";

const { connection, latestSession } = useRealtimeSession();

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

const locationLabel = computed(() => {
  const location = session.value?.latestLocation;
  if (!location) return "等待位置样本";
  const altitudeM = session.value?.latestAltitudeM;
  const altitude = typeof altitudeM === "number" ? ` · Z ${altitudeM >= 0 ? "+" : ""}${altitudeM.toFixed(1)}m` : "";
  return `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}${altitude}`;
});

const routeLabel = computed(() => {
  if (!session.value) return "等待 Android 会话";
  if (session.value.routeId === "route-home-metro") return "家 · 地铁站入口";
  return session.value.routeId ? `路线 ${session.value.routeId}` : "未绑定路线";
});

const routeStatusLabel = computed(() => {
  if (!session.value) return "未开始";
  return isCollecting.value ? "实时采集中" : "已停止";
});

const track = computed(() => session.value?.track ?? []);
const trackSegmentCount = computed(() => Math.max(0, track.value.length - 1));
const coordinateBoundsLabel = computed(() => {
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
  let distance = 0;
  for (let index = 1; index < track.value.length; index += 1) {
    const planarDistance = haversineDistanceM(track.value[index - 1], track.value[index]);
    const heightDelta = (track.value[index].altitudeM ?? 0) - (track.value[index - 1].altitudeM ?? 0);
    distance += Math.sqrt(planarDistance ** 2 + heightDelta ** 2);
  }
  return Math.round(distance);
});

const altitudeValues = computed(() => track.value.flatMap((point) => typeof point.altitudeM === "number" ? [point.altitudeM] : []));
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
const altitudeSourceLabel = computed(() => session.value?.altitudeSource === "gnss" ? "GNSS 相对高度" : session.value?.altitudeSource === "barometer" ? "气压计相对高度" : "尚未建立 Z 轴");

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
  gyroscope: "陀螺仪",
  magnetometer: "磁力计",
  barometer: "气压计",
  gnss: "GNSS 定位",
  "rotation-vector": "旋转向量",
};

const sensorIcons: Record<string, string> = {
  accelerometer: "↗",
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

const cameraYaw = ref(-0.72);
const cameraPitch = ref(0.62);
const dragState = ref<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

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

const projectedTrack = computed(() => {
  if (!track.value.length) return [];
  const origin = track.value[0];
  const originLatRad = origin.lat * Math.PI / 180;
  const worldPoints = track.value.map((point, index) => ({
    index,
    eastM: (point.lng - origin.lng) * Math.PI / 180 * 6371000 * Math.cos(originLatRad),
    northM: (point.lat - origin.lat) * Math.PI / 180 * 6371000,
    altitudeM: point.altitudeM ?? 0,
    hasAltitude: typeof point.altitudeM === "number",
  }));
  const horizontalExtent = Math.max(...worldPoints.map((point) => Math.hypot(point.eastM, point.northM)), 1);
  const verticalExtent = Math.max(...worldPoints.map((point) => Math.abs(point.altitudeM * 2.2)), 1);
  const scale = 220 / Math.max(horizontalExtent, verticalExtent);
  const yawCos = Math.cos(cameraYaw.value);
  const yawSin = Math.sin(cameraYaw.value);
  const pitchSin = Math.sin(cameraPitch.value);
  const pitchCos = Math.cos(cameraPitch.value);
  return worldPoints.map((point) => {
    const rotatedX = point.eastM * yawCos - point.northM * yawSin;
    const rotatedY = point.eastM * yawSin + point.northM * yawCos;
    const displayAltitude = point.altitudeM * 2.2;
    const groundY = 210 - rotatedY * pitchSin * scale;
    return {
      ...point,
      x: 310 + rotatedX * scale,
      y: groundY - displayAltitude * pitchCos * scale,
      groundY,
      depth: rotatedY * pitchCos - displayAltitude * pitchSin,
    };
  });
});

const projectedPath = computed(() => projectedTrack.value.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" "));
const projectedGroundPath = computed(() => projectedTrack.value.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.groundY.toFixed(1)}`).join(" "));
const currentMapPoint = computed(() => projectedTrack.value.at(-1));
const mapPoints = projectedTrack;
const mapPath = projectedPath;
const hasTrack = computed(() => track.value.length > 1);

const activities = computed(() => {
  if (!session.value) return [];
  const current = session.value;
  return [
    {
      icon: isCollecting.value ? "●" : "✓",
      tone: isCollecting.value ? "bg-[#eaf4eb] text-sage" : "bg-[#fff0e8] text-ember",
      title: isCollecting.value ? "Android 采集进行中" : "最近一次采集已结束",
      detail: `${formatTime(current.lastReceivedAt ?? current.startedAt)} · 样本 ${current.sampleCount}`,
    },
    {
      icon: "⌁",
      tone: "bg-[#eaf4eb] text-sage",
      title: `已收到 ${current.latestSensors.length} 类传感器数据`,
      detail: `${formatTime(current.lastSampleAt ?? current.lastReceivedAt)} · WebSocket 实时更新`,
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
  <div class="min-h-screen bg-paper text-ink selection:bg-ember/20">
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
          <div class="mt-6 flex gap-8 sm:gap-14"><div><strong class="metric">{{ routeDistanceM }}</strong><span class="metric-label">米 · 当前会话轨迹</span></div><div><strong class="metric">{{ session?.sampleCount ?? 0 }}</strong><span class="metric-label">个实时样本</span></div><div><strong class="metric">{{ confidencePercent === null ? '—' : `${confidencePercent}%` }}</strong><span class="metric-label">位置置信度</span></div></div>
          <div class="map-frame mt-6 overflow-hidden">
            <div class="flex items-center justify-between gap-3 border-b border-[#dce5df] bg-[#f7faf7] px-4 py-3"><div><p class="section-label">三维轨迹 · X / Y / Z</p><p class="mt-1 text-[11px] text-muted">经纬度平面 + 相对高度</p></div><button class="rounded-full border border-line bg-white px-3 py-1.5 text-[10px] text-muted transition hover:border-ember hover:text-ember" type="button" @click="resetCamera">重置视角</button></div>
            <div class="relative touch-none select-none bg-[#e9f0eb]" @pointerdown="beginCameraDrag" @pointermove="moveCameraDrag" @pointerup="endCameraDrag" @pointercancel="endCameraDrag" @pointerleave="endCameraDrag">
              <svg viewBox="0 0 620 300" class="block w-full" role="img" aria-label="可旋转的三维实时路线轨迹">
                <defs><linearGradient id="route3dGradient" x1="0" y1="1" x2="1" y2="0"><stop offset="0%" stop-color="#e05c3b" /><stop offset="55%" stop-color="#c47b4b" /><stop offset="100%" stop-color="#3f8b68" /></linearGradient><filter id="route3dShadow"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#1f3a32" flood-opacity=".2" /></filter></defs>
                <rect width="620" height="300" fill="#e9f0eb" />
                <g v-if="hasAltitude" opacity=".7"><line x1="310" y1="250" x2="310" y2="74" stroke="#c47b4b" stroke-width="1" stroke-dasharray="3 5" /><text x="320" y="75" fill="#c47b4b" font-size="10">Z altitude reference</text></g>
                <g v-for="point in projectedTrack" :key="`height-${point.index}`"><line v-if="hasAltitude && point.hasAltitude" :x1="point.x" :y1="point.groundY" :x2="point.x" :y2="point.y" stroke="#c47b4b" stroke-width="1.5" stroke-dasharray="3 4" opacity=".8" /></g>
                <path v-if="hasTrack" :d="projectedPath" fill="none" stroke="#f8fbf7" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" filter="url(#route3dShadow)" />
                <path v-if="hasTrack" :d="projectedPath" fill="none" stroke="url(#route3dGradient)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
                <template v-if="projectedTrack.length">
                  <g class="map-node"><circle :cx="projectedTrack[0].x" :cy="projectedTrack[0].y" r="8" /><text :x="projectedTrack[0].x" :y="projectedTrack[0].y - 16">起点</text></g>
                  <g v-if="currentMapPoint" class="current-pos"><circle :cx="currentMapPoint.x" :cy="currentMapPoint.y" r="15" /><circle :cx="currentMapPoint.x" :cy="currentMapPoint.y" r="6" /></g>
                </template>
                <text v-else x="310" y="145" text-anchor="middle" fill="#75857d" font-size="13">等待 Android 上报位置样本</text>
                <text x="558" y="259" fill="#75857d" font-size="10">X 东西</text><text x="304" y="174" fill="#75857d" font-size="10">Y 南北</text><text x="320" y="60" fill="#c47b4b" font-size="10">Z 高度</text>
                <text v-if="projectedTrack.length && !hasAltitude" x="310" y="278" text-anchor="middle" fill="#75857d" font-size="10">尚未收到 GNSS 海拔或气压高度，当前为平面投影</text>
              </svg>
              <div class="pointer-events-none absolute bottom-3 left-3 rounded-full bg-white/80 px-3 py-1.5 text-[9px] text-muted shadow-sm backdrop-blur">按住拖动旋转 · 高度视觉放大 2.2×</div>
            </div>
            <div class="flex flex-wrap gap-x-5 gap-y-2 bg-white px-3 py-3 text-[10px] text-muted"><span><i class="legend-dot bg-ember" />三维融合轨迹</span><span><i class="legend-dot bg-[#c47b4b]" />高度投影</span><span><i class="legend-dot bg-sage" />当前手机位置</span><span class="ml-auto">{{ altitudeSourceLabel }}</span></div>
          </div>
          <div class="border-t border-[#e5ebe6] bg-[#fbfdfb] px-3 py-2 font-mono text-[9px] text-muted">{{ track.length }} points · {{ trackSegmentCount }} segments · {{ coordinateBoundsLabel }}<span v-if="session?.droppedSampleCount"> · dropped {{ session.droppedSampleCount }}</span></div>
          <div class="map-frame mt-6" style="display: none">
            <svg viewBox="0 0 620 300" class="block w-full" role="img" aria-label="实时路线轨迹">
              <defs><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="#dce4df" stroke-width="1" /></pattern><filter id="shadow"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#1f3a32" flood-opacity=".16" /></filter></defs>
              <rect width="620" height="300" fill="#edf2ed" /><rect width="620" height="300" fill="url(#grid)" />
              <template v-if="hasTrack">
                <path :d="mapPath" fill="none" stroke="#a7b7ae" stroke-width="26" stroke-linecap="round" stroke-linejoin="round" />
                <path :d="mapPath" fill="none" stroke="#f8fbf7" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" />
                <path :d="mapPath" fill="none" stroke="#e05c3b" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" filter="url(#shadow)" />
              </template>
              <template v-if="mapPoints.length">
                <g class="map-node"><circle :cx="mapPoints[0].x" :cy="mapPoints[0].y" r="9" /><text :x="mapPoints[0].x" :y="mapPoints[0].y + 28">起点</text></g>
                <g v-if="currentMapPoint" class="current-pos"><circle :cx="currentMapPoint.x" :cy="currentMapPoint.y" r="15" /><circle :cx="currentMapPoint.x" :cy="currentMapPoint.y" r="6" /></g>
              </template>
              <text v-else x="310" y="145" text-anchor="middle" fill="#75857d" font-size="13">等待 Android 上报位置样本</text>
            </svg>
            <div class="flex flex-wrap gap-x-5 gap-y-2 bg-white px-3 py-3 text-[10px] text-muted"><span><i class="legend-dot bg-ember" />实时轨迹</span><span><i class="legend-dot border-2 border-ember bg-white" />起点</span><span><i class="legend-dot bg-sage" />当前手机位置</span></div>
          </div>
        </article>

        <div class="flex flex-col gap-5">
          <article class="panel flex-1 p-6"><div class="flex items-start justify-between"><div><p class="section-label">当前判断</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">{{ confidencePercent === null ? "等待定位" : confidencePercent >= 75 ? "位置可靠" : "位置仍在收敛" }}</h3></div><span class="confidence-ring">{{ confidencePercent === null ? '—' : confidencePercent }}</span></div><p class="mt-5 text-xs leading-6 text-muted">{{ session?.latestLocation ? `最新位置 ${locationLabel}，服务端已收到 ${track.length} 个轨迹点。` : "页面不会伪造路线；请先在 Android 端授予定位权限并开始采集。" }}</p><div class="mt-6 h-1 rounded-full bg-[#edf1ec]"><span class="block h-full rounded-full bg-sage" :style="{ width: `${confidencePercent ?? 0}%` }" /></div><div class="mt-3 flex justify-between text-[10px] text-muted"><span>融合定位</span><strong class="text-sage">{{ confidencePercent === null ? '等待数据' : '由真实精度计算' }}</strong></div></article>
          <article class="panel flex gap-4 border-[#f1e3d0] bg-[#fff8ee] p-6"><span class="grid size-9 shrink-0 place-items-center rounded-xl bg-[#f7dfbd] text-ember">✦</span><div><p class="section-label">实时观察会话</p><h3 class="mt-1 text-base font-extrabold tracking-[-0.03em]">{{ sessionLabel }}</h3><p class="mt-1 text-xs leading-6 text-muted">样本 {{ session?.sampleCount ?? 0 }} · {{ locationLabel }}</p></div></article>
        </div>
      </section>

      <section class="mt-5 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <article class="panel p-5 sm:p-7"><div class="flex items-start justify-between"><div><p class="section-label">实时遥测</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">设备传感器</h3></div><span class="live-label"><i />{{ connection === 'connected' ? 'LIVE' : 'WAITING' }}</span></div><div v-if="sensors.length" class="mt-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"><div v-for="sensor in sensors" :key="sensor.sensorType" class="sensor-card"><span class="text-lg text-sage">{{ sensor.icon }}</span><div><strong class="block text-[11px]">{{ sensor.label }}</strong><small class="mt-1 block text-[10px] text-muted">{{ sensor.detail }}</small></div><b class="ml-auto text-[10px] text-sage">●</b></div></div><div v-else class="mt-6 rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs leading-6 text-muted">尚未收到 Android 传感器样本<br />开始采集后，这里会显示真实数值与样本计数。</div></article>
        <article class="panel p-5 sm:p-7"><div class="flex items-start justify-between"><div><p class="section-label">最近活动</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">实时会话</h3></div><span class="text-[10px] text-muted">{{ session ? formatTime(session.lastReceivedAt) : '暂无' }}</span></div><div v-if="activities.length"><div v-for="activity in activities" :key="activity.title" class="activity-row"><span :class="['activity-mark', activity.tone]">{{ activity.icon }}</span><div><strong>{{ activity.title }}</strong><small>{{ activity.detail }}</small></div></div></div><div v-else class="mt-6 rounded-xl border border-dashed border-line px-4 py-8 text-center text-xs leading-6 text-muted">暂无会话活动<br />等待 Android 通过局域网连接服务端。</div></article>
      </section>
      <footer class="mt-8 flex flex-col justify-between gap-2 px-1 font-mono text-[9px] text-[#9aa79f] sm:flex-row"><span>way-memory / LAN realtime console</span><span>页面数据来自 API 与 WebSocket，不使用演示轨迹</span></footer>
    </main>
  </div>
</template>
