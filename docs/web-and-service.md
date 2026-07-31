# way-memory 网页与服务端方案

## 网页工作台

Web 使用 Vue 3 + Vite + TypeScript + Tailwind CSS，开发服务器由 Vite 提供 HMR，生产构建输出 `dist/`。Bun 只作为工作区的包管理器和脚本运行工具，不再直接静态托管前端页面。

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

服务端当前通过 WebSocket 接收 Android 样本并广播给网页工作台，以保证局域网测试中的实时性和多端观察能力。后续可以根据延迟、网络和隐私需求评估 WebRTC DataChannel 或本地处理后只同步派生结果。

## 第一版 API 方向

路线注册和观测绑定已进入服务端：`GET /routes`、`POST /routes`、`GET /routes/:id`、`POST /routes/:id/observations`、`DELETE /routes/:id` 均按 owner 隔离并写入 SQLite。每条路线最多保留 50 次观测摘要、500 个地理点和 1,200 个参考 Pose 点；不同会话的局部坐标不会直接首尾拼接。`POST /routes/:id/publish` 在坐标对齐引擎完成前返回 `route_alignment_required`，避免把未对齐数据发布成导航路线。

- `POST /devices/pair`
- `POST /sessions`
- `POST /observations`
- `POST /observations/:id/samples`
- `GET /routes`
- `POST /routes`
- `GET /routes/:id`
- `POST /routes/:id/observations`
- `POST /routes/:id/publish`
- `DELETE /routes/:id`
- `WS /realtime`
