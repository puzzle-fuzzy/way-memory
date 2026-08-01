# 验收状态与证据边界

这份状态表区分“代码和协议已验证”“本地集成已验证”“公网已验证”和“实体手机已验证”。后两者不能由单元测试或合成样本替代。

| 能力 | 当前证据 | 状态 |
| --- | --- | --- |
| IMU、GNSS、气压与可选 ARCore 融合 | Android 单元测试、编译、回放契约 | 已实现，实体手机未验收 |
| 3D `xM/yM/zM` 路径与旋转抑制 | `smoke:acceptance-cases` 的 `3d`、`rotation` 案例 | 本地集成已验证 |
| 回环候选与独立 corrected track | `smoke:closure`、验收 smoke 的 `loop` 案例 | 本地集成已验证 |
| 楼梯/电梯运动分段 | Android 单元测试、验收 smoke 的 `stairs`/`elevator` 案例 | 本地集成已验证 |
| ARCore 丢跟踪与重新锚定 | Android 测试、`replay:smoke`、验收 smoke 的 `visual-recovery` 案例 | 本地集成已验证，真实相机未验收 |
| 有界原始数据回放与断点恢复 | 长会话、replay、生命周期和重连 smoke | 本地集成已验证 |
| GPS 主路线数据完整性 | Android GPS-only 过滤、服务端重复校验和路线 smoke | 本地集成已验证 |
| 公网 HTTPS/WSS 与生产存储 | 发布包校验通过；DNS、证书和生产环境仍缺失 | 未完成 |
| 实体 Android 传感器矩阵 | `docs/device-acceptance.md` 的实体手机采集矩阵 | 未完成 |

## 最新证据快照（2026-08-01）

- 当前源码：`05ddfb7`（`main` 已推送到 `origin/main`）。
- Android 隔离全量门禁通过：5 项仪器测试、单元测试、Debug/Release 构建。
- 服务端门禁通过：实时 WebSocket、重启持久化、动态传感器清单、鉴权/角色隔离、原始回放、幂等、重连、生命周期、保留策略、闭环、路线交接和 8 个合成场景验收。
- 与该源码绑定的 Debug APK SHA-256：`1c1a09081b20d57e2424ea7a708784eeb5cf71f69755e30f44bf3c888b439938`；它已在 `emulator-5554` 安装启动，但模拟器证据仅覆盖协议和生命周期，不计入真实传感器验收。
- 公网预检仍未通过：`way-memory.yxswy.com` 没有有效 A 记录，HTTP 入口返回 `502`；腾讯云临时发布包的 `--check-only` 也因缺少受保护的 `/etc/way-memory/way-memory.env` 而拒绝继续。未执行生产重启。

## 合成验收 smoke 的边界

```powershell
bun run smoke:acceptance-cases
```

该命令为每个验收报告案例创建隔离测试会话，验证服务端接收、原始样本保留、报告判定和坐标/事件字段之间的链路。它使用固定测试样本，只能证明验收工具和服务端契约没有断裂，不能证明手机的 GNSS、ARCore、气压计、旋转、楼梯、电梯或后台行为真实可靠。

## 最终通过条件

最终产品验收还需要：

1. `way-memory.yxswy.com` 解析到生产主机，并通过 HTTPS/WSS 预检；
2. 使用绑定了正确 API origin 和 SHA-256 的 APK；
3. 实体手机完成 `docs/device-acceptance.md` 中的 baseline、3D、rotation、loop、visual-recovery、stairs、elevator、recovery、network interruption 和 process recovery；
4. 每个案例保存 acceptance report、bounded raw replay、APK/source provenance 和网页截图；
5. 对不确定性、丢失传感器、视觉丢跟踪和错误定位执行安全降级，而不是继续输出强导航指令。
