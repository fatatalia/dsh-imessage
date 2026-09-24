# dsh-imessage — iMessage 插件

把 iMessage 收发完整接入 DeepSeek Harness（dsh）：**RPC 监听入站 → 按 handle 路由工作区 → agent 处理 → 自动回复**。作为 web profile 的 host 插件随 `dsh web` 启停，零 dsh 框架改动。

## dsh 版本兼容性

**要求 dsh ≥ 0.1.7-rc.1**（已在 0.1.7-rc.1 实测通过）。

- **`ctx.settings.register()` 已移除**（2026-09-24）：原 `imessage` settings namespace 并入插件 `Config`，可热改字段标 `.volatile()`；`inject` 去掉 `settings`。
- **Typert strict codec 必须带 `create()` 工厂**（0.1.7 客户端校验）。
- **`lib/gateway-core.mjs` 两处健壮性修复**（2026-09-24，均导致「发『停止』→ 整个 dsh 重启」）：
  - `task.finally(cb)` 会把 `_deliver` 的 rejection 泄漏成**未处理拒绝**，二次升级为 `dsh: fatal load failure` 让进程退出 → 改用 `then(noop, noop)` 先行吞错，清理逻辑照常；
  - `reason !== undefined` 放行了 `null`，随后 `reason.kind` 抛 `TypeError` → 改为可选链取一次 `reasonKind`，判断与日志插值共用。

## 架构

```
dsh web 进程（LaunchDaemon，KeepAlive）
└── dsh-imessage 插件
    ├── GatewayCore（lib/gateway-core.mjs）—— 消息接收核心
    │   ├── spawn imsg rpc --db chat.db --json   ← 入站监听
    │   ├── watch.subscribe 订阅 → 收到外部消息（过滤 is_from_me）
    │   ├── 按 sender handle 查路由表 → 定位工作区
    │   ├── 停止指令拦截（busy 时整条精确命中 → cancel + 清排队）
    │   ├── 会话重建拦截（整条精确命中 → 备份 + 归档 → 下条消息开新会话）
    │   ├── agents.create/resume + followup 投递 → 取回复
    │   ├── _syncStream 事件消费（200ms 轮询）→ assistant 回复 / 🔧 工具提示 / 压缩进度
    │   └── RPC send 回发  → 自动回复
    ├── Typert remote "imessageGateway"（getConfig/setConfig）→ 配置页
    └── 全局 message 工具（任何 agent 可主动发 iMessage）
```

- **入站**：`imsg rpc` 订阅全部会话，流式推送新消息
- **路由**：`settings.yaml` 的 `imessage:` 段 → `routes`（handle → 工作区路径）
- **固定会话**：同一 sender 固定同一 session（id 按 handle 哈希稳定）；live 复用 / resume / create
- **停止指令**：agent 忙碌时整条消息精确命中停止词（多语言词表，含 `/stop`）→ 立即中断当前轮并作废排队消息，无需 web 停止按钮（详见下文「停止指令」节）
- **会话重建**：整条消息精确命中重建词（多语言词表）→ 备份并归档当前会话、作废排队消息，**下一条消息**开启全新会话（详见下文「会话重建」节）
- **归档迁移**：原会话被 UI 归档后不再 resume，自动新建会话并持久化映射（`~/.dsh/imessage-gateway-state.json`），新消息延续新会话
- **压缩通知**：上下文压缩（自动触发，就发生在对话进行中）时，把「正在压缩」与压缩量／失败原因发到 iMessage（详见下文「上下文压缩通知」节）
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
  # rebuildKeywords:               # 可选：覆盖默认重建词表（不配 = 内置多语言表，见下节）
  #   - "重建会话"
  # rebuildBackup: true            # 重建时先备份会话目录到 ~/.dsh/sessions-backup/（默认开；归档不可逆）
  compactionNotice: true           # 上下文压缩时把过程与结果发到 iMessage（含失败原因；默认开）
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

## 会话重建（备份归档 + 翻新）

会话历史过长、或想彻底甩掉旧上下文时，向 iMessage 发送整条精确匹配重建词的消息即可：**备份并归档当前会话 → 下一条消息自动开启全新会话**。GUI 里点「归档 / 新建」能做同样的事，这个关键词是给消息通道用的。

- **触发**：消息整条命中重建词表。**不要求 agent 忙碌**——任何时刻都能翻新
- **匹配规则**：与停止指令共用 `normalizeKeyword`（小写 / 统一撇号 / 折叠空白 / 去尾部标点）后**精确匹配**——`"重建会话。"`、`"Rebuild Session!"` 都触发；`"我要重建会话"`、`"重建会话吧"` **不触发**（精确匹配的代价：关键词出现在句子里不算）
- **默认词表**（`DEFAULT_REBUILD_KEYWORDS`）：
  - 中文：`重建会话` `重开会话` `重新开会话` `重置会话` `新会话` `新建会话` `换个会话` `换会话` `重来`
  - 英文：`rebuild session` `reset session` `new session` `restart session` `new chat` `reset chat`
- **自定义**：`imessage.rebuildKeywords`（字符串数组）整体覆盖默认表；`imessage.rebuildBackup: false` 关闭备份
- **行为（三步）**：
  1. 中断该 sender 正在跑的轮次（不能一边往旧会话写、一边把它归档）
  2. 备份到 `~/.dsh/sessions-backup/<会话 id>-<时间戳>/`，再归档会话
  3. 清空 sender → 会话映射并落盘；**不预建空会话**，下一条消息交给既有的「归档迁移」逻辑新建（复用 agentOptions / 工作区归属 / 标题，避免两份逻辑分叉）
- **备份**：归档**不可逆**（dsh 无 unarchive 能力），备份是唯一保险；备份失败只告警，不阻塞重建
- **为什么归档两个候选**：`_deliver` 的候选顺序是 `[sessionMap[sender], sessionIdFor(sender)]`（后者是按 handle 哈希的稳定 id）。只归档映射 id 会让投递**回退到稳定 id 会话**，等于没重建
- **为什么在入链之前拦截**：与停止指令同因——串行链会让指令排队等前一条 deliver 跑完（可能几十秒）。命中即递增 `_deliverGeneration` 作废排队消息：那些消息属于即将被归档的会话，投递只会写进一个用户再也看不到的地方
- **与 `/compact` 的区别**：手动 `/compact`（`ctx.compaction.compactNow`）选区间时 `retainTokens` **硬编码 0**，只保留最后一个 surface 节点 ⇒ 被压缩区间几乎覆盖整个会话，成功率**高于**自动压缩（自动路径保留量由 `contextWindow × retainRatio` 决定，区间窄，最容易撞上收益判定）。但会话太短时摘要自身（约 6000 token）仍可能不小于被压缩内容而整次丢弃。重建会话直接换一个干净会话，不受此限

## 上下文压缩通知

上下文被压缩时，网关把过程与结果发到 iMessage。压缩发生在**对话进行中**——自动触发（step 边界越过阈值，或 provider 报上下文超限），用户原本对此完全无感，只会觉得「这轮怎么这么慢」。

- **数据来源**：会话事件 `compaction/start`（在摘要 LLM 调用**之前**落盘，故提示是真·实时，不是事后补充）→ `compaction/summary`（压缩量）→ `compaction/end`（成败；失败带 `error` 字符串）
- **发送**：复用 `_syncStream` 的流式事件消费回路（每 200ms 轮询 + `_streamSeenSeq` 去重），与 `assistant/message`、`tool/call` 提示共用 `_sendChain` 串行链 ⇒ **iMessage 上的顺序与事件 seq 顺序一致**
- **文案**：
  - 开始：`⏳ 上下文压缩中（本轮会稍慢）`
  - 成功：`✅ 上下文已压缩：<N> 项 / 约 <M> tokens`
  - 失败：`⚠️ 上下文压缩失败：<人话原因>（本次未改动上下文）`，例如「摘要不比被压缩的内容小，上下文保持原样（压缩区间太窄，最常见）」
- **开关**：`imessage.compactionNotice`（默认 `true`，配置页可切）。关闭后压缩成败**完全静默**（即此功能之前的行为）
- **只报本通道的会话**：轮询只覆盖 `_activeStreams` 里正在投递的 (agent, sender)，Web GUI / 心跳会话的压缩不会打扰手机
- **为什么不做「发关键词触发压缩」**：手动压缩要求 agent **空闲且无 open turn**（`compactNow` 走 `runMaintenance`，phase 非 idle 直接 `busy`），而自动压缩反过来**必须**在 turn 内（`owner` 非空分支强制 `openTurn !== null`）；两者时点互斥，手动路径只在两轮之间可用，收益远小于自动路径的可观测性
- **`error` 是字符串不是错误码**：`compaction/end` 的 `error` 由 `errorChain(error)` 产出，无结构化 code，只能按子串归类（`COMPACTION_ERROR_HINTS`）；未命中则原样透出并截断 160 字，保底仍可诊断

## 安全红线

- `autoReply` 默认 true；关闭后只监听不回复，避免误发
- 网关以 root 运行，iMessage 写操作经 sudo 降级到实际用户（`imsgCmd` 可改）
- 网关不碰其他工作区/session 私密上下文；回复内容只来自路由到的那个工作区

## 开发要点（web 进程 create agent 须知）

- web 进程 `agents.create` 必须用 agent-presets 组合 setup（`presets.mount` + 模型选择），否则 create 挂起
- **agents.create/resume 双版本兼容**（dsh 0.1.5 起需 `ownerCtx` 第一参，0.1.2 为单参 options）：按函数形参个数探测（`create.length >= 2`）包装，同一 bundle 双版本通用（2026-09-10 适配）
- create/resume 判断：先查 `sessionPersistence.list()` 是否有该 id，有则 `resume`，无则 `create`——避免 create 同 id 造成 id collision
- 改代码后重启 web 生效（web profile 的 HMR 已禁用）
- **投递串行链**：同一 sender 的 deliver 串行执行（防并发覆盖 `_streamSeenSeq` 导致历史全量重发，一次 379 条事故的根因）。**停止指令与会话重建指令都必须在入链之前拦截**——串行链会让指令排队等前一条 deliver 完成，等轮到它时 agent 已 idle（停止）或旧会话已被写脏（重建）；排队消息用 deliver 代次（`_deliverGeneration`）作废，拦截后旧代次消息直接丢弃
- **新插件项目必须建依赖软链**（否则 import `@deepseek-ai/*` 报 ERR_MODULE_NOT_FOUND）：
  ```sh
  mkdir -p node_modules && ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai node_modules/@deepseek-ai
  ```
