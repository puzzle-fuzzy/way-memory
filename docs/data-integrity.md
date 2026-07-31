# Route data integrity and memory limits

The live route is built from the `track` array returned by the API. The web console does not generate or fall back to a demo route for the live session.

## Coordinate contract

- `lat` is latitude in degrees, limited to `-90..90`.
- `lng` is longitude in degrees, limited to `-180..180`.
- The server sorts accepted samples by Android's monotonic `deviceTimestampNs` before creating track points.
- The web projection treats longitude as east/west and latitude as north/south. It uses a local earth-radius projection in meters, so the two fields cannot be accidentally swapped without failing the visible bounds check.
- Each live `TrackPoint` carries its device timestamp. The dashboard shows point count, segment count, coordinate bounds, and dropped sample count below the visualization.
- `sampleCount` counts all accepted sensor samples. The `track` length counts only accepted samples that contain a latitude/longitude pair; accelerometer, gyroscope, and rotation-vector samples are not position points.

## Filtering and 3D data

- Malformed numbers, invalid coordinates, invalid timestamps, vectors containing non-finite values, and oversized sensor vectors are rejected.
- A location point within `0.5m` of the previous point during a `2s` window is treated as a duplicate.
- A location jump larger than the configured walking-speed/uncertainty envelope is dropped when the time gap is short. The count is exposed as `droppedSampleCount`.
- GNSS altitude is normalized relative to the first accepted GNSS altitude. Barometer altitude is normalized relative to the first accepted pressure reading. This is relative route height, not centimeter-level phone lifting; that requires a later inertial vertical-motion model.
- Android route capture requires precise location permission. Approximate/network-only location can report kilometer-scale accuracy and must not be mistaken for a dense pedestrian track.
- The web visualization is point-only and uses one canvas: every visible dot represents one accepted location sample, and the newest dot is highlighted. No interpolation or route line is drawn, so the display cannot invent movement between measurements. Height is projected into each point's screen position; the previous decorative floor grid and full ground-projection path are not part of the route. A canvas keeps the browser DOM size constant when a session contains many samples.

## Server-side bounds

The MVP is intentionally memory-bounded because sessions are currently in memory:

- 20 sessions maximum; stopped sessions are evicted oldest-first when capacity is needed.
- 500 track points per session.
- 32 latest sensor types per session, with at most 16 values per sensor snapshot.
- 500 samples per batch.
- 512 KiB maximum JSON request/WebSocket message budget.

The API never stores the raw sample history. It keeps only bounded live aggregates and the recent track window. Restarting the service clears live sessions until persistent route storage is introduced.
