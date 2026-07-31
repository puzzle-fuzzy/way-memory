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
4. optional ARCore session-local visual-inertial pose.

The output is an uncertainty-bearing estimate, not a promise of centimeter-level accuracy. IMU double integration is corrected when external observations are available, and stationary periods learn a small acceleration bias.

## ARCore boundary

ARCore 1.54.0 is integrated as an optional feature. It starts only after camera permission, device support, and Google Play Services for AR are available. Unsupported devices continue with GNSS, IMU, and barometer.

ARCore uses a session-local metric frame. The adapter converts `+X right, +Y up, -Z forward` into the display frame `X right, Y forward, Z up`. It waits for meaningful visual and inertial displacement before estimating horizontal alignment. Samples before alignment remain diagnostic and are not promoted into the unified route. Promoted poses carry `visual` and `visual-aligned` source flags.

The server defaults legacy payloads without `frame` to `local-enu`. The web console shows the active coordinate reference so an ARCore local pose cannot silently be mistaken for a geographic coordinate.

## Loop closure

The server keeps three closure states:

- `open`: there is no evidence of returning to the start;
- `candidate`: the current pose is close to the start after enough travel, but there is no visual place evidence;
- `closed`: a trusted visual loop-closure source authorizes correction.

The current Android client emits `loop-candidate` when the aligned ARCore track returns near its visual origin. It does not move the original point or rewrite raw samples. A later place-recognition or pose-graph stage may turn that candidate into a corrected route while preserving the original measurement track.

## Elevator and stairs

Pressure vertical speed, horizontal speed, and motion state can emit `elevator-candidate` and `elevator-exit`. Weather, air conditioning, and building airflow make pressure alone insufficient for floor confirmation. Floor transitions need visual structure, a floor plan/annotation, or explicit user confirmation. Stairs should be inferred from repeated vertical steps and walking cadence, not from a single pressure spike.

## Failure policy

Camera occlusion, low light, textureless surfaces, background restrictions, or missing ARCore must lower confidence and expose the active source. The system must not continue drawing a visually precise path after its uncertainty has exceeded the route's acceptance threshold.
