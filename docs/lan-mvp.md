# 局域网 MVP 使用说明

## 通信方案

当前 MVP 使用一台电脑作为局域网服务端：

```text
Android 手机 ── WebSocket ──> Bun API ── WebSocket 广播 ──> 电脑网页
                               └─ REST API：路线、会话查询和故障恢复
```

WebSocket 负责实时状态和传感器样本，REST 负责查询和后续持久化。当前不使用 WebRTC，因为服务端需要同时记录数据并把同一会话广播给网页；WebRTC 将作为未来无服务端中转或跨网络传输的候选方案。

## 启动电脑端

在项目根目录执行：

```powershell
cd E:\__Super_Core__\way-memory
bun run dev:api
bun run dev:web
```

电脑端服务：

- API/WebSocket：`http://电脑局域网IP:8787`
- 网页：`http://电脑局域网IP:3412`

Windows 防火墙需要允许 Bun 在专用网络监听 TCP 8787 和 3412。手机和电脑必须连接到同一个局域网，且网络隔离功能不能阻止设备互访。

## 配置 Android 手机

编辑 Android Studio 生成的本地文件：

```text
E:\__Super_Core__\way-memory\apps\android\local.properties
```

追加电脑局域网地址，例如：

```properties
wayMemoryApiUrl=http://192.168.1.20:8787
```

不要把真实局域网地址提交到 Git。该文件已经被 Android 工程的 `.gitignore` 忽略。

如果使用 Android Emulator，默认地址 `http://10.0.2.2:8787` 可以访问宿主机；实体手机必须改成电脑的局域网 IPv4 地址。

## 运行顺序

1. 电脑启动 API。
2. 电脑启动 Web。
3. 手机重新 Sync/Build 安装 App。
4. 电脑浏览器打开 `http://电脑局域网IP:3412`。
5. 手机点击“开始采集”并授予位置权限。
6. 网页“实时观察会话”区域应显示 Android 会话和样本数量。

## 当前安全边界

局域网 MVP 使用明文 `ws://`，没有用户鉴权，也没有数据库持久化。它只适合可信的本地测试网络；进入公网或保存真实用户轨迹前必须加入 TLS、设备配对、访问令牌、数据加密和审计。
