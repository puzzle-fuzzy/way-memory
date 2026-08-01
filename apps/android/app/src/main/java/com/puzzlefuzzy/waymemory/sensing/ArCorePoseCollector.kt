package com.puzzlefuzzy.waymemory.sensing

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.google.ar.core.ArCoreApk
import com.google.ar.core.ArCoreApk.Availability
import com.google.ar.core.Camera
import com.google.ar.core.Config
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.UnavailableArcoreNotInstalledException
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableSdkTooOldException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

data class VisualTrackingStatus(
    val available: Boolean = false,
    val active: Boolean = false,
    val trackingState: String = "unavailable",
    val failureReason: String? = null,
    val detail: String = "",
)

data class VisualPoseSample(
    val deviceTimestampNs: Long,
    val xM: Float,
    val yM: Float,
    val zM: Float,
    val accuracyM: Float,
    val confidence: Float,
    val trackingState: String,
    val failureReason: String? = null,
    val trackingReset: Boolean = false,
)

private const val AVAILABILITY_RETRY_DELAY_MS = 500L

/**
 * Optional ARCore visual-inertial pose source.
 *
 * ARCore's world is local to one session. The adapter deliberately emits an
 * `arcore-local` frame and never pretends it is latitude/longitude or global
 * ENU. The fusion layer can only promote it after an explicit alignment.
 */
class ArCorePoseCollector(
    private val appContext: Context,
    private val onPose: (VisualPoseSample) -> Unit,
    private val onStatus: (VisualTrackingStatus) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var session: Session? = null
    private var surface: GLSurfaceView? = null
    private var hostActivity: Activity? = null
    private var userRequestedInstall = true
    private var resumed = false
    private var textureConfigured = false
    private var initialTranslation: FloatArray? = null
    private var lastEmittedTimestampNs = 0L
    private var lastStatusKey: String? = null
    private var wasTracking = false

    fun createView(context: Context): GLSurfaceView {
        // An Activity recreation (for example, an orientation change) creates
        // a new GL context and texture name while the session may remain
        // alive in the application-scoped collector. Rebind the camera to the
        // new texture, but deliberately keep initialTranslation so the route
        // does not jump to a new visual origin.
        surface?.onPause()
        textureConfigured = false
        return GLSurfaceView(context).also { view ->
            view.setEGLContextClientVersion(2)
            view.setRenderer(Renderer())
            view.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
            surface = view
        }
    }

    fun start(activity: Activity) {
        hostActivity = activity
        if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            emitStatus(VisualTrackingStatus(detail = "等待相机权限"))
            return
        }

        val availability = runCatching { ArCoreApk.getInstance().checkAvailability(activity) }.getOrNull()
        if (availability == Availability.UNKNOWN_CHECKING) {
            emitStatus(VisualTrackingStatus(trackingState = "checking", detail = "正在检查设备的 ARCore 能力"))
            mainHandler.postDelayed({
                if (session == null && hostActivity === activity) start(activity)
            }, AVAILABILITY_RETRY_DELAY_MS)
            return
        }
        if (availability == null || !availability.isSupported) {
            emitStatus(VisualTrackingStatus(detail = "设备或 Google Play Services for AR 不可用"))
            return
        }

        try {
            when (ArCoreApk.getInstance().requestInstall(activity, userRequestedInstall)) {
                ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
                    userRequestedInstall = false
                    emitStatus(VisualTrackingStatus(available = true, detail = "正在准备 Google Play Services for AR"))
                    return
                }
                ArCoreApk.InstallStatus.INSTALLED -> Unit
            }
            if (session == null) {
                session = Session(activity).also { arSession ->
                    val config = Config(arSession).apply {
                        planeFindingMode = Config.PlaneFindingMode.DISABLED
                        lightEstimationMode = Config.LightEstimationMode.DISABLED
                    }
                    arSession.configure(config)
                }
                textureConfigured = false
                initialTranslation = null
                lastEmittedTimestampNs = 0L
                wasTracking = false
            }
            resumeSession()
        } catch (error: UnavailableUserDeclinedInstallationException) {
            emitStatus(VisualTrackingStatus(available = true, detail = "用户未安装或未更新 AR 服务"))
        } catch (error: UnavailableDeviceNotCompatibleException) {
            emitStatus(VisualTrackingStatus(detail = "设备不支持 ARCore"))
        } catch (error: UnavailableSdkTooOldException) {
            emitStatus(VisualTrackingStatus(detail = "Android 版本不满足 ARCore 要求"))
        } catch (error: UnavailableArcoreNotInstalledException) {
            emitStatus(VisualTrackingStatus(available = true, detail = "未安装 Google Play Services for AR"))
        } catch (error: Exception) {
            emitStatus(VisualTrackingStatus(available = true, detail = "ARCore 启动失败：${error.javaClass.simpleName}"))
        }
    }

    fun onHostResume(activity: Activity) {
        hostActivity = activity
        if (session != null && !resumed) {
            resumeSession()
        } else if (session == null) {
            // requestInstall() may have opened the AR Services installer during
            // start(). Once the Activity resumes, retry initialization with the
            // previously recorded user decision instead of leaving vision off.
            start(activity)
        }
    }

    fun onHostPause() {
        if (!resumed) return
        runCatching { session?.pause() }
        surface?.onPause()
        resumed = false
        wasTracking = false
        emitStatus(VisualTrackingStatus(available = session != null, detail = "视觉采集已暂停"))
    }

    fun stop() {
        onHostPause()
        runCatching { session?.close() }
        session = null
        wasTracking = false
        hostActivity = null
        textureConfigured = false
        initialTranslation = null
        lastEmittedTimestampNs = 0L
        emitStatus(VisualTrackingStatus(detail = "视觉采集未启动"))
    }

    private fun resumeSession() {
        if (resumed || session == null) return
        try {
            surface?.onResume()
            session?.resume()
            resumed = true
            emitStatus(VisualTrackingStatus(available = true, active = true, trackingState = "paused", detail = "等待视觉特征"))
        } catch (error: CameraNotAvailableException) {
            emitStatus(VisualTrackingStatus(available = true, detail = "相机不可用：${error.javaClass.simpleName}"))
        } catch (error: Exception) {
            emitStatus(VisualTrackingStatus(available = true, detail = "视觉会话恢复失败：${error.javaClass.simpleName}"))
        }
    }

    private fun emitStatus(status: VisualTrackingStatus) {
        val key = listOf(status.available, status.active, status.trackingState, status.failureReason, status.detail).joinToString("|")
        if (key == lastStatusKey) return
        lastStatusKey = key
        mainHandler.post { onStatus(status) }
    }

    private inner class Renderer : GLSurfaceView.Renderer {
        private val textureId = IntArray(1)

        override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
            GLES20.glGenTextures(1, textureId, 0)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, textureId[0])
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            textureConfigured = false
        }

        override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) = Unit

        override fun onDrawFrame(gl: GL10?) {
            val arSession = session ?: return
            if (!resumed) return
            try {
                if (!textureConfigured) {
                    arSession.setCameraTextureName(textureId[0])
                    textureConfigured = true
                }
                val frame = arSession.update()
                val camera = frame.camera
                val trackingState = camera.trackingState
                val failureReason = if (trackingState == TrackingState.PAUSED) camera.trackingFailureReason.name else null
                emitStatus(
                    VisualTrackingStatus(
                        available = true,
                        active = true,
                        trackingState = trackingState.name.lowercase(),
                        failureReason = failureReason,
                        detail = if (trackingState == TrackingState.TRACKING) "视觉位姿正常" else "等待视觉特征",
                    ),
                )
                if (trackingState != TrackingState.TRACKING || frame.timestamp <= 0L) {
                    wasTracking = false
                    lastEmittedTimestampNs = 0L
                    return
                }

                val translation = camera.pose.translation
                val trackingReset = !wasTracking
                wasTracking = true
                if (trackingReset) initialTranslation = translation.copyOf()
                val origin = initialTranslation ?: translation.copyOf().also { initialTranslation = it }
                val deltaX = translation[0] - origin[0]
                val deltaY = translation[1] - origin[1]
                val deltaZ = translation[2] - origin[2]
                if (!trackingReset && frame.timestamp - lastEmittedTimestampNs < 100_000_000L) return
                lastEmittedTimestampNs = frame.timestamp

                // ARCore: +X right, +Y up, -Z forward. Convert to a stable
                // local display frame: X right, Y forward, Z up.
                val sample = VisualPoseSample(
                    deviceTimestampNs = frame.timestamp,
                    xM = deltaX,
                    yM = -deltaZ,
                    zM = deltaY,
                    accuracyM = 0.15f,
                    confidence = 0.9f,
                    trackingState = trackingState.name.lowercase(),
                    trackingReset = trackingReset,
                )
                mainHandler.post { onPose(sample) }
            } catch (_: com.google.ar.core.exceptions.NotYetAvailableException) {
                // The camera frame is not ready yet; the next render tick will retry.
            } catch (error: Exception) {
                emitStatus(VisualTrackingStatus(available = true, active = true, detail = "视觉帧读取失败：${error.javaClass.simpleName}"))
            }
        }
    }
}
