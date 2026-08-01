# Pose fusion and route closure

## Current implementation

`way-memory` now uses `PoseEstimate` as the primary live route stream. A pose contains:

- session-local `xM / yM / zM` coordinates;
- three-axis velocity;
- horizontal and vertical uncertainty;
- source and source flags;
- `motionMode`: stationary, walking, stairs, elevator, vehicle, or unknown;
- a coordinate `frame`: `local-enu` or `arcore-local`.

Raw sensor samples are still validated by the server and only the latest 1,024 normalized samples are retained per session for short replay. Long-term route storage must use a persistent store rather than process memory.

## Android fusion inputs

The Android client combines:

1. IMU acceleration transformed by the best available rotation vector;
2. GNSS position and accuracy when precise location is available;
3. barometric relative altitude and vertical speed;
4. optional ARCore session-local visual-inertial pose;
5. optional Android step detector/counter with the current rotation-derived heading.

The output is an uncertainty-bearing estimate, not a promise of centimeter-level accuracy. IMU double integration is corrected when external observations are available, and stationary periods learn a small acceleration bias.

Translation and rotation are intentionally separated: a phone can rotate in a blind user's hand while its center remains in place. Gyroscope activity is retained in the raw sensor stream, but zero translational acceleration and zero vertical pressure motion keep the fused pose stationary instead of turning angular motion into walking or an artificial route segment. The regression suite includes a pure-rotation case that asserts all three position axes remain at the origin.

GNSS fixes are also used to estimate a bounded velocity from successive monotonic fixes. A fix is treated as fresh for five seconds; after that, pose accuracy grows with the age of the last fix and the source flags change to `gnss-stale`. The same freshness boundary is applied to barometer and visual evidence, so a previously available sensor cannot silently keep a high-confidence label after its stream has stopped. If GNSS altitude appears after a fix that had no altitude, the engine bridges it through the current relative height instead of resetting the z-axis to an unrelated zero.

## ARCore boundary

ARCore 1.54.0 is integrated as an optional feature. It starts only after camera permission, device support, and Google Play Services for AR are available. Unsupported devices continue with GNSS, IMU, and barometer.

ARCore uses a session-local metric frame. The adapter converts `+X right, +Y up, -Z forward` into the display frame `X right, Y forward, Z up`. It waits for meaningful visual and inertial displacement before estimating horizontal alignment. Samples before alignment remain diagnostic and are not promoted into the unified route. Promoted poses carry `visual` and `visual-aligned` source flags.

Visual correction also contributes velocity in meters per second using the frame timestamp interval. It is not computed from a raw position error, which would mix meters and meters per second. When visual frames pause, subsequent inertial poses expose `visual-stale` until a fresh tracked frame arrives.

ARCore tracking loss is treated as a coordinate-frame boundary, not as a movement event. The first tracked frame after a pause, relocalization, or session restart is emitted immediately with `trackingReset=true`; the fusion engine re-anchors the visual origin and does not promote that reset frame into the route. The next fused pose exposes `visual-reset`, so the web and replay evidence can distinguish a visual re-anchor from continuous visual correction. A visual translation that implies more than 12 m/s between valid monotonic frames is rejected and re-anchored as well. This prevents a camera relocalization jump from becoming a false straight segment or false loop closure; IMU, GNSS, barometer, and step-PDR remain responsible for continuity while visual evidence recovers.

This is still not global visual place recognition. If ARCore loses the scene and returns with a new local origin, the product preserves the route continuity and uncertainty but does not claim that the camera has recognized the same building location. Cross-session place matching requires GNSS/route alignment, stable visual landmarks, or an explicit human annotation.

When a step sensor is registered, the client maintains a separate step-PDR track using a conservative 0.65 m default stride. It blends that track into the inertial pose instead of adding the full stride on top of integrated acceleration, and marks the resulting source as `step-pdr`. This is a walking fallback, not a phone-lift detector and not an absolute positioning guarantee. Android 10+ may require `ACTIVITY_RECOGNITION`; a denied registration remains visible in `sensorInventory` and does not stop the other fusion sources.

The server defaults legacy payloads without `frame` to `local-enu`. The web console shows the active coordinate reference so an ARCore local pose cannot silently be mistaken for a geographic coordinate.

## Loop closure

The server keeps three closure states:

- `open`: there is no evidence of returning to the start;
- `candidate`: the current pose is close to the start after enough travel, but there is no visual place evidence;
- `closed`: a trusted visual loop-closure source authorizes correction.

The Android client emits `loop-closed` only after an aligned ARCore metric track has travelled at least 8m and returns within 1.5m of its visual origin. The service keeps the raw `poseTrack` immutable and generates a separate `correctedPoseTrack` using a distributed endpoint correction. The closure anchor and cumulative travelled distance are persisted independently of the bounded Pose window, while the correction stores its three-axis displacement and timestamp interval in the session snapshot. This keeps long sessions and post-restart closure correction tied to the true session start rather than the first retained window point. The web console uses the corrected track only when `closure.adjusted=true`. This is metric session closure, not a global place-recognition guarantee; low-light or relocalization failures must remain visible through uncertainty and source flags.

When Android recreates the process, the uploader resumes the same server session and receives its `latestPose`. Fusion is held at the raw-sample layer until that response arrives, then the pose position, velocity, motion mode, and monotonic timestamp seed the new local engine. The first GNSS fix and first pressure sample after recovery establish references without resetting the existing `xM/yM/zM` route. Recovered poses carry `recovered-anchor` so a field replay can distinguish continuity from a new origin. If the server grace window has expired, the client intentionally starts a new session instead of pretending that two local coordinate frames are continuous.

## Elevator and stairs

Pressure vertical speed, horizontal speed, and motion state can emit `elevator-candidate` and `elevator-exit`; the phone does not need to be shaken or translated horizontally because it may be held still inside the elevator. Weather, air conditioning, and building airflow make pressure alone insufficient for floor confirmation. Floor transitions need visual structure, a floor plan/annotation, or explicit user confirmation. Stairs should be inferred from repeated vertical steps and walking cadence, not from a single pressure spike.

## Failure policy

Camera occlusion, low light, textureless surfaces, background restrictions, or missing ARCore must lower confidence and expose the active source. The system must not continue drawing a visually precise path after its uncertainty has exceeded the route's acceptance threshold.
