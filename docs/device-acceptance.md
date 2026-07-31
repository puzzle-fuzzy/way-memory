# Android real-device acceptance

This is the gate between “the code builds” and “the product recorded a real route”. The current Windows workstation has no authorized `adb` device, so this checklist is intentionally not marked passed until a phone produces the evidence below.

## Prepare

1. Connect one Android phone with USB debugging enabled and accept the RSA prompt.
2. Turn on system location. Grant **precise location** and, on Android 10+, **physical activity** permission for step-aided pedestrian dead reckoning. Camera permission is optional; it is needed only for the ARCore visual correction path.
3. Install and launch the exact APK from the committed worktree:

```powershell
cd E:\__Super_Core__\way-memory
$env:JAVA_HOME='D:\software\JetBeains\Programs\Android Studio\jbr'
Push-Location apps\android
try { .\gradlew.bat :app:assembleDebug -PwayMemoryApiUrl=http://101.35.246.159 --offline --no-daemon --no-parallel } finally { Pop-Location }
bun run android:acceptance
```

The `-PwayMemoryApiUrl` value is important: `10.0.2.2` is only the Android emulator host and is not reachable from a physical phone. The acceptance APK must be built with the public API URL (or an explicitly reachable HTTPS deployment).

This matrix uses a debug APK, so its current HTTP test endpoint is permitted. A release build refuses an `http://` API URL; production must use an HTTPS domain and WSS.

For an enforced service, provision the owner as described in `docs/authentication.md`, paste only the returned `deviceToken` into the Android app's credential field, and use the returned `dashboardToken` in the web console. The tokens are not part of the APK or web build and must not be recorded in the evidence directory.

If more than one device is connected, use:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/device-acceptance.ps1 -Serial <serial>
```

For the actual sensor gate, require a physical phone explicitly. The script labels emulator installs as protocol/lifecycle-only and refuses them when this switch is present:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/device-acceptance.ps1 `
  -RequirePhysical -ApiBaseUrl https://way-memory.yxswy.com
```

The script only installs and launches the APK. It does not grant permissions silently and does not fabricate route data.

## Capture matrix

Run each case as a separate session and record the session ID shown by the API/WebSocket logs.

| Case | Device action | Required evidence |
| --- | --- | --- |
| Sensor inventory | Start capture while holding the phone still, then move and rotate it | The Android screen and session `sensorInventory` list the device-provided sensors, including any registration-denied entries and each sensor's `transportMaxHz`; the session has bounded raw samples for known and unknown sensor types; no crash |
| 3D translation | Move the phone forward/back, left/right, and up/down for at least 30 seconds | `poseTrack` contains changing `xM/yM/zM`; the web canvas shows individual 3D points, not an invented connecting line |
| Rotation only | Rotate in place without translating | Orientation/visual samples change, but translation is not falsely reported as large movement |
| Closed loop | Walk a loop and return near the start | Raw start/end remain visible; `closure` is only `closed` when aligned visual loop evidence exists; corrected track is separate from raw track |
| Visual relocalization | With ARCore active, cover the camera or move into a textureless area until tracking pauses, then uncover it and continue walking | The first recovered visual frame is not promoted as a large movement; the next fused pose exposes `visual-reset`; no false long segment or duplicate `loop-closed` event is created |
| Stairs | Walk at least one flight with horizontal travel | `stairs-enter`/`stairs-exit` or a `stairs` pose mode and a changing relative `zM` |
| Elevator | Ride an elevator with minimal horizontal movement | `elevator-candidate`, `elevator-exit`, and pressure-derived relative height; it is not presented as confirmed floor identity |
| Orientation/background | Start capture, rotate the screen, lock it briefly, unlock, then stop | The same capture remains active; IMU/GNSS/barometer continue while visual tracking is paused; no second start is required |
| Network interruption | Disable network for less than two minutes, move briefly, restore network | `session.resumed` reconnects to the same session; pending queue stays bounded; the UI exposes any dropped count |
| Process recovery | Start capture, move at least several metres, force-stop the app, relaunch it before the two-minute server grace window expires, then move again | With precise location still granted, the app automatically resumes the persisted session; retained samples are drained, and any replayed batch is bounded and duplicate-tolerant, never silently lost. The first post-resume fused Pose must continue from the server's last pre-stop Pose: no reset-to-origin jump and no more than 1.5m discontinuity in 3D Euclidean distance. A normal explicit Stop deletes the resume marker. |
| System service recreation | Start capture, keep the phone locked, and use an OEM/system test to stop and recreate the foreground service without pressing Stop | The redelivered start intent restarts collection with the same persisted session marker; the route does not become a new session and the marker is not deleted by `onDestroy()`. Verify the same recovery continuity report as the process-recovery case. |
| Crash replay integrity | Force-stop during a visible upload burst, relaunch, then inspect the session | Replayed samples retain their `sampleId`; server `sampleCount`, pose count, and sensor statistics do not double-count them |

## Server evidence

For a captured session `<SESSION_ID>`:

```powershell
Invoke-RestMethod "http://101.35.246.159/api/sessions/<SESSION_ID>" | ConvertTo-Json -Depth 8
Invoke-RestMethod "http://101.35.246.159/api/sessions/<SESSION_ID>/raw" | ConvertTo-Json -Depth 8
```

The machine-readable audit can be run after each capture. It exits with code 0 only when the selected case passes, and can save the exact report used as evidence:

```powershell
$env:WAY_MEMORY_API_URL = "http://101.35.246.159"
$env:WAY_MEMORY_SESSION_ID = "<SESSION_ID>"
bun run acceptance:report --case=baseline --max-out-of-order=0 --out=artifacts/<SESSION_ID>-baseline.json
bun run acceptance:report --case=3d --min-axis-m=0.2 --out=artifacts/<SESSION_ID>-3d.json
bun run acceptance:report --case=rotation --max-translation-m=0.75 --out=artifacts/<SESSION_ID>-rotation.json
bun run acceptance:report --case=loop --out=artifacts/<SESSION_ID>-loop.json
bun run acceptance:report --case=stairs --out=artifacts/<SESSION_ID>-stairs.json
bun run acceptance:report --case=elevator --out=artifacts/<SESSION_ID>-elevator.json
bun run acceptance:report --case=recovery --max-recovery-jump-m=1.5 --out=artifacts/<SESSION_ID>-recovery.json
bun run acceptance:report --case=visual-recovery --max-visual-reset-jump-m=5 --out=artifacts/<SESSION_ID>-visual-recovery.json
```

也可以用一次性证据采集脚本保存选定 case 的报告和 raw replay：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/collect-device-evidence.ps1 `
  -SessionId <SESSION_ID> -Case 3d -MaxOutOfOrder 0

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/collect-device-evidence.ps1 `
  -SessionId <SESSION_ID> -Case recovery -MaxRecoveryJumpM 1.5
```

脚本不会覆盖已有证据目录；重复采集请更换 `-OutputRoot`。报告失败时仍保留 JSON 供诊断，不得把失败报告当作通过证据。

Current evidence status (2026-08-01): the workstation has an Android emulator, but no physical Android phone is connected. Emulator tests cover protocol and lifecycle regressions only; they do not count as ARCore, GNSS, barometer, background, stairs, elevator, or rotation acceptance.

The report is an audit of the server's received evidence; it cannot manufacture sensor data or prove a case that was not actually captured. The baseline also requires the session's `client` manifest to identify `com.puzzlefuzzy.waymemory`, a version/build type, and an API origin matching `WAY_MEMORY_API_URL`. This catches an APK built against the wrong server before its data is accepted as field evidence.

Record at minimum:

- `sampleCount`, `rawSampleCount`, `droppedSampleCount`, and `outOfOrderSampleCount`;
- `outOfOrderSampleCount` defaults to a strict zero-tolerance baseline; use `--max-out-of-order=<N>` only when a field test explicitly records and accepts bounded transport reordering.
- `poseTrack` count and the min/max of `xM`, `yM`, `zM`;
- Pose timestamp monotonicity, time span, per-source counts and source age;
- For the rotation case, every pose must keep `motionMode` at `stationary` or `unknown` in addition to staying inside the translation limit;
- raw sensor type counts, `sourceFlags`, `frame`, `motionMode`, and `motionEvents`;
- `closure.status`, `closure.adjusted`, and whether `correctedPoseTrack` is present;
- `client.applicationId`, `client.versionName`, `client.buildType`, and normalized `client.apiBaseUrl`;
- the web page screenshot showing the same session ID and point count.

## Pass boundary

Builds, local unit tests, public HTTP health, public WebSocket transport, bounded persistence, loop-correction smoke, replay smoke, and reconnect smoke are automated gates. They do not prove phone sensor quality.

Real-device acceptance passes only after the capture matrix produces the fields above. The product must not claim arbitrary centimeter-level positioning: GNSS, inertial integration, barometer, and ARCore each have different failure modes, so route confidence and source flags remain part of the stored evidence.
