/**
 * gateway-core.mjs — dsh-imessage 消息接收核心（RPC 监听 + 路由 + 投递 + 出站）
 *
 * 作为 web 进程内的 host 模块被 index.js 使用。通过 `sudo -u fatatalia imsg rpc`
 * 子进程建立 JSON-RPC 会话：
 *   - watch.subscribe     订阅会话，收到新 iMessage 时推送 JSON-RPC 通知
 *   - send                回复消息（真实发送）
 *
 * 收到外部消息 → 过滤自己发的（is_from_me）→ 按 sender handle 查路由表定位
 * 工作区 → agents.create/resume + 用户消息投递 → 取回复 → send 回 sender。
 *
 * 依赖经由调用方注入（由 Cordis 提供的 agents/agentDefaultModel/sessions 等），
 * 本模块抛出不持有框架状态。
 */
import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

/** 默认 chat.db（root 下 homedir 错误，硬编码到 fatatalia） */
const CHAT_DB = "/Users/fatatalia/Library/Messages/chat.db";
/** 以哪个用户跑 imsg（网关是 root，需降级 fatatalia） */
const RUN_AS = "fatatalia";
/** 默认 imsg 命令（可通过配置覆盖） */
const DEFAULT_IMSG_CMD = "sudo -u fatatalia imsg";

/** 从事件取给定区间最后一条纯文本 assistant 回复。 */
function summarizeReply(events, firstSeq) {
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "assistant/message") {
      const joined = (event.data.message.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

/** 字符串命令拆成 [cmd, ...args]（支持引号）。 */
export function splitCmd(cmd) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/**
 * 网关核心类：持有 RPC 子进程、路由表、投递能力；接收消息、处理、回复。
 */
export class GatewayCore {
  constructor({ agents, defaultModel, sessions, agentPresets, workspaceRegistry, sessionPersistence, sessionTitle, log = console, settingsPath, statePath }) {
    this.agents = agents;
    this.defaultModel = defaultModel;
    this.sessions = sessions;
    this.agentPresets = agentPresets;
    this.workspaceRegistry = workspaceRegistry;
    this.sessionPersistence = sessionPersistence;
    this.sessionTitle = sessionTitle;
    this.log = log;
    this.settingsPath = settingsPath;
    this.statePath = statePath;
    /** sender handle → 当前活跃网关会话 id（原稳定会话被归档后迁移到新会话，映射持久化避免每次新建）。 */
    this.sessionMap = {};
    this.routes = {};
    this.imsgCmd = DEFAULT_IMSG_CMD;
    /** 自动回复开关（从配置读；也可手动开/关）。 */
    this.autoReply = true;
    /** 高级特性能力缓存（imsg status --json）：{ typing, readReceipts }，null=未探测。 */
    this._features = null;
    /** 每个 agent session 已消费的事件 seq（typing 随模型调用轮询用）。 */
    this._typingSeenSeq = new Map();
    /** RPC 子进程（stdin 写请求，stdout JSON-RPC）。 */
    this.child = null;
    this._msgId = 1;
    this._pending = new Map();
    this._buffer = "";
    this._disposed = false;
  }

  /**
   * 依据 agent-presets 组合出 web 兼容的 agent setup。
   * 关键：web 进程 create agent 必须在 setup 里 `presets.mount(agentCtx, presetId)`
   * 并安装模型选择，否则 create 挂起（缺 preset 组合上下文）。
   * @returns {Promise<{agentPreset?:string, setup:(ctx)=>Promise<void>}>}
   */
  async composeSetup(presetId) {
    const presets = this.agentPresets;
    if (presets === void 0) {
      return {
        setup: (agentCtx) => {
          const selection = this.defaultModel.currentSelection();
          installModelSelection(agentCtx, { current: selection, assembled: void 0 });
          return Promise.resolve();
        },
      };
    }
    const resolvedId = (await presets.resolve(presetId)).id;
    const selection = this.defaultModel.currentSelection();
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, { current: selection, assembled: void 0 });
        await presets.mount(agentCtx, resolvedId);
      },
    };
  }

  /**
   * 把网关会话归属到对应 workspace（按 cwd 路径）。否则会话显示为"未分组"。
   * 找不到 workspace 时尝试按路径创建。
   */
  async attachWorkspace(sessionId, cwd) {
    const registry = this.workspaceRegistry;
    if (registry === void 0) return;
    try {
      let workspace = await registry.resolveByPath(cwd);
      if (workspace === void 0) {
        // 尝试按路径登记为 workspace 实体。
        workspace = await registry.create(cwd);
      }
      await workspace.attachSession(sessionId);
    } catch (e) {
      this.log?.warn?.(`imessage: attach workspace ${cwd} 失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 加载 handle→workspace 路由 + imsgCmd + autoReply（settings.yaml 的 `imessage:` 段）。 */
  async loadConfig() {
    if (!this.settingsPath) return;
    try {
      const text = await readFile(this.settingsPath, "utf8");
      const parsed = parseConfigYaml(text);
      this.routes = parsed.routes || {};
      if (parsed.imsgCmd) this.imsgCmd = parsed.imsgCmd;
      if (parsed.autoReply !== undefined) this.autoReply = !!parsed.autoReply;
    } catch (e) {
      this.log?.warn?.(`imessage: 读取配置失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 按 handle 解析工作区（未命中回默认 mayacode）。 */
  workspaceFor(handle) {
    if (typeof handle !== "string" || !handle) return "/Users/fatatalia/dsh/mayacode";
    return this.routes[handle.trim()] || "/Users/fatatalia/dsh/mayacode";
  }

  /** 加载 sender→session 映射状态文件（不存在/损坏则空映射）。 */
  async loadState() {
    if (!this.statePath) return;
    try {
      const text = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(text);
      this.sessionMap = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      this.sessionMap = {};
    }
  }

  /** 持久化 sender→session 映射（原子写：tmp + rename）。 */
  async saveState() {
    if (!this.statePath) return;
    try {
      const tmp = `${this.statePath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.sessionMap, null, 2), "utf8");
      await rename(tmp, this.statePath);
    } catch (e) {
      this.log?.warn?.(`imessage: 保存状态失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 会话是否已被归档（UI 归档集，registry-global）。 */
  isArchived(id) {
    const set = this.workspaceRegistry?.archivedSessionIds;
    return Array.isArray(set) && set.includes(id);
  }

  /** 会话是否存在于持久化（可作为 resume 候选）。 */
  async isPersisted(id) {
    try {
      const headers = await this.sessionPersistence?.list?.();
      return !!headers?.some((h) => String(h.id) === String(id));
    } catch {
      return false;
    }
  }

  /** 生成新的随机网关会话 id（归档迁移用，避免与稳定 id 冲突）。 */
  newSessionId() {
    return SessionId(`gateway-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}-gw`);
  }

  /**
   * 探测 imsg 高级特性（typing / read receipts）：spawn `imsg status --json`
   * 一次并缓存。探测失败或不可用时安全降级为两者皆 false（功能静默跳过）。
   * @returns {Promise<{typing: boolean, readReceipts: boolean}>}
   */
  async probeFeatures() {
    if (this._features !== null) return this._features;
    const none = { typing: false, readReceipts: false };
    try {
      const [cmd, ...prefix] = splitCmd(this.imsgCmd);
      const out = await new Promise((resolve, reject) => {
        const child = spawn(cmd, [...prefix, "status", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
        let buf = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (c) => { buf += c; });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(buf) : reject(new Error(`status 退出 code=${code}`))));
      });
      const s = JSON.parse(out);
      const advanced = !!s.advanced_features;
      this._features = {
        typing: advanced && !!s.typing_indicators,
        readReceipts: advanced && !!s.read_receipts,
      };
      this.log?.info?.(`imessage: 能力探测完成 typing=${this._features.typing} readReceipts=${this._features.readReceipts}`);
    } catch (e) {
      this.log?.warn?.(`imessage: 能力探测失败（高级特性禁用）: ${e instanceof Error ? e.message : e}`);
      this._features = none;
    }
    return this._features;
  }

  /** 安全 RPC：失败只告警不抛出，避免高级特性问题影响主流程。 */
  async safeRpc(method, params) {
    try {
      return await this._rpc(method, params);
    } catch (e) {
      this.log?.warn?.(`imessage: ${method} 失败: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** 标记会话已读（read receipts；不支持时静默跳过）。 */
  async markRead(handle) {
    const f = await this.probeFeatures();
    if (!f.readReceipts) return;
    await this.safeRpc("read", { to: handle });
  }

  /**
   * 设置 typing 指示器。on=true 开始输入中；on=false 停止。
   * start 用 duration 模式（5s 自动消失，贴近原生体验，即使 stop 丢失也会自愈）；
   * 处理期间由调用方按短间隔续发以保持连续显示（LLM 可能超过 iOS typing 超时）。
   */
  async setTyping(handle, on) {
    const f = await this.probeFeatures();
    if (!f.typing) return;
    await this.safeRpc("typing", on ? { to: handle, duration: "5s" } : { to: handle, stop: true });
  }

  /**
   * typing 跟随模型调用：扫描 agent session 新增事件，`step/start`（模型推理开始）
   * → typing on，`step/end`（模型返回）→ typing off。多轮 LLM（工具循环）自动交替。
   * 由 deliver 的轮询定时器调用；按 seq 增量消费，避免重复触发历史事件。
   */
  _syncTyping(agent, sender) {
    const key = agent.session.id;
    const seen = this._typingSeenSeq.get(key) ?? 0;
    let max = seen;
    for (const evt of agent.session.events) {
      if (evt.seq <= seen) continue;
      if (evt.type === "step/start") this.setTyping(sender, true);
      else if (evt.type === "step/end") this.setTyping(sender, false);
      if (evt.seq > max) max = evt.seq;
    }
    this._typingSeenSeq.set(key, max);
  }

  /** 启动 RPC 监听：spawn imsg rpc + watch.subscribe。 */
  async startListener() {
    await this.loadConfig();
    await this.loadState();
    if (this.child) return;
    const [cmd, ...prefix] = splitCmd(this.imsgCmd);
    const args = [...prefix, "rpc", "--db", CHAT_DB, "--json"];
    this.log?.info?.(`imessage: 启动 RPC 监听 ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => this._onData(chunk));
    child.on("error", (e) => { this.log?.error?.(`imessage: rpc error: ${e.message}`); });
    child.on("exit", (code) => {
      this.log?.warn?.(`imessage: rpc 退出 code=${code}`);
      // 非主动 dispose 则延时重启（KeepAlive）。
      if (!this._disposed && this.autoReply) setTimeout(() => this.startListener().catch((e) => this.log?.error?.(e)), 3000);
    });
    // 订阅
    this._rpc("watch.subscribe", { chat_identifier: undefined }).catch((e) => this.log?.error?.(`imessage: subscribe failed ${e}`));
    // 预探测高级特性（typing/read receipts），失败静默降级。
    this.probeFeatures().catch(() => {});
  }

  /** 停止监听（dispose）。 */
  stopListener() {
    this._disposed = true;
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
  }

  /** 处理 stdout 数据：积累并按行解析 JSON-RPC。 */
  _onData(chunk) {
    this._buffer += chunk;
    let idx;
    while ((idx = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg && msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg && msg.method) {
        // 通知（订阅推送）
        this._onNotification(msg.method, msg.params);
      }
    }
  }

  /** 发一个 JSON-RPC 请求。 */
  _rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._msgId++;
      this._pending.set(id, { resolve, reject });
      const req = { jsonrpc: "2.0", id, method, params: params || {} };
      this.child?.stdin?.write(JSON.stringify(req) + "\n");
    });
  }

  /** 处理服务端推送通知。 */
  async _onNotification(method, params) {
    // 订阅推送的新消息（方法名依实际推送而定，常见 watch.message / message / message.added 等）。
    const msg = params ?? {};
    if (!msg || typeof msg !== "object") return;
    // 兼容多种推送封装：消息可能在 params.message / params.data / 本身
    const m = msg.message || msg.data || msg;
    if (!m || typeof m !== "object") return;
    // 过滤自己发的（避免回环）
    if (m.is_from_me) return;
    const sender = m.sender || m.handle || m.from || null;
    const text = m.text || m.body || "";
    if (!sender || !text) return;
    if (!this.autoReply) return;
    this.log?.info?.(`imessage: 收到来自 ${sender} [${new Date().toISOString()}]: ${String(text).slice(0, 60)}...`);
    try {
      const feats = await this.probeFeatures();
      // 已读回执：收到外部消息后立即标记该会话已读。
      if (feats.readReceipts) await this.markRead(sender);
      // typing 由 deliver 内部跟随模型调用（step/start→on，step/end→off）。
      const workspace = this.workspaceFor(sender);
      const reply = await this.deliver(sender, workspace, text);
      if (reply && this.autoReply) {
        const t0 = Date.now();
        await this.send(sender, reply);
        this.log?.info?.(`imessage: send ok ${Date.now() - t0}ms`);
      }
    } catch (e) {
      this.log?.error?.(`imessage: 处理消息失败 ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 按 sender 生成稳定 session id（同一发送者固定同一会话）。长度与旧版随机 id 相近、稳定。 */
  sessionIdFor(sender) {
    const h = String(sender ?? "").trim().toLowerCase();
    let h1 = 5381;
    for (let i = 0; i < h.length; i++) h1 = ((h1 << 5) + h1 + h.charCodeAt(i)) >>> 0;
    let h2 = 52711;
    for (let i = 0; i < h.length; i++) h2 = ((h2 << 7) + h2 * 31 + h.charCodeAt(i) + i) >>> 0;
    const hex1 = h1.toString(16).padStart(8, "0");
    const hex2 = h2.toString(16).padStart(8, "0");
    return SessionId(`gateway-${hex1}${hex2}-gw`);
  }

  /**
   * 投递一条用户消息到工作区，返回 agent 回复。
   * 固定会话：同一 sender 复用同一 session（live 优先复用，其次 resume 持久，最后 create），
   * 使同一发送者的连续消息延续上下文，而不是每次新建会话。
   * 归档迁移：若原稳定会话已被 UI 归档，则不再 resume 它（归档会话从列表隐藏，
   * 继续写入用户看不到），而是新建一个随机 id 会话，并把 sender→新会话 的映射
   * 持久化到状态文件，后续消息延续新会话。
   */
  async deliver(sender, workspace, message) {
    const selection = this.defaultModel.currentSelection();
    const agentOptionsArg = { provider: selection.provider, model: selection.model };

    // 候选顺序：映射 id（未归档且 live/persisted）→ 稳定 id（未归档且 live/persisted）→ 新建随机 id。
    const stableId = this.sessionIdFor(sender);
    let id = null;
    for (const candidate of [this.sessionMap[sender], stableId]) {
      if (!candidate || this.isArchived(candidate)) continue;
      if (this.agents.get(candidate) || await this.isPersisted(candidate)) {
        id = candidate;
        break;
      }
    }
    if (id === null) {
      id = this.newSessionId();
      this.log?.info?.(`imessage: sender=${sender} 原稳定会话已归档或不存在，迁移到新会话 ${id}`);
    }
    if (this.sessionMap[sender] !== id) {
      this.sessionMap[sender] = id;
      await this.saveState();
    }

    let agent = this.agents.get(id);

    if (!agent) {
      const composition = await this.composeSetup(undefined);
      // 权威判断：查持久化，已有同 id 记录则 resume，否则 create（避免 create 同 id 造成持久冲突）。
      if (await this.isPersisted(id)) {
        const resumed = await this.agents.resume({
          resumeSessionId: id,
          agentOptions: agentOptionsArg,
          setup: composition.setup,
        });
        agent = resumed.agent;
      } else {
        const created = await this.agents.create({
          sessionId: id,
          meta: {
            cwd: workspace,
            ...(composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset }),
          },
          agentOptions: agentOptionsArg,
          setup: composition.setup,
        });
        agent = created.agent;
      }
    }

    // 归属到对应工作区（幂等；创建/复用/恢复都尝试）。
    await this.attachWorkspace(id, workspace);

    // 把标题设为发送者 handle（pin，固定不被自动标题覆盖）。如 +8613800000000。
    try {
      const st = this.sessionTitle;
      if (st && agent?.session) {
        const title = String(sender ?? "").trim();
        if (title) st.rename(agent.session, title);
      }
    } catch (e) {
      this.log?.warn?.(`imessage: 设置标题 ${sender} 失败: ${e instanceof Error ? e.message : e}`);
    }

    // typing 跟随模型调用：轮询 agent 事件，step/start → on，step/end → off。
    // 多轮 LLM（工具循环）自然交替；finally 兜底停止。
    const typing = (await this.probeFeatures()).typing;
    let typingPoller = null;
    if (typing) {
      this._typingSeenSeq.set(agent.session.id, agent.session.events.at(-1)?.seq ?? 0);
      typingPoller = setInterval(() => this._syncTyping(agent, sender), 200);
    }
    try {
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      agent.followup(createUserMessage({
        content: [{ type: "text", text: message }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
      const { text } = summarizeReply(agent.session.events, firstSeq);
      this.log?.info?.(`deliver 完成 id=${id} reply=${text?.length ?? 0}字`);
      return text;
    } finally {
      if (typingPoller !== null) clearInterval(typingPoller);
      this._typingSeenSeq.delete(id);
      if (typing) await this.setTyping(sender, false);
    }
  }

  /** 通过 RPC send 回复（真实发送）。 */
  async send(to, text) {
    const r = await this._rpc("send", { to, text });
    return r;
  }
}

/** 从 settings.yaml 的 `imessage:` 段解析配置。 */
export function parseConfigYaml(yaml) {
  const cfg = {};
  const lines = yaml.split(/\r?\n/);
  let inGateway = false;
  let inRoutes = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#/.test(trimmed)) {
      // 段首注释（`# imessage:`）不算配置行；其他注释直接跳过。
      if (/^imessage\s*:/.test(trimmed.replace(/^#+\s*/, ""))) continue;
      continue;
    }
    const indent = line.match(/^\s*/)?.[0]?.length ?? 0;
    if (!inGateway) {
      if (/^imessage\s*:/.test(trimmed)) { inGateway = true; continue; }
      continue;
    }
    if (indent === 0) break;
    if (/^routes\s*:/.test(trimmed)) { inRoutes = true; continue; }
    if (/^imsgCmd\s*:/.test(trimmed)) { cfg.imsgCmd = trimmed.slice(trimmed.indexOf(":") + 1).trim().replace(/^["']|["']$/g, ""); continue; }
    if (/^autoReply\s*:/.test(trimmed)) { cfg.autoReply = trimmed.slice(trimmed.indexOf(":") + 1).trim() === "true"; continue; }
    if (inRoutes) {
      const idx = trimmed.indexOf(":");
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim().replace(/^["']|["']$/g, "");
        const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "").replace(/\s*#.*$/, "").trim();
        if (k && v) { cfg.routes = cfg.routes || {}; cfg.routes[k] = v; }
      }
    }
  }
  return cfg;
}
