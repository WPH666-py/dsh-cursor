# dsh-cursor

把本机 Cursor 账号里**所有可用模型**导入模型列表，并按 Claude Code、Codex、Harness 各自的原生机制落地。
**本机没装 Cursor 时什么都不做**：不注册 provider，不写任何配置文件，不落任何产物。

```
detect ──► collect ──► normalize ──► publish ──► harness / claude-code / codex
(没装就停)   (三级回退)   (统一模型)     (产物+合并)
```

## 1. 模型从哪来

Cursor 的模型列表是**账号级**的，不在安装目录里，所以按三级回退取，前一级失败才降级：

| 级别 | 来源 | 说明 |
|---|---|---|
| 1 | `POST https://api2.cursor.sh/aiserver.v1.AiService/GetUsableModels` + `/AvailableModels` | 用 Cursor 自己存在 `state.vscdb` 里的 bearer token 走 Connect-JSON，`GetUsableModels` 给出该账号**真正可调用的 id**（本机实测 280 条），`AvailableModels` 补充展示名、是否支持图片、上下文窗口等能力位 |
| 2 | `<导出目录>/.cache.json` | 上一次成功导入的结果，断网/掉登录时兜底 |
| 3 | `state.vscdb` 里的 `persistentStorage.applicationUser` → `availableDefaultModels2` | Cursor 自己缓存的 UI 目录（通常是旧子集，仅用于救急） |

token 只在本进程内存里用于构造请求头：不写文件、不进日志、不进产物。

读 `state.vscdb` 前会先把 `state.vscdb` / `-wal` / `-shm` 复制到临时目录再以只读方式打开，正在运行的 Cursor 不会感知到锁；
`node:sqlite` 不可用时降级为按 key 定位的字节扫描（token、邮箱、后端地址这类短值仍然可读）。

## 2. 三个客户端怎么"适配"

三家的"模型列表"机制并不一样，插件按各自的原生方式落地，而不是硬塞同一个 JSON：

**Harness（本进程，实时）**
`ctx.llm.registerAdapter(['cursor'], adapter)` 注册一条 `cursor` 路由，`listModels()` 返回导入的全量模型，
所以它们直接出现在模型选择器里；`resolveModel()` 带上 `inputModalities` 与从 tooltip 解析出的 `context.contextWindow`。
模型源变化时用 `handle.replace(['cursor'])` 触发 `llm/adapters-updated`，选择器无需重启即刷新。

**Claude Code（`~/.claude/settings.json` 的 `env`）**
Claude Code 没有"任意模型列表"，它能重定向的是三个具名槽位，因此插件写入
`ANTHROPIC_DEFAULT_OPUS_MODEL` / `SONNET` / `HAIKU_MODEL`，并附 `ANTHROPIC_BASE_URL`。
槽位默认按"同名家族里非 fast 的最高档"挑选（Cursor 只暴露 `claude-opus-5-5-max` 这类带档位后缀的 id，没有裸 id），可用 `targets.claudeCode.slots` 显式覆盖。

**Codex（`~/.codex/config.toml`）**
写一个 `[model_providers.cursor]`（`base_url` / `wire_api` / `env_key`），再为每个导入模型生成一个 `[profiles.cursor-<slug>]`，
`codex --profile cursor-claude-opus-5-5-max` 即可选中。

两个文件都只在**该客户端存在 + `apply: true` + 配了 `bridge.baseURL`** 时才合并：
一个客户端根本连不到的模型列表比没有列表更糟。合并是幂等的，写在托管块 / 托管键里，
首次合并前留 `<文件>.dsh-cursor.bak`；Cursor 被卸载或插件被禁用时，托管内容会被精确撤掉。

> **关于推理**：Cursor 没有公开的第三方推理 API（`/v1/chat/completions` 是 404，只有 gRPC-connect 的
> `ChatService`）。所以 Harness 侧默认是**目录路由**：模型能列出、能被选中，真正发请求时要求你把
> `targets.harness.delegate.provider` 指向一个能服务这些 id 的已注册路由（例如用 `llm-pi-ai`
> 声明的 Cursor 桥接网关）。没配时抛 `CURSOR_NO_DELEGATE` 并直接说明该改哪个字段，不会假装成功。

## 3. 产物

`~/.dsh-cursor/`（可用 `exportDir` 改）：

| 文件 | 内容 |
|---|---|
| `cursor-models.json` | 规范清单：来源、账号邮箱/会员类型、Cursor 版本、每个模型的 id/名称/描述/输入模态/上下文窗口 |
| `claude-code.json` | 可直接并入 `settings.json` 的 `env` 块 + 三个槽位 + 全量 id |
| `codex.toml` | `model_providers` + 每模型一个 profile |
| `.cache.json` | 上一次成功导入的模型列表（无 token、无邮箱） |

## 4. 配置

全部可选，写在 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-cursor
  name: dsh-cursor
  config:
    provider: cursor          # Harness 里的路由名
    displayName: Cursor
    include: all              # all=全部可用 id；base=只留不带档位后缀的基础 id
    filter: ''                # 对 id / 名称生效的正则，非法正则自动忽略
    refreshSeconds: 900       # 刷新周期（60..86400）
    liveCatalog: true         # 关掉就只用缓存/本地目录
    offlineFallback: true
    requestTimeoutMs: 10000
    exportDir: ~/.dsh-cursor
    bridge:                   # 三个客户端共用的转发端点
      baseURL: ''             # 例如 http://127.0.0.1:8787/v1
      apiKeyEnv: CURSOR_BRIDGE_API_KEY
      wireApi: chat           # chat | responses
    targets:
      harness:
        enabled: true
        delegate:
          provider: ''        # 能真正服务这些 id 的已注册路由
          modelMap: { }        # cursor id -> 上游 id
      claudeCode:
        enabled: true
        apply: false          # true 才合并进 ~/.claude/settings.json
        slots: { opus: '', sonnet: '', haiku: '' }
      codex:
        enabled: true
        apply: false          # true 才合并进 ~/.codex/config.toml
        providerId: cursor
        maxProfiles: 60
```

## 5. 安装与验证

装好 HarGlobal 的人可以直接装这个插件，**不需要本机有 git**——把下面的地址粘到
HarGlobal 侧栏 **Plugins → 安装插件**：

| 来源 | 安装地址 |
|---|---|
| **Gitee（推荐，国内快）** | `https://gitee.com/ph-wang_admin/dsh-cursor/raw/main/dist/dsh-cursor-0.1.1.tgz` |
| GitHub（备用） | `https://github.com/WPH666-py/dsh-cursor/raw/main/dist/dsh-cursor-0.1.1.tgz` |

本机装了 git 的话，也可以按 git 地址安装（跟随仓库更新）：

```
https://gitee.com/ph-wang_admin/dsh-cursor.git
```

装完要**重启 HarGlobal**：`dsh-cursor` 是新的 Host bundle，不走 HMR，重启后模型选择器里才会出现 `Cursor` 分组。

> ⚠️ **不要用本地目录安装**（把 `install_bundle` 的 target 指到 `D:/projects-py/dsh-cursor` 这种本地路径）。
> pnpm 会把那条依赖记成 `link:`，指向 profile 之外的真实目录；而打包版 HarGlobal 启动器要求 profile 自包含，
> 下次启动会直接失败：
> `dsh desktop: profile bundle "dsh-cursor" resolved outside the desktop profile`，
> 而且这个失败发生在启动阶段，界面上没有能救回来的入口。改代码要调试时，重新 `pnpm pack` 再用上面的
> tarball 地址重装。

验证清单：

1. 重启后模型选择器出现 `Cursor` 分组，条目数 = `~/.dsh-cursor/cursor-models.json` 的 `imported`（本机 280）；
2. `~/.dsh-cursor/` 下四个文件齐全（`cursor-models.json` / `claude-code.json` / `codex.toml` / `.cache.json`）；
3. 想验证"没装就跳过"：把 `state.vscdb` 与 Cursor 目录临时改名再重启，日志只应出现一句
   `Cursor is not installed on this machine; nothing imported`，且托管块被撤掉。

不联网的单测与本地演练：

```bash
cd D:\projects-py\dsh-cursor
node --test                      # 18 项：检测 / 合并 / 槽位 / TOML / 字节扫描
node scripts/verify-clients.mjs  # 演练 apply + 回滚（临时目录，不动真实配置）
node scripts/smoke.mjs           # 需要本机装了 Cursor：跑一次真实导入并打印前几条
```

### 发版（维护者）

```bash
# 改完代码先把 package.json 的 version 推进，再重新打包并提交 dist/
pnpm pack --pack-destination dist
git add -A && git commit -m "release: dsh-cursor <version>"
git push gitee main && git push github main
```

`dist/` 里那份 tarball 就是别人安装时抓的东西，所以**每次改代码都要重新 pack、并把上面的版本号一起改掉**，
否则安装地址还指向旧包。
### 装的时候踩到的两个 profile 环境问题

本机 profile 原本处于"任何插件都装不进去"的状态，与本插件无关，处理如下（都可一键还原）：

| 现象 | 处理 |
|---|---|
| `ERR_PNPM_UNEXPECTED_STORE`：`node_modules` 由 `HarGlobal\data\desktop\pnpm\store\v11` 装入，而 pnpm 11 默认找 `%LOCALAPPDATA%\pnpm\store\v11` | 在 profile 的 `pnpm-workspace.yaml` 追加 `storeDir: '<HarGlobal store>'`；删掉这一行即还原 |
| `ERR_PNPM_IGNORED_BUILDS`：`allowBuilds` 里 `dsh-free-vision` / `sharp` 还留着 `set this to true or false` 占位，配合 `strictDepBuilds: true` 直接拒绝安装 | 把这两个键改成 `false`（**不执行**任何构建脚本，两者已有的预编译产物不受影响） |

## 6. 已知边界

- **Cursor 升级可能改接口**：`aiserver.v1` 是 Cursor 内部协议，`GetUsableModels` 一旦变更，插件会降级到缓存/本地目录并在日志里说明，不会静默给空列表。
- **WAL 快照**：复制期间 Cursor 正在写，极端情况下可能读到上一版目录；下一次刷新会自愈。
- **Codex profile 数量**：280 条 id 全量生成会很长，默认截断到 60 条（`targets.codex.maxProfiles`）。
- **`include: base`**：Cursor 的 Anthropic 系列没有裸 id，切成 `base` 后这些系列会从列表里消失，槽位也会空——需要它们就保持 `all`。
- **`bridge.baseURL` 默认值是占位符** `http://127.0.0.1:8787/v1`：产物因此始终是合法 TOML/JSON，但只有你显式配了 `bridge.baseURL`，`apply` 才会真的去改 Claude Code / Codex 的配置文件。
