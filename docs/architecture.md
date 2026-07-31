# way-memory 技术架构

## 总体结构

```text
Android App
  ├─ Sensor Registry
  ├─ Location Provider
  ├─ IMU / Attitude Pipeline
  ├─ Camera / AR Pipeline
  ├─ Route Recorder
  ├─ Local Cache
  ├─ Voice / Haptic Interaction
  └─ Realtime Sync

PathSense Service
  ├─ Device Pairing
  ├─ Route API
  ├─ Observation Ingestion
  ├─ Annotation API
  ├─ Route Alignment Worker
  ├─ Vision Inference Adapter
  └─ Export / Deletion

Web Console
  ├─ Route Map
  ├─ 3D Replay
  ├─ Observation Comparison
  ├─ Annotation Editor
  ├─ Confidence Timeline
  └─ Device / Session Status
```

## 设计原则

1. 原始观测和派生轨迹分开保存。
2. 每个定位结果必须携带时间戳、来源和置信度。
3. 传感器不可用时按能力降级，不假设所有手机硬件一致。
4. 实时导航链路与离线训练/路线合并链路分离。
5. 视觉模型是证据来源，不是唯一决策来源。
6. 任何模型输出都要可追溯到原始帧、位置和版本。

## 第一版部署边界

先实现手机到服务端到网页的可观测闭环。算法先保留在明确的模块接口后面，避免在尚未有真实数据前过度设计深度学习系统。
