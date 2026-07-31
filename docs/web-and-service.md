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

会话历史列表只返回压缩摘要，不把每个会话的 Pose/原始回放窗口一次性发送到浏览器；进入具体会话时再请求完整快照，健康检查可使用 `GET /api/sessions/:id?view=integrity`。这样不会因为多次采集累积而让网页首屏或公网代理传输线性膨胀。

## 第一版 API 方向

路线注册和观测绑定已进入服务端：`GET /routes`、`POST /routes`、`GET /routes/:id`、`POST /routes/:id/observations`、`DELETE /routes/:id` 均按 owner 隔离并写入 SQLite。每条路线最多保留 50 次观测摘要、500 个地理点、1,200 个参考 Pose 点和 128 个人工节点。首条观测建立参考轨迹，后续观测按 GNSS 最近点做有界对齐：匹配至少 2 点、覆盖率至少 50%、平均残差不超过 25 米才计为 `matched`；局部 ENU/AR 坐标不会跨会话直接首尾拼接。`POST /routes/:id/publish` 只有在至少 3 次观测且两次重复对齐均成功时才会返回 `verified`，否则返回 `route_alignment_required`。

- `POST /devices/pair`
- `POST /sessions`
- `POST /observations`
- `POST /observations/:id/samples`
- `GET /routes`
- `POST /routes`
- `GET /routes/:id`
- `POST /routes/:id/observations`
- `POST /routes/:id/nodes`（人工节点，最多 128 个）
- `POST /routes/:id/publish`
- `DELETE /routes/:id`
- `WS /realtime`
