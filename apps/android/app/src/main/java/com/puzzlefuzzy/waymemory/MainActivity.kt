package com.puzzlefuzzy.waymemory

import android.Manifest
import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModelProvider
import com.puzzlefuzzy.waymemory.sensing.SensorCollector
import com.puzzlefuzzy.waymemory.sensing.SensorState
import com.puzzlefuzzy.waymemory.ui.theme.WayMemoryTheme

class MainActivity : ComponentActivity() {
    private val collectorViewModel: SensorCollectorViewModel by lazy {
        ViewModelProvider(this)[SensorCollectorViewModel::class.java]
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { WayMemoryTheme { SensorScreen(collectorViewModel.collector) } }
    }
}

private class SensorCollectorViewModel(application: Application) : AndroidViewModel(application) {
    val collector = SensorCollector(application)

    override fun onCleared() {
        collector.stop()
        super.onCleared()
    }
}

@Composable
private fun SensorScreen(collector: SensorCollector) {
    val state by collector.uiState.collectAsState()
    val sync by collector.syncState.collectAsState()
    var permissionRequested by remember { mutableStateOf(false) }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        permissionRequested = true
        collector.start()
    }

    Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
        LazyColumn(
            modifier = Modifier.padding(innerPadding).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            item {
                Spacer(Modifier.height(16.dp))
                Text("way-memory", style = MaterialTheme.typography.headlineMedium)
                Text("手机传感器采集", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                Text(
                    "先建立可靠的原始观测，再进入路线学习。当前会话只在应用前台运行。",
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            item {
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                    Column(Modifier.padding(16.dp)) {
                        Text(
                            if (state.collecting) "采集进行中" else "采集未启动",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            "可用传感器：${state.availableSensorCount} · 样本：${state.sampleCount}",
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Text("位置：${state.locationText}", style = MaterialTheme.typography.bodySmall)
                        Text(
                            "实时同步：${if (sync.connected) "已连接" else "未连接"} · 已上传 ${sync.uploadedSamples} · 待上传 ${sync.pendingSamples}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        sync.lastError?.let { Text("同步错误：$it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                        Spacer(Modifier.height(12.dp))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Button(onClick = {
                                if (state.collecting) {
                                    collector.stop()
                                } else if (collector.hasPreciseLocationPermission()) {
                                    collector.start()
                                } else {
                                    permissionLauncher.launch(
                                        arrayOf(
                                            Manifest.permission.ACCESS_FINE_LOCATION,
                                            Manifest.permission.ACCESS_COARSE_LOCATION,
                                        ),
                                    )
                                }
                            }) { Text(if (state.collecting) "停止采集" else "开始采集") }
                            Spacer(Modifier.width(8.dp))
                            if (permissionRequested && !state.locationPermissionGranted) {
                                TextButton(onClick = {
                                    permissionLauncher.launch(
                                        arrayOf(
                                            Manifest.permission.ACCESS_FINE_LOCATION,
                                            Manifest.permission.ACCESS_COARSE_LOCATION,
                                        ),
                                    )
                                }) { Text("重新授权") }
                            }
                        }
                    }
                }
            }
            state.error?.let { message ->
                item { Text(message, color = MaterialTheme.colorScheme.error) }
            }
            item { Text("传感器状态", style = MaterialTheme.typography.titleLarge) }
            items(state.readings, key = { it.label }) { reading ->
                Card {
                    Row(
                        Modifier.fillMaxWidth().padding(14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(reading.label, style = MaterialTheme.typography.titleMedium)
                            Text(reading.detail, style = MaterialTheme.typography.bodySmall)
                        }
                        Text(
                            text = when (reading.state) {
                                SensorState.READY -> "正常"
                                SensorState.LIMITED -> "等待"
                                SensorState.UNAVAILABLE -> "不可用"
                            },
                            color = when (reading.state) {
                                SensorState.READY -> MaterialTheme.colorScheme.primary
                                SensorState.LIMITED -> MaterialTheme.colorScheme.tertiary
                                SensorState.UNAVAILABLE -> MaterialTheme.colorScheme.outline
                            },
                        )
                    }
                }
            }
        }
    }
}
