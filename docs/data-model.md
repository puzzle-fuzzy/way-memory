# way-memory 路线与传感器数据模型

## Route

- `routeId`
- `ownerId`
- `name`
- `version`
- `status`: draft / verified / archived
- `startNodeId`
- `endNodeId`
- `createdAt`
- `updatedAt`
- `referenceSessionId`（第一条真实观测；后续观测在完成坐标对齐前只保存摘要）
- `observationSummaries`（有界的观测质量和来源摘要）
- `track`（最多 500 个参考观测 GNSS 点）
- `poseTrack`（最多 1,200 个参考观测局部 Pose 点）
- `nodeRecords`（最多 128 个带三维坐标的人工节点）

每条 `RouteObservationSummary` 都包含 `alignment`：

- 首次观测使用 `method=reference`，建立路线地理参考；
- 后续观测使用 `method=gnss-nearest`，按时间单调的最近 GNSS 参考点尝试对齐；
- 只有匹配点数至少 2、覆盖率至少 50%、平均残差不超过 25 米时才是 `status=matched`；否则是 `unavailable`，不会修改参考轨迹；
- 参考路线最多保留 500 个融合后的地理点。不同会话的局部 ENU/AR 坐标仍不直接拼接，后续视觉或人工证据需要单独生成坐标变换。

## Observation

一次实际行走记录：

- `observationId`
- `routeId`
- `deviceId`
- `startedAt`
- `endedAt`
- `rawDataRef`
- `derivedTrackRef`
- `qualitySummary`

路线合并不能把不同采集会话的局部 ENU 坐标直接拼接。当前服务端先保存真实观测摘要和第一条参考观测；至少三次观测（含两次重复对齐成功）后，才允许将路线标记为 `verified`。这只是 GNSS 地理层的第一道门禁，视觉回环、楼层语义和人工对齐证据仍需要在导航发布前继续审核。

## SensorSample

- `timestampNs`
- `sequence`
- `sensorType`
- `coordinateFrame`
- `values`
- `accuracy`
- `source`
- `relativePosition`（可选）：传感器融合得到的局部 `xM / yM / zM`，不等同于经纬度

## RelativeMotionPoint

用于 GNSS 不可用或更新稀疏时记录手机相对于采集起点的短时运动：

- `timestampNs`
- `xM / yM / zM`
- `accuracyM`
- `source`: inertial / visual / fused

`RelativeMotionPoint` 只用于实时观测和后续融合，不能直接当作 WGS84 经纬度或最终导航路线。

传感器样本必须使用手机单调时钟进行排序，同时保留系统时间用于展示。

## RouteNode

- `nodeId`
- `routeId`
- `xM / yM / zM`（路线局部三维坐标）
- `lat / lng`（可选的 GNSS 锚点）
- `nodeType`: start / turn / door / stairs / elevator / crossing / landmark / hazard / end
- `instruction`
- `confidence`
- `manualAnnotation`（当前人工节点接口固定为 true）
- `createdAt`
- `visionEvidenceRefs`

## Evidence

视觉识别、传感器融合和人工标注都作为证据保存：

- `evidenceId`
- `kind`
- `modelVersion`
- `capturedAt`
- `confidence`
- `sourceRef`
- `reviewState`

## 隐私要求

原始照片、音频、精确位置和路线数据必须能够按用户、路线和单次记录分别删除。默认不公开，不把人脸或家庭地址写入日志和测试 fixture。
