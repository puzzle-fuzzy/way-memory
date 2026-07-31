package com.puzzlefuzzy.waymemory

import android.app.Application
import com.puzzlefuzzy.waymemory.sensing.SensorCollector

class WayMemoryApplication : Application() {
    val sensorCollector: SensorCollector by lazy { SensorCollector(this) }
}
