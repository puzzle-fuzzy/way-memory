# Web realtime trajectory acceptance

Date: 2026-08-01

## Problem fixed

The API was receiving WebSocket `session.delta` messages, but the dashboard could show `0 Pose` and `0 samples`. The cause was a lifecycle `session.updated` object being treated as a full trajectory snapshot. Its intentionally lightweight arrays replaced points already assembled from deltas. The history selector also inferred point counts from those empty arrays.

## Protocol and client changes

- `SessionDelta` now includes absolute counts for geographic, relative, Pose, and corrected-Pose tracks.
- The web client uses the absolute counts for history entries and never infers them from one delta batch.
- Metadata-only lifecycle updates preserve live trajectory arrays, sensor arrays, and motion events already received.
- A slow session snapshot cannot rewind a newer live session assembled from WebSocket deltas.

## Local evidence

The local API was running at `http://127.0.0.1:8787` and the Vite dashboard at `http://127.0.0.1:3412/`.

Session `59b1e1d5-1f56-402a-ae42-e99cb63314d2` was streamed through six WebSocket batches and then stopped:

- server: `12 samples`, `7 Pose`, `7 relative` points;
- browser main view: `7 points`;
- browser history entry: `7 Pose · 12 samples`;
- the stream used multiple batches, so this was not only a final REST snapshot.

## Gates

Passed after the change:

```powershell
bun run typecheck:web
bun run build:web
bun run smoke
bun run smoke:acceptance-cases
bun run check:docs
```

## Boundary

This proves the local web/API realtime merge path. It does not prove a physical Android phone, an ARCore-capable device, public HTTPS/WSS, or production deployment. Those remain explicit acceptance gates in `docs/acceptance-status.md` and `docs/device-acceptance.md`.

## Follow-up validation

- The full Android isolated gate was rerun on this commit: five instrumented tests, JVM unit tests, Debug/Release builds, and `BUILD SUCCESSFUL`.
- The only connected Android target remains `emulator-5554`; the emulator reports ARCore unavailable, so no ARCore or physical sensor evidence is claimed.
- Tencent Cloud staging is prepared for this commit, but the protected production environment, DNS A record, and ACME certificate are still absent. The release installer refuses to proceed until those checks pass.
