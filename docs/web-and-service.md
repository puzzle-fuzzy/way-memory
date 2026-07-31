# way-memory 网页与服务端方案

## 网页工作台

第一版网页不是盲人导航端，而是路线审核和数据工作台：

- 地图显示多次原始轨迹和融合轨迹
- 轨迹对齐和偏差对比
- 节点和人工标注编辑
- 视觉证据查看
- 置信度时间线
- 设备能力和采集状态
- 路线版本发布、归档和回滚

## 服务端职责

- 设备配对与会话鉴权
- 路线、节点、观测和证据 API
- 实时数据接收
- 数据完整性校验
- 轨迹合并任务调度
- 视觉推理适配层
- 导出、删除和审计

服务端不应默认成为高频传感器数据的永久中转站。后续可以根据延迟、网络和隐私需求，将实时数据改为 WebRTC DataChannel 或本地处理后只同步派生结果。

## 第一版 API 方向

- `POST /devices/pair`
- `POST /sessions`
- `POST /observations`
- `POST /observations/:id/samples`
- `GET /routes`
- `POST /routes`
- `POST /routes/:id/nodes`
- `POST /routes/:id/publish`
- `DELETE /routes/:id`
- `WS /realtime`
