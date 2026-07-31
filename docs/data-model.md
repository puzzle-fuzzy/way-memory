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

## SensorSample

- `timestampNs`
- `sequence`
- `sensorType`
- `coordinateFrame`
- `values`
- `accuracy`
- `source`

传感器样本必须使用手机单调时钟进行排序，同时保留系统时间用于展示。

## RouteNode

- `nodeId`
- `routeId`
- `position`
- `nodeType`: start / turn / door / stairs / elevator / crossing / landmark / hazard / end
- `instruction`
- `confidence`
- `manualAnnotation`
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
