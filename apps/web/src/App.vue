<script setup lang="ts">
import { computed } from "vue";
import { useRealtimeSession } from "./composables/useRealtimeSession";

const { connection, latestSession } = useRealtimeSession();

const connectionLabel = computed(() => ({
  connecting: "连接中",
  connected: "实时同步",
  offline: "服务端离线",
}[connection.value]));

const sessionLabel = computed(() => {
  if (!latestSession.value) return "等待 Android 连接";
  return latestSession.value.status === "active" ? "Android 正在采集" : "最近一次采集已结束";
});

const locationLabel = computed(() => {
  const location = latestSession.value?.latestLocation;
  if (!location) return "等待位置样本";
  return `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
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
        <div><strong class="block">本地演示模式</strong><small class="mt-1 block text-muted">数据仅用于当前工作台</small></div>
      </div>
    </aside>

    <main class="mx-auto max-w-[1440px] px-5 py-7 sm:px-8 lg:ml-64 lg:px-12 lg:py-10">
      <header class="mb-8 flex items-start justify-between gap-5">
        <div><p class="section-label">路线学习 · 2026.07.31</p><h1 class="mt-2 max-w-xl text-3xl font-extrabold leading-tight tracking-[-0.06em] sm:text-4xl">你好，今天继续理解这条路。</h1></div>
        <div class="connection-pill"><span :class="['connection-dot', connection === 'connected' ? 'bg-sage' : connection === 'connecting' ? 'bg-amber' : 'bg-ember']" />{{ connectionLabel }}</div>
      </header>

      <section class="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,.75fr)]">
        <article class="panel p-5 sm:p-7">
          <div class="flex items-start justify-between gap-3"><div><p class="section-label">当前路线</p><h2 class="mt-1 text-xl font-extrabold tracking-[-0.05em]">家 · 地铁站入口</h2></div><span class="status-pill">已验证</span></div>
          <div class="mt-6 flex gap-8 sm:gap-14"><div><strong class="metric">486</strong><span class="metric-label">米 · 约 8 分钟</span></div><div><strong class="metric">4</strong><span class="metric-label">次行走记录</span></div><div><strong class="metric">91%</strong><span class="metric-label">路线置信度</span></div></div>
          <div class="map-frame mt-6">
            <svg viewBox="0 0 620 300" class="block w-full" role="img" aria-label="路线轨迹预览">
              <defs><pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="#dce4df" stroke-width="1" /></pattern><filter id="shadow"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#1f3a32" flood-opacity=".16" /></filter></defs>
              <rect width="620" height="300" fill="#edf2ed" /><rect width="620" height="300" fill="url(#grid)" />
              <path d="M80 230 C138 220 140 180 192 170 S275 196 316 147 S365 83 424 110 S485 164 555 83" fill="none" stroke="#a7b7ae" stroke-width="26" stroke-linecap="round" />
              <path d="M80 230 C138 220 140 180 192 170 S275 196 316 147 S365 83 424 110 S485 164 555 83" fill="none" stroke="#f8fbf7" stroke-width="18" stroke-linecap="round" />
              <path d="M80 230 C138 220 140 180 192 170 S275 196 316 147 S365 83 424 110 S485 164 555 83" fill="none" stroke="#e05c3b" stroke-width="5" stroke-linecap="round" filter="url(#shadow)" />
              <g class="map-node"><circle cx="80" cy="230" r="9" /><text x="80" y="258">起点</text></g><g class="map-node"><circle cx="316" cy="147" r="9" /><text x="316" y="175">左转 · 视觉地标</text></g><g class="map-node end"><circle cx="555" cy="83" r="9" /><text x="555" y="60">终点</text></g><g class="current-pos"><circle cx="416" cy="106" r="15" /><circle cx="416" cy="106" r="6" /></g>
            </svg>
            <div class="flex flex-wrap gap-x-5 gap-y-2 bg-white px-3 py-3 text-[10px] text-muted"><span><i class="legend-dot bg-ember" />融合轨迹</span><span><i class="legend-dot border-2 border-ember bg-white" />人工确认节点</span><span><i class="legend-dot bg-sage" />当前手机位置</span></div>
          </div>
        </article>

        <div class="flex flex-col gap-5">
          <article class="panel flex-1 p-6"><div class="flex items-start justify-between"><div><p class="section-label">当前判断</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">位置可靠</h3></div><span class="confidence-ring">91</span></div><p class="mt-5 text-xs leading-6 text-muted">手机正在接近已记录的左转节点。视觉与运动轨迹一致。</p><div class="mt-6 h-1 rounded-full bg-[#edf1ec]"><span class="block h-full w-[91%] rounded-full bg-sage" /></div><div class="mt-3 flex justify-between text-[10px] text-muted"><span>融合定位</span><strong class="text-sage">高置信度</strong></div></article>
          <article class="panel flex gap-4 border-[#f1e3d0] bg-[#fff8ee] p-6"><span class="grid size-9 shrink-0 place-items-center rounded-xl bg-[#f7dfbd] text-ember">✦</span><div><p class="section-label">实时观察会话</p><h3 class="mt-1 text-base font-extrabold tracking-[-0.03em]">{{ sessionLabel }}</h3><p class="mt-1 text-xs leading-6 text-muted">样本 {{ latestSession?.sampleCount ?? 0 }} · {{ locationLabel }}</p></div></article>
        </div>
      </section>

      <section class="mt-5 grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <article class="panel p-5 sm:p-7"><div class="flex items-start justify-between"><div><p class="section-label">实时遥测</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">设备传感器</h3></div><span class="live-label"><i />LIVE</span></div><div class="mt-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"><div v-for="sensor in [['⌁','GNSS','精度 3.2m'],['↗','加速度计','50 Hz · 正常'],['⟳','陀螺仪','50 Hz · 正常'],['⌁','视觉采集','5 Hz · 正常'],['◒','气压计','101.2 kPa'],['◌','深度感知','设备不支持']]" :key="sensor[1]" :class="['sensor-card', sensor[1] === '深度感知' && 'opacity-50']"><span class="text-lg text-sage">{{ sensor[0] }}</span><div><strong class="block text-[11px]">{{ sensor[1] }}</strong><small class="mt-1 block text-[10px] text-muted">{{ sensor[2] }}</small></div><b class="ml-auto text-[10px] text-sage">{{ sensor[1] === '深度感知' ? '—' : '●' }}</b></div></div></article>
        <article class="panel p-5 sm:p-7"><div class="flex items-start justify-between"><div><p class="section-label">最近活动</p><h3 class="mt-1 text-lg font-extrabold tracking-[-0.04em]">路线观察</h3></div><a class="text-[10px] text-ember" href="#all">查看全部 ↗</a></div><div class="activity-row"><span class="activity-mark bg-[#fff0e8] text-ember">↗</span><div><strong>第 4 次观察已完成</strong><small>今天 09:42 · 路线置信度提升至 91%</small></div></div><div class="activity-row"><span class="activity-mark bg-[#eaf4eb] text-sage">◇</span><div><strong>新增人工标注</strong><small>昨天 18:16 · “左侧围墙”</small></div></div><div class="activity-row"><span class="activity-mark bg-[#edf3f8] text-[#6788a8]">⌁</span><div><strong>设备已连接</strong><small>昨天 18:02 · Android 手机</small></div></div></article>
      </section>
      <footer class="mt-8 flex flex-col justify-between gap-2 px-1 font-mono text-[9px] text-[#9aa79f] sm:flex-row"><span>way-memory / P1 可观测闭环</span><span>所有判断都带有来源与置信度</span></footer>
    </main>
  </div>
</template>
