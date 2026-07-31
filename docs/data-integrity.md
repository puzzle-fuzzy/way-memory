# Route data integrity and memory limits

The live route is built from the `poseTrack` array returned by the API. The web console does not generate or fall back to a demo route for the live session. `track` and `relativeTrack` remain diagnostic compatibility views.

## Coordinate contract

- `lat` is latitude in degrees, limited to `-90..90`.
- `lng` is longitude in degrees, limited to `-180..180`.
- The server sorts accepted samples by Android's monotonic `deviceTimestampNs` before creating track points.
- The web projection treats longitude as east/west and latitude as north/south. It uses a local earth-radius projection in meters, so the two fields cannot be accidentally swapped without failing the visible bounds check.
- Each live `TrackPoint` carries its device timestamp. The dashboard shows point count, segment count, coordinate bounds, and dropped sample count below the visualization.
- `sampleCount` counts all accepted sensor samples. The `track` length counts only accepted samples that contain a latitude/longitude pair; accelerometer, gyroscope, and rotation-vector samples are not position points.
- Android samples carry a stable `sampleId`. The server keeps a bounded per-session seen-ID window (8,192 IDs) and ignores repeats, so a crash between WebSocket send and local cursor commit cannot duplicate route points or sensor counts. Legacy samples without an ID remain accepted but cannot receive this idempotency guarantee.
- `rawSampleCount` counts normalized samples accepted into the bounded replay ring. The `/api/sessions/:id/raw` endpoint exposes only the retained tail, never an unbounded history.
- The Android uploader persists a bounded app-private offline queue capped at 4,096 samples and 8 MiB. It drops the oldest samples after either hard limit and surfaces the drop count in the capture UI. The active session ID is persisted too, so a process restart can attempt to resume the same server session. If the server grace window has expired, the client creates a new session and drains the retained samples there. A crash between WebSocket send and the local cursor commit may duplicate a small batch; this is intentionally safer than losing a route segment.
- `poseTrack` counts unified fused-pose points in local ENU meters. Each Pose includes source flags, accuracy, velocity, motion mode and stationary state.
- Each Pose may carry a `frame`: `local-enu` for the unified route frame or `arcore-local` for raw session-local visual coordinates. Legacy payloads default to `local-enu`; Android promotes ARCore samples only after horizontal frame alignment.
- `relativeTrack` counts legacy device-side sensor-fusion motion points. These are local meters from the session origin, not geographic coordinates; the web console uses them only when no unified Pose stream exists.

## Filtering and 3D data

- Malformed numbers, invalid coordinates, invalid timestamps, vectors containing non-finite values, and oversized sensor vectors are rejected.
- A location point within `0.5m` of the previous point during a `2s` window is treated as a duplicate.
- A location jump larger than the configured walking-speed/uncertainty envelope is dropped when the time gap is short. The count is exposed as `droppedSampleCount`.
- GNSS altitude is normalized relative to the first accepted GNSS altitude. Barometer altitude is normalized relative to the first accepted pressure reading. This is relative route height, not centimeter-level phone lifting; that requires a later inertial vertical-motion model.
- Android route capture requires precise location permission. Approximate/network-only location can report kilometer-scale accuracy and must not be mistaken for a dense pedestrian track.
- Inertial relative motion is a short-term observation layer. Double integration of acceleration drifts, so it must later be corrected by GNSS, visual-inertial tracking, landmarks, or manual annotations before navigation use.
- A closure is reported as `open`, `candidate`, or `closed`. When aligned visual metric evidence provides `loop-closure`, raw `poseTrack` remains immutable and the server creates a separate corrected Pose track; the web console never silently overwrites raw measurements.
- Pressure and IMU evidence can produce an `elevator-candidate` event. It is not treated as a confirmed floor transition without additional visual or manual evidence.
- The web visualization is point-only and uses one canvas: every visible dot represents one accepted location sample, and the newest dot is highlighted. No interpolation or route line is drawn, so the display cannot invent movement between measurements. Height is projected into each point's screen position; the previous decorative floor grid and full ground-projection path are not part of the route. A canvas keeps the browser DOM size constant when a session contains many samples.

## Server-side bounds

The MVP is intentionally memory-bounded because sessions are currently in memory:

- 20 sessions maximum; stopped sessions are evicted oldest-first when capacity is needed.
- 500 track points per session.
- 1,200 unified Pose points per session.
- 128 motion events per session.
- 1,024 normalized raw samples per session for short replay.
- 32 latest sensor types per session, with at most 16 values per sensor snapshot.
- 128 bounded sensor-stat entries per session, retaining counts and first/last device timestamps without retaining every raw value.
- 500 samples per batch.
- 512 KiB maximum JSON request/WebSocket message budget.

The API never stores an unbounded raw sample history. It keeps bounded live aggregates, a recent Pose window, and a 1,024-sample replay tail. `bun run replay:session <session-id>` re-feeds that bounded raw tail into a fresh session for deterministic transport and route-integrity checks. The API also snapshots sessions into SQLite at `WAY_MEMORY_DB_PATH` (default `.data/way-memory.sqlite`) every two seconds while active and immediately when stopped. At most 100 snapshots are retained, and an interrupted active session is recovered as `stopped` after restart.
