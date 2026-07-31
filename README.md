# way-memory

way-memory 是一个面向盲人用户的个性化路线学习与辅助导航项目。

项目目标不是简单回放一条 GPS 线，而是使用手机可用的传感器、摄像头、人工标注和视觉理解，逐步建立用户自己的路线记忆：

- 记录多次真实行走轨迹
- 融合 GNSS、IMU、气压和视觉惯性定位
- 通过人工标注确认转弯、门、楼梯、电梯和风险点
- 使用自然环境特征作为无标记地标
- 在网页上回放和编辑路线
- 在手机上提供语音、震动和置信度驱动的导航提示
- 定位不确定时安全降级，不输出误导性指令

当前范围：Android 手机、Web 网页、服务端。iOS 暂不纳入第一阶段。

## 当前阶段

本仓库目前处于前期准备阶段，先建立产品边界、技术架构、数据模型、验证指标和开发约束，再进入实现。

## 文档

- [产品定义](docs/product-definition.md)
- [技术架构](docs/architecture.md)
- [路线与传感器数据模型](docs/data-model.md)
- [Android 采集方案](docs/android-sensing.md)
- [视觉与定位方案](docs/localization-and-vision.md)
- [网页与服务端方案](docs/web-and-service.md)
- [隐私与安全](docs/privacy-and-safety.md)
- [开发路线与验收指标](docs/roadmap.md)

## 预期技术栈

- Android：Kotlin、Android Sensor Framework、Fused Location、CameraX、ARCore（按设备能力启用）
- Web：Vue 3、Vite、TypeScript、Tailwind CSS，后续按地图需要接入 MapLibre/Three.js
- Service：Bun、TypeScript、Elysia 或轻量 HTTP/WebSocket 服务
- 实时传输：WebSocket 起步，后续评估 WebRTC DataChannel
- 存储：先使用可迁移的数据访问层，避免早期锁定具体数据库

## 重要边界

PathSense 是辅助导航系统，不替代盲杖、导盲犬、陪同人员或其他安全措施。系统必须公开定位置信度，并在无法可靠定位时暂停复杂指令。
