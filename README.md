# dsh-imessage — iMessage 插件

把 iMessage 收发完整接入 DeepSeek Harness（dsh）：**RPC 监听入站 → 按 handle 路由工作区 → agent 处理 → 自动回复**。作为 web profile 的 host 插件随 `dsh web` 启停，零 dsh 框架改动。

## 架构

```
dsh web 进程（LaunchDaemon，KeepAlive）
└── dsh-imessage 插件
    ├── GatewayCore（lib/gateway-core.mjs）—— 消息接收核心
    │   ├── spawn imsg rpc --db chat.db --json   ← 入站监听
    │   ├── watch.subscribe 订阅 → 收到外部消息（过滤 is_from_me）
    │   ├── 按 sender handle 查路由表 → 定位工作区
    │   ├── 停止指令拦截（busy 时整条精确命中 → cancel + 清排队）
    │   ├── agents.create/resume + followup 投递 → 取回复
    │   └── RPC send 回发  → 自动回复
    ├── Typert remote "imessageGateway"（getConfig/setConfig）→ 配置页
    └── 全局 message 工具（任何 agent 可主动发 iMessage）
```

- **入站**：`imsg rpc` 订阅全部会话，流式推送新消息
- **路由**：`settings.yaml` 的 `imessage:` 段 → `routes`（handle → 工作区路径）
- **固定会话**：同一 sender 固定同一 session（id 按 handle 哈希稳定）；live 复用 / resume / create
- **停止指令**：agent 忙碌时整条消息精确命中停止词（多语言词表，含 `/stop`）→ 立即中断当前轮并作废排队消息，无需 web 停止按钮（详见下文「停止指令」节）
- **归档迁移**：原会话被 UI 归档后不再 resume，自动新建会话并持久化映射（`~/.dsh/imessage-gateway-state.json`），新消息延续新会话
- **已读回执**：收到外部消息后立即发 read（`imsg status --json` 探测 `read_receipts`，支持才启用）
- **typing（keepalive 机制，与 OpenClaw 一致）**：收到消息即发 `typing: true`，此后每 3s 续发一次刷新 iOS 显示；deliver 完成（或同 sender 并发全部结束）时清除定时器并发一次 `typing: false`。经 `_typingChain` 串行保证 on/off 顺序；不再按 `step/start|step/end` 事件开关
- **出站**：RPC `send`；网关以 root 运行时经 `sudo -u <user>` 降级执行
- **共存**：与 OpenClaw 各自多读 chat.db，互不互斥（同一消息两边都可能回复）

## 目录

```
dsh-imessage/
├── index.js              # host 插件：Typert remote + GatewayCore 装配 + message 工具
├── client.js             # 浏览器 bundle：Settings → iMessage 网关 配置页
├── lib/gateway-core.mjs  # 消息接收核心（监听/路由/投递/出站/归档迁移）
├── cordis.patch.yml      # bundle patch（插入 host 插件行）
├── package.json
└── README.md
```

挂载：web profile（`~/.dsh/profiles/web/`）`package.json` → `dependencies["dsh-imessage"] = "link:<project>/dsh-imessage"`，bundles 列表含 `dsh-imessage`。

## 配置

`$DSH_HOME/settings.yaml` 的 `imessage:` 段（可在 web UI Settings → iMessage 网关 编辑）：

```yaml
imessage:
  routes:
    "+8613800000000": "/Users/<you>/dsh/mayacode"   # handle → 工作区
  imsgCmd: "sudo -u <you> imsg"   # 网关以 root 运行需降级；不配置则直接执行 imsg
  autoReply: true                  # 收到外部消息是否自动回复
  autoLaunch: true                 # imsg 自动注入：开启 = 启动时 + 定时检查注入状态，异常自动 imsg launch 恢复；关闭 = 不检查不注入
  healthIntervalMin: 5             # 注入检查间隔（分钟，1-60，仅 autoLaunch 开启时生效）
  # stopKeywords:                  # 可选：覆盖默认停止词表（不配 = 内置多语言表，见下节）
  #   - "停止"
  #   - "stop"
```

运行时状态（勿手改）：`~/.dsh/imessage-gateway-state.json`（sender → 当前会话 id）。

### 运行环境配置（环境变量）

所有个人路径均通过环境变量覆盖，代码不写死：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `IMSG_CHAT_DB` | `~/Library/Messages/chat.db` | chat.db 路径。网关以 root 运行时 `homedir()` 指向 `/var/root`，必须用此变量指向实际用户的 chat.db |
| `IMSG_CMD` | `imsg` | imsg 执行命令；root 运行需降级时配置 `sudo -u <your-user> imsg`（或直接在 settings.yaml 的 `imsgCmd` 配） |
| `IMSG_DEFAULT_WORKSPACE` | `~/dsh/default` | 路由表未命中时的默认工作区路径 |

## 启动 & 测试

网关随 dsh web 自动启停，无需手工启动。

```sh
sudo launchctl kickstart -k system/com.dsh.web   # 重启生效
ps aux | grep "imsg rpc"                          # 验证监听进程
# 端到端：从手机发一条 iMessage → 网关自动路由 + 回复
# 观察网关会话：ls ~/.dsh/sessions/*/ | grep gateway-
# 日志：/var/log/dsh-web.log（[im] 前缀）
```

## 注入自动恢复（autoLaunch）

Messages.app 的注入（`DYLD_INSERT_LIBRARIES`）可能因进程被杀/崩溃而丢失，导致 RPC 监听失效。`autoLaunch: true`（默认）时网关自动保障注入：

- **探针**：`imsg status --json` 的 `bridge_version >= 2` 判定注入正常（`advanced_features` / `message` 字段在未注入时仍返回 true，**不可靠**）
- **检查时机**：启动时 + 每 `healthIntervalMin` 分钟（1-60，默认 5）
- **自动恢复**：检测异常时执行 `launchctl asuser <uid> /usr/bin/sudo -u <you> /usr/local/bin/imsg launch`，最多重试 3 次（首次常超时，重试即成功）；恢复后自动重启 RPC 监听衔接新注入
- **日志**：注入正常时静默；异常时输出「注入检测异常，尝试自动恢复」→「注入已自动恢复」
- **关闭**：`autoLaunch: false` 后不检查也不自动注入（适合手动管理注入的场景）

> 实现要点（踩坑记录）：launch 必须在目标用户的 **GUI 会话上下文**执行（root 直接 `sudo -u` 会因无 GUI 上下文而超时失败），故用 `launchctl asuser <uid>`；且 launchd 服务 PATH 极简（无 `/usr/local/bin`），spawn 必须用**绝对路径**（否则 `posix_spawn ENOENT`）。

## 停止指令（消息通道中断）

agent 处理中（busy）时，向 iMessage 发送整条精确匹配停止词的消息即可中断当前轮，无需 web 停止按钮。语义参考 OpenClaw 的 `/stop`（`abort-primitives.ts`：整条精确匹配 + 仅 busy 时拦截 + 连排队消息一起丢弃）。

- **触发条件**：当前会话 agent `status === "running"` 且消息整条命中停止词表。**仅忙碌时拦截**；空闲时"停止"当普通消息投递（与 OpenClaw 一致）
- **匹配规则**：整条消息规范化（小写 / 去空白 / 去尾部标点）后**精确匹配**——`"停止。"`、`"STOP!"` 都触发；`"这个功能怎么停止"` 这类含关键词的普通句子**不触发**（防误伤）
- **行为**：`agent.cancel()` 中断当前轮 + 递增该 sender 的 deliver 代次、作废已在串行链上排队的旧消息（停止前发的其它消息不再投递）+ 回复 `⏹ 已停止`
- **默认词表**（`DEFAULT_STOP_KEYWORDS`，参考 OpenClaw 多语言 ABORT_TRIGGERS）：
  - 中文：`停止` `停下来` `暂停` `停一下` `别做了` `算了` `取消`
  - 英文：`stop` `/stop` `esc` `abort` `wait` `exit` `interrupt` `halt` `stopp` `pare`
  - 日文：`やめて` `止めて`；俄文：`стоп` `остановись` `останови` `остановить` `прекрати`
  - 西/法/德：`detente` `deten` `detén` `arrete` `arrête` `anhalten` `aufhören` `hoer auf`
  - 印地：`रुको`；阿拉伯：`توقف`
- **自定义**：`imessage.stopKeywords`（字符串数组）配置后**整体覆盖**默认表（settings.yaml 手改；配置页暂未加 UI，热更新即生效）

## 安全红线

- `autoReply` 默认 true；关闭后只监听不回复，避免误发
- 网关以 root 运行，iMessage 写操作经 sudo 降级到实际用户（`imsgCmd` 可改）
- 网关不碰其他工作区/session 私密上下文；回复内容只来自路由到的那个工作区

## 开发要点（web 进程 create agent 须知）

- web 进程 `agents.create` 必须用 agent-presets 组合 setup（`presets.mount` + 模型选择），否则 create 挂起
- **agents.create/resume 双版本兼容**（dsh 0.1.5 起需 `ownerCtx` 第一参，0.1.2 为单参 options）：按函数形参个数探测（`create.length >= 2`）包装，同一 bundle 双版本通用（2026-09-10 适配）
- create/resume 判断：先查 `sessionPersistence.list()` 是否有该 id，有则 `resume`，无则 `create`——避免 create 同 id 造成 id collision
- 改代码后重启 web 生效（web profile 的 HMR 已禁用）
- **投递串行链**：同一 sender 的 deliver 串行执行（防并发覆盖 `_streamSeenSeq` 导致历史全量重发，一次 379 条事故的根因）。停止指令必须在**入链之前**拦截——串行链会让"停止"排队等前一条 deliver 完成，等轮到它时 agent 已 idle、拦截失效；排队消息用 deliver 代次（`_deliverGeneration`）作废，停止后旧代次消息直接丢弃
- **新插件项目必须建依赖软链**（否则 import `@deepseek-ai/*` 报 ERR_MODULE_NOT_FOUND）：
  ```sh
  mkdir -p node_modules && ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai node_modules/@deepseek-ai
  ```
