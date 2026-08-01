# Android capture lifecycle

`SensorCollector` is owned by `WayMemoryApplication`, not by an Activity. The start button launches `CaptureForegroundService`, which holds a foreground notification while IMU, GNSS, barometer, and the WebSocket uploader continue running.

Sensor and location callbacks are registered on a dedicated `HandlerThread`, not the Activity main thread. Local fusion still consumes every callback while the bounded diagnostic queue and UI state updates are kept off the rendering path; the transport limiter only limits persisted/uploaded diagnostics.

At capture start, Android inventories the union of the static `TYPE_ALL` list and the API 24+ dynamic sensor list, de-duplicated by the platform string type and sensor ID. A `DynamicSensorCallback` registers a sensor that appears during capture and marks a disconnected dynamic sensor unavailable without allowing it to create a second inventory entry. The session inventory therefore records the device capability snapshot and registration outcome, while the raw stream remains the authoritative evidence of which sensors actually emitted samples.

ARCore is different: its camera session is attached to the visible Activity and is paused on `onPause`. The route continues with non-visual fusion while the phone is locked or another app is in front. When the Activity returns, the same collector and session resume; orientation changes do not request a new capture start.

The service is declared with the Android location foreground-service type. Precise location is still required for a trustworthy GNSS route. Camera permission is optional for the product because unsupported devices must retain a usable IMU/GNSS/barometer fallback.

The service is promoted with the explicit `FOREGROUND_SERVICE_TYPE_LOCATION` type on Android 10 and newer. Capture must be started from the visible Activity; after that, the foreground service and its persistent notification are the supported path for continuing location access while the screen is locked. This does not make ARCore camera tracking continue in the background: visual tracking is paused when the Activity pauses and the non-visual route remains active.

The foreground service uses `START_REDELIVER_INTENT`. If Android recreates the service/process after a system kill, the start intent is redelivered and the uploader resumes the durable session marker and offline queue. `onDestroy()` deliberately does not behave like an explicit Stop: only the user's Stop action sends `session.stop` and removes `active-session.id`. This keeps process recovery distinguishable from an intentional end of capture.

The uploader's session-start contract supports both `learning` and `navigation` plus an optional verified `routeId`. The selected mode/route is kept in the app-private `active-session.config.json` beside the session marker, so process recovery does not silently create a learning session for a navigation capture. The current visible screen still starts learning mode by default; route selection UX remains a separate enrollment/navigation workflow.

This is a collection policy, not a promise that Android will provide unrestricted background camera access. A future production release must also complete notification copy, battery-optimization guidance, Android OEM background tests, and explicit user controls for stopping capture.
