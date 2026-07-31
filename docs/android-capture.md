# Android capture lifecycle

`SensorCollector` is owned by `WayMemoryApplication`, not by an Activity. The start button launches `CaptureForegroundService`, which holds a foreground notification while IMU, GNSS, barometer, and the WebSocket uploader continue running.

Sensor and location callbacks are registered on a dedicated `HandlerThread`, not the Activity main thread. Local fusion still consumes every callback while the bounded diagnostic queue and UI state updates are kept off the rendering path; the transport limiter only limits persisted/uploaded diagnostics.

ARCore is different: its camera session is attached to the visible Activity and is paused on `onPause`. The route continues with non-visual fusion while the phone is locked or another app is in front. When the Activity returns, the same collector and session resume; orientation changes do not request a new capture start.

The service is declared with the Android location foreground-service type. Precise location is still required for a trustworthy GNSS route. Camera permission is optional for the product because unsupported devices must retain a usable IMU/GNSS/barometer fallback.

The service is promoted with the explicit `FOREGROUND_SERVICE_TYPE_LOCATION` type on Android 10 and newer. Capture must be started from the visible Activity; after that, the foreground service and its persistent notification are the supported path for continuing location access while the screen is locked. This does not make ARCore camera tracking continue in the background: visual tracking is paused when the Activity pauses and the non-visual route remains active.

The foreground service uses `START_REDELIVER_INTENT`. If Android recreates the service/process after a system kill, the start intent is redelivered and the uploader resumes the durable session marker and offline queue. `onDestroy()` deliberately does not behave like an explicit Stop: only the user's Stop action sends `session.stop` and removes `active-session.id`. This keeps process recovery distinguishable from an intentional end of capture.

This is a collection policy, not a promise that Android will provide unrestricted background camera access. A future production release must also complete notification copy, battery-optimization guidance, Android OEM background tests, and explicit user controls for stopping capture.
