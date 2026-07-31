# Android capture lifecycle

`SensorCollector` is owned by `WayMemoryApplication`, not by an Activity. The start button launches `CaptureForegroundService`, which holds a foreground notification while IMU, GNSS, barometer, and the WebSocket uploader continue running.

ARCore is different: its camera session is attached to the visible Activity and is paused on `onPause`. The route continues with non-visual fusion while the phone is locked or another app is in front. When the Activity returns, the same collector and session resume; orientation changes do not request a new capture start.

The service is declared with the Android location foreground-service type. Precise location is still required for a trustworthy GNSS route. Camera permission is optional for the product because unsupported devices must retain a usable IMU/GNSS/barometer fallback.

The service is promoted with the explicit `FOREGROUND_SERVICE_TYPE_LOCATION` type on Android 10 and newer. Capture must be started from the visible Activity; after that, the foreground service and its persistent notification are the supported path for continuing location access while the screen is locked. This does not make ARCore camera tracking continue in the background: visual tracking is paused when the Activity pauses and the non-visual route remains active.

This is a collection policy, not a promise that Android will provide unrestricted background camera access. A future production release must also complete notification copy, battery-optimization guidance, Android OEM background tests, and explicit user controls for stopping capture.
