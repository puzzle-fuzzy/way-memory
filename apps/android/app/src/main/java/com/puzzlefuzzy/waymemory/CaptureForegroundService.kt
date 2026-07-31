package com.puzzlefuzzy.waymemory

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import com.puzzlefuzzy.waymemory.sensing.SensorCollector

class CaptureForegroundService : Service() {
    private val collector: SensorCollector
        get() = (application as WayMemoryApplication).sensorCollector

    override fun onCreate() {
        super.onCreate()
        val notificationManager = getSystemService(NotificationManager::class.java)
        notificationManager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "way-memory 轨迹采集", NotificationManager.IMPORTANCE_LOW),
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            collector.stop()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!collector.uiState.value.collecting) collector.start()
        // If Android recreates the process/service after a resource pressure
        // kill, redeliver ACTION_START so SensorCollector can resume the
        // persisted session instead of silently losing the capture.
        return START_REDELIVER_INTENT
    }

    override fun onDestroy() {
        // Do not call collector.stop() here. That is an explicit user action
        // and deletes active-session.id after sending session.stop. During a
        // system/process restart the marker and durable sample queue must stay
        // intact so the next service instance can resume the same session.
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification = Notification.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("way-memory 正在采集")
        .setContentText("正在记录 IMU、定位与气压轨迹")
        .setOngoing(true)
        .setCategory(Notification.CATEGORY_SERVICE)
        .build()

    companion object {
        const val ACTION_START = "com.puzzlefuzzy.waymemory.action.START_CAPTURE"
        const val ACTION_STOP = "com.puzzlefuzzy.waymemory.action.STOP_CAPTURE"
        private const val CHANNEL_ID = "way-memory-capture"
        private const val NOTIFICATION_ID = 3412
    }
}
