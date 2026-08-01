type JsonRecord = Record<string, any>;

const args = Bun.argv.slice(2).map((argument) => (
  argument.length >= 2 && argument.startsWith('"') && argument.endsWith('"')
    ? argument.slice(1, -1)
    : argument
));
const valueFor = (name: string) => {
  const prefix = `${name}=`;
  const argument = args.find((item) => item.startsWith(prefix));
  return argument?.slice(prefix.length);
};
const hasFlag = (name: string) => args.includes(name) || args.some((item) => item === `${name}=true`);
const apiBase = (Bun.env.WAY_MEMORY_API_URL ?? "http://101.35.246.159").replace(/\/$/, "");
const dashboardToken = Bun.env.WAY_MEMORY_DASHBOARD_TOKEN?.trim();
const apiUrl = new URL(apiBase);
const expectedClientApiOrigin = new URL(
  (Bun.env.WAY_MEMORY_EXPECTED_CLIENT_API_ORIGIN ?? apiBase).replace(/\/$/, ""),
).origin;
const localHttpHost = apiUrl.protocol === "http:" && ["127.0.0.1", "localhost"].includes(apiUrl.hostname);
if (dashboardToken && apiUrl.protocol !== "https:" && !localHttpHost) {
  throw new Error("WAY_MEMORY_DASHBOARD_TOKEN requires an HTTPS WAY_MEMORY_API_URL");
}
const requestHeaders = dashboardToken ? { authorization: `Bearer ${dashboardToken}` } : {};
const sessionId = Bun.env.WAY_MEMORY_SESSION_ID ?? valueFor("--session");
const acceptanceCase = valueFor("--case") ?? "baseline";
const minimumAxisM = Number(valueFor("--min-axis-m") ?? "0.2");
const maximumRotationTranslationM = Number(valueFor("--max-translation-m") ?? "0.75");
const maximumRecoveryJumpM = Number(valueFor("--max-recovery-jump-m") ?? "1.5");
const maximumVisualResetJumpM = Number(valueFor("--max-visual-reset-jump-m") ?? "5");
const maximumOutOfOrderSampleCount = Number(valueFor("--max-out-of-order") ?? "0");

if (!sessionId) {
  console.error("Usage: bun run acceptance:report --session=<session-id> [--case=baseline|3d|rotation|loop|stairs|elevator|recovery|visual-recovery] [--max-out-of-order=0] [--max-recovery-jump-m=1.5] [--max-visual-reset-jump-m=5] [--out=<file>]");
  process.exit(2);
}

const getJson = async (path: string) => {
  const response = await fetch(`${apiBase}${path}`, { cache: "no-store", headers: requestHeaders });
  if (!response.ok) {
    const suffix = response.status === 401 ? " (set WAY_MEMORY_DASHBOARD_TOKEN for an enforced service)" : "";
    throw new Error(`${path} -> HTTP ${response.status}${suffix}`);
  }
  return response.json() as Promise<JsonRecord>;
};

const finiteNumbers = (values: unknown[]) => values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
const rangeFor = (values: number[]) => values.length
  ? { min: Math.min(...values), max: Math.max(...values), span: Math.max(...values) - Math.min(...values) }
  : { min: null, max: null, span: 0 };
const poseDistanceM = (left: JsonRecord, right: JsonRecord) => {
  const coordinates = ["xM", "yM", "zM"] as const;
  if (coordinates.some((key) => typeof left[key] !== "number" || typeof right[key] !== "number")) return null;
  return Math.sqrt(coordinates.reduce((sum, key) => sum + (left[key] - right[key]) ** 2, 0));
};

try {
  const session = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const raw = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/raw`);
  const poses = Array.isArray(session.poseTrack) ? session.poseTrack as JsonRecord[] : [];
  const corrected = Array.isArray(session.correctedPoseTrack) ? session.correctedPoseTrack as JsonRecord[] : [];
  const rawSamples = Array.isArray(raw.samples) ? raw.samples as JsonRecord[] : [];
  const inventory = Array.isArray(session.sensorInventory) ? session.sensorInventory as JsonRecord[] : [];
  const motionEvents = Array.isArray(session.motionEvents) ? session.motionEvents as JsonRecord[] : [];
  const sourceFlags = [...new Set(poses.flatMap((pose) => Array.isArray(pose.sourceFlags) ? pose.sourceFlags.filter((item): item is string => typeof item === "string") : []))].sort();
  const visualResetPoseIndex = poses.findIndex((pose) => Array.isArray(pose.sourceFlags) && pose.sourceFlags.includes("visual-reset"));
  const visualResetPoseCount = visualResetPoseIndex >= 0 ? poses.filter((pose) => Array.isArray(pose.sourceFlags) && pose.sourceFlags.includes("visual-reset")).length : 0;
  const visualResetPreviousPose = visualResetPoseIndex > 0 ? poses[visualResetPoseIndex - 1] : null;
  const visualResetPose = visualResetPoseIndex >= 0 ? poses[visualResetPoseIndex] : null;
  const visualResetJumpM = visualResetPose && visualResetPreviousPose ? poseDistanceM(visualResetPose, visualResetPreviousPose) : null;
  const motionModes = [...new Set(poses.map((pose) => pose.motionMode).filter((item): item is string => typeof item === "string"))].sort();
  const rotationMotionModesSafe = poses.length > 0 && poses.every((pose) => pose.motionMode === "stationary" || pose.motionMode === "unknown");
  const eventTypes = [...new Set(motionEvents.map((event) => event.type).filter((item): item is string => typeof item === "string"))].sort();
  const loopClosureEventCount = motionEvents.filter((event) => event.type === "loop-closed").length;
  const rawSensorTypes = [...new Set(rawSamples.map((sample) => sample.sensorType).filter((item): item is string => typeof item === "string"))].sort();
  const visualTrackingResetSampleCount = rawSamples.filter((sample) => (
    sample.sensorType === "arcore.visual-pose"
      && sample.metadata?.trackingReset === true
  )).length;
  const rawSensorTypeCounts = Object.fromEntries(rawSamples.reduce((counts, sample) => {
    if (typeof sample.sensorType === "string") counts.set(sample.sensorType, (counts.get(sample.sensorType) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()));
  const poseTimestamps = poses
    .map((pose) => pose.deviceTimestampNs)
    .filter((timestamp): timestamp is number => typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0);
  const poseTimestampMonotonic = poseTimestamps.length === poses.length
    && poseTimestamps.every((timestamp, index) => index === 0 || timestamp > poseTimestamps[index - 1]);
  const latestPoseTimestampNs = poseTimestamps.length ? Math.max(...poseTimestamps) : null;
  const poseSourceCounts = poses.reduce((counts, pose) => {
    if (Array.isArray(pose.sourceFlags)) {
      for (const flag of pose.sourceFlags) {
        if (typeof flag === "string") counts[flag] = (counts[flag] ?? 0) + 1;
      }
    }
    return counts;
  }, {} as Record<string, number>);
  const sourceLastTimestampNs = poses.reduce((latest, pose) => {
    const timestamp = pose.deviceTimestampNs;
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !Array.isArray(pose.sourceFlags)) return latest;
    for (const flag of pose.sourceFlags) {
      if (typeof flag === "string") latest[flag] = Math.max(latest[flag] ?? 0, timestamp);
    }
    return latest;
  }, {} as Record<string, number>);
  const recoveryPoseIndex = poses.findIndex((pose) => Array.isArray(pose.sourceFlags) && pose.sourceFlags.includes("recovered-anchor"));
  const recoveryPreviousPose = recoveryPoseIndex > 0 ? poses[recoveryPoseIndex - 1] : null;
  const recoveryFirstPose = recoveryPoseIndex >= 0 ? poses[recoveryPoseIndex] : null;
  const recoveryJumpM = recoveryFirstPose && recoveryPreviousPose
    ? poseDistanceM(recoveryFirstPose, recoveryPreviousPose)
    : null;
  const recoveryAnchorContinuity = recoveryPoseIndex > 0
    && recoveryJumpM !== null
    && recoveryJumpM <= maximumRecoveryJumpM;
  const sourceAgeSeconds = Object.fromEntries(Object.entries(sourceLastTimestampNs).map(([source, timestamp]) => [
    source,
    latestPoseTimestampNs === null ? null : Number(((latestPoseTimestampNs - timestamp) / 1_000_000_000).toFixed(3)),
  ]));
  const axes = {
    xM: rangeFor(finiteNumbers(poses.map((pose) => pose.xM))),
    yM: rangeFor(finiteNumbers(poses.map((pose) => pose.yM))),
    zM: rangeFor(finiteNumbers(poses.map((pose) => pose.zM))),
  };
  const registeredSensors = inventory.filter((sensor) => sensor.registered === true).length;
  const hasGyroscopeSample = rawSensorTypes.some((type) => type.includes("gyroscope"));
  const normalizedRawSensorTypes = rawSensorTypes.map((type) => type.toLowerCase().replaceAll("_", "-"));
  const rawMotionSensorTypes = normalizedRawSensorTypes.filter((type) => (
    type.includes("accelerometer")
      || type.includes("linear-acceleration")
      || type.includes("gyroscope")
      || type.includes("rotation-vector")
      || type.includes("gravity")
  ));
  const hasRawMotionSensorEvidence = rawMotionSensorTypes.length > 0;
  const hasRotationSample = normalizedRawSensorTypes.some((type) => type.includes("rotation-vector") || type.includes("game-rotation"));
  const transportBudgetSensors = inventory.filter((sensor) => (
    sensor.registered === true
      && typeof sensor.transportMaxHz === "number"
      && Number.isInteger(sensor.transportMaxHz)
      && sensor.transportMaxHz >= 1
      && sensor.transportMaxHz <= 1_000
  )).length;
  const maximumPoseTranslationSpan = Math.max(axes.xM.span, axes.yM.span, axes.zM.span);
  const sampleIds = rawSamples.map((sample) => sample.sampleId).filter((id): id is string => typeof id === "string" && id.length > 0);
  const duplicateSampleIds = sampleIds.length - new Set(sampleIds).size;
  const closure = (session.closure ?? {}) as JsonRecord;
  const client = (session.client ?? {}) as JsonRecord;
  const clientApiOrigin = typeof client.apiBaseUrl === "string"
    ? (() => { try { return new URL(client.apiBaseUrl).origin; } catch { return null; } })()
    : null;
  const checks = {
    sessionLoaded: session.sessionId === sessionId,
    sensorInventory: inventory.length > 0 && registeredSensors > 0,
    sensorTransportBudget: transportBudgetSensors === registeredSensors && registeredSensors > 0,
    // `rawSampleCount` is the lifetime count for the session. The server is
    // intentionally allowed to accept a long capture while retaining only a
    // bounded replay tail, so the bound must be checked against the retained
    // samples and the server-reported retention contract—not the lifetime
    // counter.
    rawReplayBounded: rawSamples.length > 0
      && rawSamples.length <= Number(raw.maxRetainedSamples ?? 1024)
      && Number(raw.maxRetainedSamples ?? 0) === 1024
      && Number(raw.retainedSamples ?? rawSamples.length) === rawSamples.length,
    poseStream: poses.length > 0,
    rawMotionSensorEvidence: hasRawMotionSensorEvidence,
    poseTimestampMonotonic,
    threeAxisMovement: axes.xM.span >= minimumAxisM && axes.yM.span >= minimumAxisM && axes.zM.span >= minimumAxisM,
    rotationSensorEvidence: hasGyroscopeSample || hasRotationSample,
    rotationTranslationBounded: maximumPoseTranslationSpan <= maximumRotationTranslationM,
    rotationMotionModeSafe: rotationMotionModesSafe,
    sampleIdsUniqueInReplay: duplicateSampleIds === 0,
    routeOrderingClean: Number(session.outOfOrderSampleCount ?? 0) <= maximumOutOfOrderSampleCount,
    closureConsistent: closure.adjusted !== true || (closure.status === "closed" && corrected.length >= poses.length),
    recoveryAnchorContinuity,
    visualResetEvidence: visualResetPoseCount > 0,
    visualResetRawEvidence: visualTrackingResetSampleCount > 0,
    visualResetContinuity: visualResetJumpM !== null && visualResetJumpM <= maximumVisualResetJumpM,
    serverBounds: Number(session.droppedSampleCount ?? 0) >= 0 && poses.length <= 1200 && motionEvents.length <= 128,
    clientManifest: client.applicationId === "com.puzzlefuzzy.waymemory"
      && typeof client.versionName === "string"
      && (client.buildType === "debug" || client.buildType === "release")
      && clientApiOrigin === expectedClientApiOrigin,
  };
  const caseChecks: Record<string, boolean> = {
    baseline: checks.sessionLoaded && checks.sensorInventory && checks.sensorTransportBudget && checks.rawReplayBounded && checks.rawMotionSensorEvidence && checks.poseStream && checks.poseTimestampMonotonic && checks.sampleIdsUniqueInReplay && checks.routeOrderingClean && checks.serverBounds && checks.clientManifest,
    "3d": checks.poseStream && checks.threeAxisMovement,
    rotation: checks.rotationSensorEvidence && checks.rotationTranslationBounded && checks.rotationMotionModeSafe,
    loop: checks.closureConsistent && closure.status === "closed" && closure.adjusted === true && corrected.length > 0,
    stairs: motionModes.includes("stairs")
      && eventTypes.includes("stairs-enter")
      && eventTypes.includes("stairs-exit")
      && axes.zM.span >= minimumAxisM,
    elevator: motionModes.includes("elevator")
      && eventTypes.includes("elevator-candidate")
      && eventTypes.includes("elevator-exit")
      && axes.zM.span >= minimumAxisM,
    recovery: checks.sessionLoaded && checks.poseStream && recoveryAnchorContinuity,
    "visual-recovery": checks.sessionLoaded
      && checks.poseStream
      && checks.poseTimestampMonotonic
      && checks.visualResetEvidence
      && checks.visualResetRawEvidence
      && checks.visualResetContinuity
      && loopClosureEventCount <= 1
      && checks.serverBounds,
  };
  const report = {
    generatedAt: new Date().toISOString(),
    apiBase,
    sessionId,
    acceptanceCase,
    counts: {
      samples: session.sampleCount ?? 0,
      rawSamples: session.rawSampleCount ?? 0,
      retainedRawSamples: rawSamples.length,
      poses: poses.length,
      correctedPoses: corrected.length,
      inventory: inventory.length,
      registeredSensors,
      transportBudgetSensors,
      motionEvents: motionEvents.length,
      duplicateSampleIds,
      dropped: session.droppedSampleCount ?? 0,
      outOfOrder: session.outOfOrderSampleCount ?? 0,
      maxOutOfOrder: maximumOutOfOrderSampleCount,
    },
    axes,
    pose: {
      firstTimestampNs: poseTimestamps[0] ?? null,
      lastTimestampNs: poseTimestamps.at(-1) ?? null,
      spanSeconds: poseTimestamps.length > 1 ? Number(((poseTimestamps.at(-1)! - poseTimestamps[0]) / 1_000_000_000).toFixed(3)) : 0,
      timestampMonotonic: poseTimestampMonotonic,
      sourceCounts: poseSourceCounts,
      sourceAgeSeconds,
    },
    motionModes,
    eventTypes,
    rawSensorTypes,
    rawSensorTypeCounts,
    rawMotionSensorTypes,
    rotation: {
      hasGyroscopeSample,
      hasRotationSample,
      maximumPoseTranslationSpan,
      limitM: maximumRotationTranslationM,
      motionModesSafe: rotationMotionModesSafe,
    },
    recovery: {
      firstRecoveredPoseIndex: recoveryPoseIndex >= 0 ? recoveryPoseIndex : null,
      jumpM: recoveryJumpM,
      limitM: maximumRecoveryJumpM,
      continuity: recoveryAnchorContinuity,
      firstRecoveredTimestampNs: recoveryFirstPose?.deviceTimestampNs ?? null,
      previousTimestampNs: recoveryPreviousPose?.deviceTimestampNs ?? null,
    },
    visualRecovery: {
      resetPoseCount: visualResetPoseCount,
      rawTrackingResetSampleCount: visualTrackingResetSampleCount,
      sourceFlag: "visual-reset",
      jumpM: visualResetJumpM,
      limitM: maximumVisualResetJumpM,
      continuity: checks.visualResetContinuity,
      loopClosureCount: loopClosureEventCount,
    },
    sourceFlags,
    client,
    closure,
    checks,
    casePassed: caseChecks[acceptanceCase] ?? false,
    availableCases: caseChecks,
  };
  const output = JSON.stringify(report, null, 2);
  console.log(output);
  const outputPath = valueFor("--out");
  if (outputPath) await Bun.write(outputPath, `${output}\n`);
  if (!report.casePassed) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
