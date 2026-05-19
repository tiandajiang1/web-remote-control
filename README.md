# Web Remote Control

一个 Windows 网页远程控制原型。页面负责显示屏幕预览，并支持鼠标、键盘、剪贴板、文件下载和 SSH 反向隧道公网访问。

## 功能

- HTTP 截图流远程桌面预览
- 鼠标移动、点击、滚轮控制
- 键盘文本输入和常用快捷键
- 远端剪贴板读取、写入、本地复制粘贴
- 远端文件目录浏览和下载
- 实时显示画面流量、累计传输量、帧率和延迟
- 可选 Web Serial 控制通道
- 可选 SSH 反向隧道暴露到公网

## 启动

```powershell
npm install
npm start
```

默认访问：

```text
http://127.0.0.1:3000
```

建议设置访问 Token：

```powershell
$env:REMOTE_TOKEN="change-this-token"
npm start
```

## 公网隧道

先设置环境变量：

```powershell
$env:REMOTE_TOKEN="change-this-token"
$env:TUNNEL_HOST="your.server.ip"
$env:TUNNEL_USER="ubuntu"
$env:TUNNEL_PASSWORD="your-password"
$env:TUNNEL_REMOTE_HOST="0.0.0.0"
$env:TUNNEL_REMOTE_PORT="3000"
$env:TUNNEL_LOCAL_HOST="127.0.0.1"
$env:TUNNEL_LOCAL_PORT="3000"
```

然后启动：

```powershell
npm run tunnel
```

也可以使用桌面/项目里的 `start-remote-control.ps1`，但请先设置上面的环境变量。不要把真实密码写进脚本或提交到 Git。

## 串口协议

页面通过 Web Serial 发送 UTF-8 JSON Lines，每条命令一行，以 `\n` 结尾。

鼠标：

```json
{"kind":"mouse","type":"move","button":"left","x":600,"y":320}
{"kind":"mouse","type":"down","button":"left","x":600,"y":320}
{"kind":"mouse","type":"up","button":"left","x":600,"y":320}
{"kind":"mouse","type":"click","button":"right","x":600,"y":320}
{"kind":"mouse","type":"wheel","delta":-120,"x":600,"y":320}
```

键盘：

```json
{"kind":"keyboard","action":"text","text":"hello"}
{"kind":"keyboard","action":"key","key":"enter"}
{"kind":"keyboard","action":"key","key":"paste"}
```

剪贴板：

```json
{"kind":"clipboard","action":"read"}
{"kind":"clipboard","action":"write","text":"hello"}
```

## 注意

- Web Serial 需要 Chrome 或 Edge，并且需要用户手动选择串口。
- 串口通道只负责控制指令，屏幕预览仍来自 HTTP 截图接口。
- 这是轻量原型。公网使用时应增加 HTTPS、登录、速率限制和审计。
