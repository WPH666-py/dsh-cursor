# 在 Windows 上用 WSL 跑官方 cursor-agent

Windows 没有原生 `cursor-agent`：`cursor.com/install` 只处理 `linux` / `darwin` 两个分支，
`…/lab/<ver>/{win32,windows}/{x64,arm64}/agent-cli-package.tar.gz` 全部 403。
所以官方 CLI 在 Windows 上唯一可行的形态是 **WSL 里的 Linux 版**。

> 下面每一步都需要管理员权限；`wsl --install` 之后必须**重启**。这些是系统级改动，确认后再执行。

## 1. 装 WSL（管理员 PowerShell）

```powershell
wsl --install -d Ubuntu
wsl --set-default-version 2
```

重启后 Ubuntu 会要求建一个 UNIX 用户，记住密码。验证：

```powershell
wsl -l -v          # 应看到 Ubuntu, VERSION 2, STATE Running
wsl -d Ubuntu -- uname -s -m     # Linux x86_64
```

## 2. 在 WSL 里装 cursor-agent

```bash
wsl -d Ubuntu -- bash -lc 'curl -fsS https://cursor.com/install | bash'
```

脚本做的事（已核对）：

| 项 | 值 |
|---|---|
| 下载 | `https://downloads.cursor.com/lab/2026.11.19-f005e9d/linux/x64/agent-cli-package.tar.gz` |
| 安装目录 | `~/.local/share/cursor-agent/versions/2026.11.19-f005e9d/` |
| 可执行 | `~/.local/bin/cursor-agent`（另有兼容名 `~/.local/bin/agent`） |
| 配置 | `~/.cursor/grok-switch.json` |

## 3. 让 PATH 与非登录 shell 都能找到它

```bash
wsl -d Ubuntu -- bash -lc 'grep -q ".local/bin" ~/.bashrc || echo "export PATH=$HOME/.local/bin:$PATH" >> ~/.bashrc'
wsl -d Ubuntu -- bash -lc 'cursor-agent --version'
```

`bash -lc` 很关键：非登录 shell 不会读 `~/.bashrc`，桥用 `bash -lc` 调用就是为了拿到 PATH。

## 4. 登录（账号与桌面端一致）

```bash
wsl -d Ubuntu -- bash -lc 'cursor-agent login'
```

它会打印一个 URL 让你在浏览器里确认。凭证落在 WSL 的 `~/.cursor/`，与 Windows 侧互不影响。
**不要在 WSL 里复用 Windows 的 `state.vscdb`** —— 那是另一套会话。

## 5. 验证（这个构建**没有 acp 子命令**）

实测 `cursor-agent --help` 的子命令只有：`login` / `about` / `update` / `agent` / `ls` /
`resume` / `create-chat` / `persist` / `generate-rule`。**没有 `acp`**，所以桥要走的不是 ACP，
而是它自带的非交互通道：

```bash
cursor-agent --list-models                  # 该账号可用模型
cursor-agent --print --output-format stream-json --stream-partial-output               --model <id> "say OK"         # NDJSON 事件流
```

这两条才是有授权、可编程的入口。

## 6. Windows 侧怎么调它

桥里已经封装好（`lib/cli/spawn-acp.js`）：

```
wsl.exe -d Ubuntu -- bash -lc "cursor-agent acp"
```

stdio 直通，JSON-RPC 用换行分隔，`AcpClient` 直接吃这两个流。

## 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| `curl` 在 WSL 里超时 | Windows 的 `cursor.com` 需要代理，但 WSL 默认不走 Windows 代理；在 WSL 里 `export https_proxy=http://<Windows宿主IP>:7897`，宿主 IP 用 `ip route show default` 里的网关 |
| `cursor-agent: command not found` | 用了 `bash -c` 而非 `bash -lc`，PATH 里没有 `~/.local/bin` |
| `wsl` 命令不存在 | 还没重启，或没开「虚拟机平台」功能 |
| `WSL_E_DISTRO_NOT_FOUND` | WSL 本体在、发行版没装：`wsl --install -d Ubuntu --no-launch`（实测不需要管理员） |
| WSL 里 `cursor.com` 超时 | NAT 模式看不到 Windows 的 `localhost` 代理；在 `%USERPROFILE%\.wslconfig` 写 `[wsl2]` + `networkingMode=mirrored`，`wsl --shutdown` 后生效 |
| 登录后仍 `Authentication error` | WSL 内网络到不了后端，同上，先解决代理 |

## 冷启动：8.8 秒是 VM 引导，不是 CLI

| 场景 | 实测 |
|---|---|
| `wsl --shutdown` 后第一次调用 | **8792 ms** |
| 同一 VM 内后续调用 | **381 ms** |
| `cursor-agent about`（暖态） | **432 ms** |
| 一轮真实对话（冷） | 17.9 s |
| 一轮真实对话（暖，插件保活） | **10.0 s** |

插件在 `backend: print` 时会拉一个 `wsl -d <distro> -u root -- sleep infinity` 把 VM 顶住，dispose 时杀掉。
剩下的 10 秒里约 9 秒是 CLI 自己的启动 + 鉴权 + 模型往返——**裸跑 CLI 同样是 9.4–13 s**，适配器没有额外开销。
要再快只能走常驻进程（`cursor-agent persist` 是 TUI/attach 形态，不是按轮 RPC），属于另一层协议。

## 把 WSL「内置」进插件，能做到哪一步

| 组成 | 能否随插件分发 | 说明 |
|---|---|---|
| WSL 功能本身（VirtualMachinePlatform + 内核 + `wsl.exe`） | **否** | Windows 可选功能，安装要管理员 + 重启，没有用户态 API |
| 发行版（rootfs） | **可以** | `wsl --import <名字> <目录> <rootfs.tar.gz>`，不经过商店、不要管理员 |
| `cursor-agent` | 可以 | 首次运行下载安装，或随包提供 |
| 登录凭证 | 否 | 必须由用户在浏览器确认一次 |

所以"任何用户都能用"的完整链路是：**启用 WSL（一次性、管理员）→ 有这个功能之后，插件自己 import 发行版、装 CLI、引导登录**。
前一半是 Windows 的硬边界，后一半插件能全做。

自己 import 一个发行版（不依赖商店，路径用正斜杠即可）：

```powershell
curl -fL -o %TEMP%\rootfs.tar.gz https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.1-base-amd64.tar.gz
wsl --import dsh-cursor C:/Users/<you>/.dsh-cursor/wsl %TEMP%\rootfs.tar.gz
wsl -d dsh-cursor -u root -- bash -lc "apt-get update && apt-get install -y curl ca-certificates"
wsl -d dsh-cursor -u root -- bash -lc "curl -fsS https://cursor.com/install | bash"
```

把 `targets.harness.print.distro` 指向 `dsh-cursor` 即可。

## 自检

```powershell
node scripts/probe-bootstrap.mjs
```

四步（WSL / 发行版 / CLI / 登录）逐项给结论，缺哪一步直接给命令；一轮对话完全没输出时，插件的报错里也会带上这份报告。

## 全自动装机（`print.autoProvision`，默认开）

`backend: print` 且配置的发行版不存在时，插件在后台完成：

1. 读 Ubuntu 官方 `SHA256SUMS`，取本平台 rootfs 的期望哈希；
2. 流式下载 rootfs（边下边算 SHA256，不占内存）；
3. 哈希不符 → 只删临时包，不动系统；
4. `wsl --import <distro> <目录> <tar.gz>`；失败 → 连目录一起回滚；
5. `apt-get install curl ca-certificates`；
6. 跑官方安装脚本装 `cursor-agent`。

**实测一次完整装机（本机）**：

```
verified 29983772 bytes
imported dsh-cursor
done in 144578 ms
→ dsh-cursor 发行版可用，cursor-agent 2026.11.19-f005e9d，磁盘占用 908 MB
```

全程异步执行（`wslRunAsync`），import 期间 Host 不阻塞；进度写进日志。
装完还要登录一次：`wsl -d dsh-cursor -u root -- bash -lc 'NO_OPEN_BROWSER=1 cursor-agent login'`。

**撤销**：

```powershell
wsl --unregister dsh-cursor
Remove-Item -Recurse -Force C:/Users/<you>/.dsh-cursor/wsl/dsh-cursor
```

## 失败时自己说清楚

一轮对话完全没有事件时，插件抛出的错误会带上体检报告：

```
cursor-agent produced no events (exit 1): Authentication required. Please run 'agent login' first…
 | cursor CLI not ready (login: not signed in) — fix: wsl -d dsh-cursor -u root -- bash -lc 'NO_OPEN_BROWSER=1 cursor-agent login'
```
