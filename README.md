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
    │   ├── agents.create/resume + followup 投递 → 取回复
    │   └── RPC send 回发  → 自动回复
    ├── Typert remote "imessageGateway"（getConfig/setConfig）→ 配置页
    └── 全局 message 工具（任何 agent 可主动发 iMessage）
```

- **入站**：`imsg rpc` 订阅全部会话，流式推送新消息
- **路由**：`settings.yaml` 的 `imessage:` 段 → `routes`（handle → 工作区路径）
- **固定会话**：同一 sender 固定同一 session（id 按 handle 哈希稳定）；live 复用 / resume / create
- **归档迁移**：原会话被 UI 归档后不再 resume，自动新建会话并持久化映射（`~/.dsh/imessage-gateway-state.json`），新消息延续新会话
- **已读回执**：收到外部消息后立即发 read（`imsg status --json` 探测 `read_receipts`，支持才启用）
- **typing 跟随模型调用**：agent 事件 `step/start`（模型推理开始）→ typing on，`step/end`（模型返回）→ typing off；多轮 LLM（工具循环）自然交替；duration 5s + 兜底 stop 防卡死
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

## 安全红线

- `autoReply` 默认 true；关闭后只监听不回复，避免误发
- 网关以 root 运行，iMessage 写操作经 sudo 降级到实际用户（`imsgCmd` 可改）
- 网关不碰其他工作区/session 私密上下文；回复内容只来自路由到的那个工作区

## 开发要点（web 进程 create agent 须知）

- web 进程 `agents.create` 必须用 agent-presets 组合 setup（`presets.mount` + 模型选择），否则 create 挂起
- create/resume 判断：先查 `sessionPersistence.list()` 是否有该 id，有则 `resume`，无则 `create`——避免 create 同 id 造成 id collision
- 改代码后重启 web 生效（web profile 的 HMR 已禁用）
- **新插件项目必须建依赖软链**（否则 import `@deepseek-ai/*` 报 ERR_MODULE_NOT_FOUND）：
  ```sh
  mkdir -p node_modules && ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai node_modules/@deepseek-ai
  ```
