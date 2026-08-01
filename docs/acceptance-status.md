# 验收状态与证据边界

这份状态表区分“代码和协议已验证”“本地集成已验证”“公网已验证”和“实体手机已验证”。后两者不能由单元测试或合成样本替代。

| 能力 | 当前证据 | 状态 |
| --- | --- | --- |
| IMU、GNSS、气压与可选 ARCore 融合 | Android 单元测试、编译、回放契约 | 已实现，实体手机未验收 |
| 3D `xM/yM/zM` 路径与旋转抑制 | `smoke:acceptance-cases` 的 `3d`、`rotation` 案例 | 本地集成已验证 |
| 回环候选与独立 corrected track | `smoke:closure`、验收 smoke 的 `loop` 案例 | 本地集成已验证 |
| 楼梯/电梯运动分段 | Android 单元测试、验收 smoke 的 `stairs`/`elevator` 案例 | 本地集成已验证 |
| ARCore 丢跟踪与重新锚定 | Android 测试、`replay:smoke`、验收 smoke 的 `visual-recovery` 案例 | 本地集成已验证，真实相机未验收 |
| 有界原始数据回放与断点恢复 | 长会话、replay、生命周期和重连 smoke；恢复样本保留 `way-memory.session-resumed` 诊断 | 本地集成已验证 |
| GPS 主路线数据完整性 | Android GPS-only 过滤、服务端重复校验和路线 smoke | 本地集成已验证 |
| 公网 HTTPS/WSS 与生产存储 | 发布包校验通过；DNS、证书和生产环境仍缺失 | 未完成 |
| 实体 Android 传感器矩阵 | `docs/device-acceptance.md` 的实体手机采集矩阵 | 未完成 |

## 最新证据快照（2026-08-01）

- 当前 `origin/main` 为 `a4dc4e7`；最新运行时代码提交为 `bea992f`，包含 ARCore 首帧重置边界和气压过期状态修复；当前分支后续提交补充了现场 APK provenance 与 ARCore 实体设备预检。
- Android 隔离全量门禁通过：5 项仪器测试、单元测试、Debug/Release 构建。
- 服务端门禁通过：实时 WebSocket、重启持久化、动态传感器清单、鉴权/角色隔离、原始回放、幂等、重连、生命周期、保留策略、闭环、路线交接和 10 个合成场景验收；闭环累计距离和 `process-recovery`/`network-interruption` 报告契约已覆盖。
- 历史模拟器协议链路曾用 Debug APK 实测：17 个可用传感器、17 个模拟 GPS 点、422 个 Pose 点、16,721 个样本，raw replay 上限为 1,024 条；其 APK 来源提交为旧提交 `b7d3864`，只作为历史协议证据，不作为当前代码或实体设备 provenance。模拟器不支持 ARCore，且该证据不计入实体手机传感器验收。
- 最新运行时发布包来源为 `bea992f`，已在腾讯云 `/tmp/way-memory-release-bea992f` 暂存；manifest 和 9 个 payload 哈希已验证。远端 `install-release.sh ... --check-only` 因缺少受保护的 `/etc/way-memory/way-memory.env` 拒绝继续，未执行生产重启。
- 当前可供实体传感器验收的 Debug APK 已由 `9036e52` 构建，API origin 为 `https://way-memory.yxswy.com`，工件目录为 `artifacts/android-release/9036e522f1315e59799855342bcf53e111ee983e-debug`，SHA-256 为 `9a9034914aaa0e99f694e650c40f3c0cdeff3781896ce91228a74a6ee4cd32f7`；`-RequirePhysical` 预检已拒绝当前模拟器，未安装。
- 当前公网预检仍未通过：`way-memory.yxswy.com` 解析到 `198.18.0.248`，不是预期生产主机 `101.35.246.159`；远端服务进程虽为 active，但生产环境文件、Nginx 配置和 ACME 证书均不存在。当前唯一 ADB 设备仍是 API 36 模拟器，没有实体 Android 手机。

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
