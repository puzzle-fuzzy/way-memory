type JsonRecord = Record<string, any>;

const args = Bun.argv.slice(2);
const valueFor = (name: string) => {
  const prefix = `${name}=`;
  const argument = args.find((item) => item.startsWith(prefix));
  return argument?.slice(prefix.length);
};
const hasFlag = (name: string) => args.includes(name) || args.some((item) => item === `${name}=true`);
const apiBase = (Bun.env.WAY_MEMORY_API_URL ?? "http://101.35.246.159").replace(/\/$/, "");
const sessionId = Bun.env.WAY_MEMORY_SESSION_ID ?? valueFor("--session");
const acceptanceCase = valueFor("--case") ?? "baseline";
const minimumAxisM = Number(valueFor("--min-axis-m") ?? "0.2");
const maximumRotationTranslationM = Number(valueFor("--max-translation-m") ?? "0.75");

if (!sessionId) {
  console.error("Usage: bun run acceptance:report --session=<session-id> [--case=baseline|3d|loop|stairs|elevator] [--out=<file>]");
  process.exit(2);
}

const getJson = async (path: string) => {
  const response = await fetch(`${apiBase}${path}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json() as Promise<JsonRecord>;
};

const finiteNumbers = (values: unknown[]) => values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
const rangeFor = (values: number[]) => values.length
  ? { min: Math.min(...values), max: Math.max(...values), span: Math.max(...values) - Math.min(...values) }
  : { min: null, max: null, span: 0 };

try {
  const session = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
  const raw = await getJson(`/api/sessions/${encodeURIComponent(sessionId)}/raw`);
  const poses = Array.isArray(session.poseTrack) ? session.poseTrack as JsonRecord[] : [];
  const corrected = Array.isArray(session.correctedPoseTrack) ? session.correctedPoseTrack as JsonRecord[] : [];
  const rawSamples = Array.isArray(raw.samples) ? raw.samples as JsonRecord[] : [];
  const inventory = Array.isArray(session.sensorInventory) ? session.sensorInventory as JsonRecord[] : [];
  const motionEvents = Array.isArray(session.motionEvents) ? session.motionEvents as JsonRecord[] : [];
  const sourceFlags = [...new Set(poses.flatMap((pose) => Array.isArray(pose.sourceFlags) ? pose.sourceFlags.filter((item): item is string => typeof item === "string") : []))].sort();
  const motionModes = [...new Set(poses.map((pose) => pose.motionMode).filter((item): item is string => typeof item === "string"))].sort();
  const eventTypes = [...new Set(motionEvents.map((event) => event.type).filter((item): item is string => typeof item === "string"))].sort();
  const rawSensorTypes = [...new Set(rawSamples.map((sample) => sample.sensorType).filter((item): item is string => typeof item === "string"))].sort();
  const axes = {
    xM: rangeFor(finiteNumbers(poses.map((pose) => pose.xM))),
    yM: rangeFor(finiteNumbers(poses.map((pose) => pose.yM))),
    zM: rangeFor(finiteNumbers(poses.map((pose) => pose.zM))),
  };
  const registeredSensors = inventory.filter((sensor) => sensor.registered === true).length;
  const hasGyroscopeSample = rawSensorTypes.some((type) => type.includes("gyroscope"));
  const hasRotationSample = rawSensorTypes.some((type) => type.includes("rotation-vector") || type.includes("game-rotation"));
  const maximumPoseTranslationSpan = Math.max(axes.xM.span, axes.yM.span, axes.zM.span);
  const sampleIds = rawSamples.map((sample) => sample.sampleId).filter((id): id is string => typeof id === "string" && id.length > 0);
  const duplicateSampleIds = sampleIds.length - new Set(sampleIds).size;
  const closure = (session.closure ?? {}) as JsonRecord;
  const checks = {
    sessionLoaded: session.sessionId === sessionId,
    sensorInventory: inventory.length > 0 && registeredSensors > 0,
    rawReplayBounded: rawSamples.length > 0 && rawSamples.length <= 1024 && Number(session.rawSampleCount ?? 0) <= 1024,
    poseStream: poses.length > 0,
    threeAxisMovement: axes.xM.span >= minimumAxisM && axes.yM.span >= minimumAxisM && axes.zM.span >= minimumAxisM,
    rotationSensorEvidence: hasGyroscopeSample || hasRotationSample,
    rotationTranslationBounded: maximumPoseTranslationSpan <= maximumRotationTranslationM,
    sampleIdsUniqueInReplay: duplicateSampleIds === 0,
    closureConsistent: closure.adjusted !== true || (closure.status === "closed" && corrected.length >= poses.length),
    serverBounds: Number(session.droppedSampleCount ?? 0) >= 0 && poses.length <= 1200 && motionEvents.length <= 128,
  };
  const caseChecks: Record<string, boolean> = {
    baseline: checks.sessionLoaded && checks.sensorInventory && checks.rawReplayBounded && checks.poseStream && checks.sampleIdsUniqueInReplay && checks.serverBounds,
    "3d": checks.poseStream && checks.threeAxisMovement,
    rotation: checks.rotationSensorEvidence && checks.rotationTranslationBounded,
    loop: checks.closureConsistent && closure.status === "closed" && closure.adjusted === true && corrected.length > 0,
    stairs: (motionModes.includes("stairs") || eventTypes.includes("stairs-enter")) && axes.zM.span >= minimumAxisM,
    elevator: eventTypes.includes("elevator-candidate") && eventTypes.includes("elevator-exit") && axes.zM.span >= minimumAxisM,
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
      motionEvents: motionEvents.length,
      duplicateSampleIds,
      dropped: session.droppedSampleCount ?? 0,
    },
    axes,
    motionModes,
    eventTypes,
    rawSensorTypes,
    rotation: {
      hasGyroscopeSample,
      hasRotationSample,
      maximumPoseTranslationSpan,
      limitM: maximumRotationTranslationM,
    },
    sourceFlags,
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
