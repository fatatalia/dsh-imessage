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
import { spawn, spawnSync } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

/**
 * 停止指令关键词表（多语言）。参考 OpenClaw abort-primitives 的 ABORT_TRIGGERS，
 * 去掉 OpenClaw 专属长句（"stop openclaw" 等），补充中文口语常用词。
 * 匹配方式：整条消息规范化（小写/去空白/去尾部标点）后精确匹配；agent 忙碌时命中即中断当前轮。
 */
export const DEFAULT_STOP_KEYWORDS = [
  // 中文
  "停止", "停下来", "暂停", "停一下", "别做了", "算了", "取消",
  // 英文
  "stop", "/stop", "esc", "abort", "wait", "exit", "interrupt", "halt", "stopp", "pare",
  // 日文
  "やめて", "止めて",
  // 俄文
  "стоп", "остановись", "останови", "остановить", "прекрати",
  // 西/法/德
  "detente", "deten", "detén", "arrete", "arrête", "anhalten", "aufhören", "hoer auf",
  // 印地/阿拉伯
  "रुको", "توقف",
];

/**
 * 运行环境配置。所有路径均可通过环境变量覆盖，避免写死个人路径：
 * - IMSG_CHAT_DB            chat.db 路径（默认 ~/Library/Messages/chat.db；网关以
 *                           root 运行时 homedir() 指向 /var/root，请用此变量指向
 *                           实际用户的 chat.db）
 * - IMSG_CMD                imsg 执行命令（默认 "imsg"；网关以 root 运行需降级时
 *                           配置如 "sudo -u <your-user> imsg"）
 * - IMSG_DEFAULT_WORKSPACE  路由表未命中时的默认工作区路径
 */
const CHAT_DB = process.env.IMSG_CHAT_DB || join(homedir(), "Library/Messages/chat.db");
const DEFAULT_IMSG_CMD = process.env.IMSG_CMD || "imsg";

/**
 * Markdown → iMessage 纯文本清洗。
 * iMessage 不支持 Markdown 渲染，模型回复/工具消息里的语法标记会原样显示成符号。
 * 规则保守优先，避免误伤 URL、代码内容、中文语境里的合法符号：
 *   1. 代码块（``` 围栏）→ 保留内容、去围栏（先提取占位，防内部内容被后续规则误伤）
 *   2. 表格：分隔行（|---|）删除；数据行去首尾 |（保留中间 | 作分隔）
 *   3. 标题 # → 去井号；引用 > → 去标记；无序列表 - / * / + → •；有序列表保留序号
 *   4. 行内：链接 [t](u) → t（u）；粗体 **b** 或 __b__ → b；斜体 *i* → i（带边界，防乘法误伤）；行内代码 `code` → code
 *   5. 压缩 3+ 连续空行
 */
export function sanitizeForIM(text) {
  if (!text || typeof text !== "string") return text;
  let t = text;
  const codeBlocks = [];
  // 1. 代码块提取（```lang\n...\n``` 或 ```...```），占位符 \u0000CB<n>\u0000
  t = t.replace(/```[^\n]*\n?([\s\S]*?)```/g, (m, body) => {
    codeBlocks.push(body.replace(/\n$/, ""));
    return `\u0000CB${codeBlocks.length - 1}\u0000`;
  });
  // 1b. 转义字符保护（\* \# \` \_ \> \- \+ 等 → 占位符，行内规则跑完再还原为原字符）
  t = t.replace(/\\([*#`>_~\-+])/g, (m, c) => `\u0000ESC${c.charCodeAt(0)}\u0000`);
  const out = [];
  for (const line of t.split("\n")) {
    let l = line;
    // 2a. 表格分隔行（只含 | - : 空格）删除
    if (/^[\s|:\-]+$/.test(l) && l.includes("-")) continue;
    // 2b. 表格数据行去首尾 |（含相邻空格）
    if (/^\s*\|.*\|\s*$/.test(l)) l = l.replace(/^\s*\|\s*/, "").replace(/\s*\|\s*$/, "");
    // 3. 标题 / 引用（含多级 >>）/ 无序列表
    l = l.replace(/^#{1,6}\s+/, "");
    l = l.replace(/^>+\s?/, "");
    l = l.replace(/^\s*[-*+]\s+/, "• ");
    out.push(l);
  }
  t = out.join("\n");
  // 4. 行内：链接 → 粗体（允许内部单个 *，如 **粗*斜*粗**）→ 斜体 → 行内代码
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）");
  t = t.replace(/\*\*([^*]+(?:\*[^*]+)*)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1$2");
  t = t.replace(/`([^`]+)`/g, "$1");
  // 4b. 还原转义字符
  t = t.replace(/\u0000ESC(\d+)\u0000/g, (m, code) => String.fromCharCode(Number(code)));
  // 5. 还原代码块
  t = t.replace(/\u0000CB(\d+)\u0000/g, (m, i) => codeBlocks[Number(i)] ?? "");
  // 6. 压缩 3+ 连续空行
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/**
 * 入站消息时间戳注入（参考 OpenClaw agent-timestamp.ts，issue #3658）。
 * 格式：`[周三 2026-09-03 02:30 UTC+8] ` —— 中文星期 + YYYY-MM-DD HH:MM + 无歧义 UTC 偏移。
 * 时区显式配置（IANA 名），不读系统时区；偏移用 Intl longOffset 动态计算（兼容 DST 时区）。
 * 分钟精度即可（模型不需要秒）；~8 token 成本。
 */
const TIMESTAMP_ENVELOPE_RE = /^\[.*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

export function buildTimestampPrefix(date, timezone = "Asia/Shanghai") {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23",
      weekday: "short",
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
    const off = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
      .formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
    const offShort = off.replace("GMT", "UTC").replace(/:00$/, "").replace(/^UTC([+-])0(\d)/, "UTC$1$2");
    return `[${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${offShort}] `;
  } catch {
    return undefined;
  }
}

/** 给消息加时间戳前缀；已有信封（含历史注入）或空消息则原样返回（防重复打戳）。 */
export function injectTimestampPrefix(message, timezone = "Asia/Shanghai") {
  if (!message || typeof message !== "string") return message;
  if (!message.trim()) return message;
  if (TIMESTAMP_ENVELOPE_RE.test(message)) return message;
  const prefix = buildTimestampPrefix(new Date(), timezone);
  if (!prefix) return message;
  return `${prefix}${message}`;
}

/** 输出 token 上限截断提示（与 Web UI 的 message.maxTokens 语义一致，iMessage 通道补发）。 */
const MAX_TOKENS_NOTICE = '⚠️ 回答被截断（输出 token 上限），回复"继续"可让模型接着输出';

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
    /** 流式发送开关（配置读）：处理过程中每条 assistant 消息即时发出，不等整个 turn 结束。 */
    this.streamReplies = true;
    /** 工具执行提示开关（配置读）：tool/call 时把 `🔧 <描述>` 即时发给发送者。独立于 streamReplies。 */
    this.toolCallReplies = true;
    /** 纯文本清洗开关（配置读）：iMessage 不支持 Markdown，开启后 send() 出口统一做 Markdown→纯文本转换。 */
    this.plainText = true;
    /** 入站消息时间戳注入开关（配置读）：投递用户消息前加 `[周三 2026-09-03 02:30 UTC+8] ` 前缀，
     * 让模型每轮都感知当前时间（参考 OpenClaw agent-timestamp，issue #3658）。默认开。 */
    this.injectTimestamp = true;
    /** 时间戳时区（配置读，IANA 名）：显式配置不读系统时区，防机器时区错乱/迁移。默认 Asia/Shanghai。 */
    this.userTimezone = "Asia/Shanghai";
    /** turn 级单步超时（秒）：>0 时投递的 agent 挂 __pluginConfig.turnGuard.stepSec（dsh-turn-guard 读取）；0 = 不限制。 */
    this.stepTimeoutSec = 0;
    /** 停止指令关键词表（Set；配置可覆盖）。agent 忙碌时整条消息精确命中即中断当前轮（参考 OpenClaw /stop）。 */
    this.stopKeywords = new Set(DEFAULT_STOP_KEYWORDS);
    /** 注入自愈开关（配置读）：开启后启动时 + 每 healthIntervalMin 分钟检查一次注入，
     * 发现异常自动 `imsg launch` 恢复；关闭则不检查也不 launch。默认开。 */
    this.autoLaunch = true;
    /** 注入健康检查间隔（分钟，配置读）：autoLaunch 开启时的检查周期。默认 5。 */
    this.healthIntervalMin = 5;
    /** 注入健康检查定时器（autoLaunch 开启时挂起，关闭时清掉）。 */
    this._healthTimer = null;
    /** 注入健康检查进行中标记（防并发重入）。 */
    this._healing = false;
    /** 高级特性能力缓存（imsg status --json）：{ typing, readReceipts }，null=未探测。 */
    this._features = null;
    /** 每个 agent session 已消费的事件 seq（typing + 流式发送轮询用）。 */
    this._streamSeenSeq = new Map();
    /** 活跃流式消费表：agent.session.id → { agent, sender }。drain 退出屏障补扫用——
     * 事件生成 → 轮询消费之间存在时间窗，SIGTERM 落在窗口内时已生成消息会永久丢失
     * （2026-09-03 实测：最后一条 assistant 消息生成后同一秒重启，轮询未跑到即被杀）。 */
    this._activeStreams = new Map();
    /** 同一 sender 的 deliver 串行链：iMessage 同一会话无并发必要，串行避免
     * 并发 deliver 互相覆盖/删除 _streamSeenSeq（曾导致 _syncStream 从 0 全量
     * 重发历史，一次 379 条）。 */
    this._deliverChains = new Map();
    /** 同一 sender 当前排队中的 deliver 数（含正在执行的），日志展示用。 */
    this._deliverPending = new Map();
    /** 同一 sender 的 deliver 代次：停止指令递增，入链消息捕获代次，过期即丢弃（清排队消息）。 */
    this._deliverGeneration = new Map();
    /** 流式发送串行链（保证多条消息按顺序发出）。 */
    this._sendChain = Promise.resolve();
    /** typing RPC 串行链（保证 on/off 严格按调用顺序送达，杜绝 stop 先于最后一个 on 到达）。 */
    this._typingChain = Promise.resolve();
    /** typing keepalive：sender → { timer, refs }。startTyping 启动每 3s 续发，stopTyping 停止并发送 stop。 */
    this._typingKeepalives = new Map();
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
      this.applyConfig(parsed);
    } catch (e) {
      this.log?.warn?.(`imessage: 读取配置失败: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * 应用配置快照（启动加载 + 配置页热更新共用）：更新运行时可变的开关与路由。
   * 配置页保存后经 scope.watch 调用，无需重启即生效。
   */
  applyConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    if (cfg.routes && typeof cfg.routes === "object") this.routes = cfg.routes;
    if (cfg.imsgCmd) this.imsgCmd = cfg.imsgCmd;
    if (cfg.autoReply !== undefined) this.autoReply = !!cfg.autoReply;
    if (cfg.streamReplies !== undefined) this.streamReplies = !!cfg.streamReplies;
    if (cfg.toolCallReplies !== undefined) this.toolCallReplies = !!cfg.toolCallReplies;
    if (cfg.plainText !== undefined) this.plainText = !!cfg.plainText;
    if (cfg.injectTimestamp !== undefined) this.injectTimestamp = !!cfg.injectTimestamp;
    if (typeof cfg.userTimezone === "string" && cfg.userTimezone.trim()) this.userTimezone = cfg.userTimezone.trim();
    if (cfg.stepTimeoutSec !== undefined) this.stepTimeoutSec = Number(cfg.stepTimeoutSec) > 0 ? Number(cfg.stepTimeoutSec) : 0;
    if (Array.isArray(cfg.stopKeywords)) {
      const kw = cfg.stopKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean);
      if (kw.length > 0) this.stopKeywords = new Set(kw);
    }
    if (cfg.autoLaunch !== undefined) this.autoLaunch = !!cfg.autoLaunch;
    if (cfg.healthIntervalMin !== undefined && Number(cfg.healthIntervalMin) >= 1) {
      this.healthIntervalMin = Math.min(Math.floor(Number(cfg.healthIntervalMin)), 60);
    }
    // 开关/间隔热更新后同步定时器（内部处理启动/停止/间隔重置）
    if (typeof cfg.autoLaunch === "boolean" || cfg.healthIntervalMin !== undefined) {
      this.syncHealthTimer();
    }
  }

  /** 停止指令检测：整条消息规范化（小写/去空白/去尾部标点）后精确匹配停止词表（参考 OpenClaw abort-primitives）。 */
  isStopRequest(text) {
    if (!text || typeof text !== "string") return false;
    const normalized = String(text).trim().toLowerCase()
      .replace(/[’`]/g, "'")
      .replace(/\s+/g, " ")
      .replace(/[.!?！？…,，。;；:：'"’”)\]},、]+$/u, "")
      .trim();
    return this.stopKeywords.has(normalized);
  }

  /** 按 handle 解析工作区（未命中回默认 mayacode）。 */
  workspaceFor(handle) {
    const fallback = process.env.IMSG_DEFAULT_WORKSPACE || join(homedir(), "dsh", "default");
    if (typeof handle !== "string" || !handle) return fallback;
    return this.routes[handle.trim()] || fallback;
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
   * 使用 imsg RPC `typing` 布尔参数（与 OpenClaw 实现一致）：start 表示持续显示，
   * 由 keepalive 每 3s 续发维持；stop 立即停止。
   * 经 _typingChain 串行执行：on/off 严格按调用顺序送达 imsg，避免并发 RPC 乱序。
   */
  async setTyping(handle, on) {
    const f = await this.probeFeatures();
    if (!f.typing) return;
    const p = this._typingChain.then(() =>
      this.safeRpc("typing", { to: handle, typing: on }),
    );
    // 链上失败不阻断后续 typing（与 _sendChain 同样的容错策略）。
    this._typingChain = p.then(() => {}, () => {});
    await p;
  }

  /**
   * 开始 typing（参照 OpenClaw keepalive 机制）：立即发 start，并每 3s 续发一次，
   * 持续刷新 iOS 端"输入中"显示（避免间隔太久导致后续 stop 失效）。
   * 同一 sender 并发 deliver 共享一个 keepalive（引用计数），全部完成才真正 stop。
   * 不阻塞调用方：首帧与续发均 fire-and-forget，顺序由 _typingChain 保证。
   */
  async startTyping(sender) {
    const entry = this._typingKeepalives.get(sender);
    if (entry) {
      entry.refs += 1;
      return;
    }
    const timer = setInterval(() => {
      this.setTyping(sender, true).catch(() => {});
    }, 3000);
    timer.unref?.();
    this._typingKeepalives.set(sender, { timer, refs: 1 });
    this.setTyping(sender, true).catch(() => {});
  }

  /**
   * 停止 typing：引用计数减一，归零时清除 keepalive 定时器并发送一次 stop。
   */
  async stopTyping(sender) {
    const entry = this._typingKeepalives.get(sender);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    clearInterval(entry.timer);
    this._typingKeepalives.delete(sender);
    await this.setTyping(sender, false);
  }

  /**
   * 流式事件消费：扫描 agent session 新增事件——
   * - `assistant/message`（模型产出一条完整回复）→ 若开启流式发送则即时发出
   * - `tool/call`（工具开始执行）→ 若调用参数带 description 则流式提示给发送者
   * - `turn/end`（reason.kind=max-tokens）→ 输出被截断，流式补发截断提示
   * typing 不再按事件开关：由 startTyping/stopTyping 的 keepalive 统一管理（每 3s 续发）。
   */
  _syncStream(agent, sender) {
    const key = agent.session.id;
    const seen = this._streamSeenSeq.get(key) ?? 0;
    let max = seen;
    for (const evt of agent.session.snapshotEvents()) {
      if (evt.seq <= seen) continue;
      if (evt.type === "assistant/message" && this.streamReplies) this._sendReply(sender, evt);
      else if (evt.type === "tool/call" && this.toolCallReplies) this._sendToolCall(sender, evt);
      else if (evt.type === "turn/end" && evt.data?.reason?.kind === "max-tokens" && this.streamReplies) this._sendNotice(sender);
      if (evt.seq > max) max = evt.seq;
    }
    this._streamSeenSeq.set(key, max);
  }

  /** 提取 assistant/message 事件的纯文本内容（trimEnd：过滤纯空白、去掉尾部多余空行）。 */
  _extractMessageText(evt) {
    const content = evt?.data?.message?.content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trimEnd();
  }

  /** 流式发送一条 assistant 回复：串行链保证顺序，失败不阻断后续。 */
  _sendReply(sender, evt) {
    const text = this._extractMessageText(evt);
    if (!text) return; // trimEnd 后为空（纯空白 text block）直接跳过，杜绝空白消息
    this.log?.info?.(`imessage: 流式发送 ${text.length}字 给 ${sender}`);
    this._sendChain = this._sendChain
      .then(() => this.send(sender, text))
      .catch((e) => this.log?.warn?.(`imessage: 流式发送失败: ${e instanceof Error ? e.message : e}`));
  }

  /** 流式补发一条系统提示（输出截断等），走同一串行链保证排在回复之后。 */
  _sendNotice(sender) {
    this.log?.info?.(`imessage: 流式补发截断提示 给 ${sender}`);
    this._sendChain = this._sendChain
      .then(() => this.send(sender, MAX_TOKENS_NOTICE))
      .catch((e) => this.log?.warn?.(`imessage: 流式提示发送失败: ${e instanceof Error ? e.message : e}`));
  }

  /**
   * 等待投递链清空（退出屏障用）：所有已排队的 imsg 投递完成。
   * 进程退出前调用，保证重启/停止时不丢消息。
   * 先补扫活跃流式消费的未消费事件（事件生成 → 轮询消费之间存在时间窗，
   * SIGTERM 可能落在窗口内导致已生成消息永久丢失，2026-09-03 实测），
   * 再等发送链清空。补扫不会重复发送（_streamSeenSeq 记录已消费 seq）。
   */
  async drain() {
    for (const { agent, sender } of this._activeStreams.values()) {
      try { this._syncStream(agent, sender); } catch { /* ignore */ }
    }
    await this._sendChain;
  }

  /** 从工具调用参数（JSON 字符串或对象）中提取 description 字段。 */
  _extractToolDescription(raw) {
    if (!raw) return "";
    let parsed = raw;
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return "";
      }
    }
    if (parsed && typeof parsed.description === "string" && parsed.description.trim()) {
      return parsed.description.trim();
    }
    return "";
  }

  /**
   * 工具执行时流式提示：tool/call 事件，若调用参数带 description（如 bash 的
   * `description`）则即时发送一条 `🔧 <描述>`，让发送者看到正在执行什么操作。
   * 与回复共用 _sendChain，保证与 assistant 消息的发送顺序一致。
   */
  _sendToolCall(sender, evt) {
    const data = evt?.data ?? {};
    const name = typeof data.name === "string" ? data.name : "";
    const desc = this._extractToolDescription(data.arguments);
    if (!desc) return;
    this.log?.info?.(`imessage: 工具提示 ${name}: ${desc.slice(0, 60)}`);
    this._sendChain = this._sendChain
      .then(() => this.send(sender, `🔧 ${desc}`))
      .catch((e) => this.log?.warn?.(`imessage: 工具提示发送失败: ${e instanceof Error ? e.message : e}`));
  }

  /** 启动 RPC 监听：spawn imsg rpc + watch.subscribe。 */
  async startListener() {
    await this.loadConfig();
    await this.loadState();
    if (this.child) return;
    // 注入保障（autoLaunch 开启时）：启动前确认注入在，异常先自动 launch 恢复；失败不阻塞 rpc 启动，定时检查会继续尝试。
    if (this.autoLaunch) {
      const healthy = await this.checkInjectionHealth();
      if (!healthy) this.log?.info?.(`imessage: 启动时注入不可用，rpc 仍将启动，定时检查会继续尝试恢复`);
    }
    // 健康检查定时器：无论配置是否有 autoLaunch 字段都要挂（构造函数默认 true，
    // settings.yaml 未显式存储时 applyConfig 不会触发 syncHealthTimer）。
    this.syncHealthTimer();
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
    // 订阅：attachments:true 让推送携带附件元数据（图片消息的 original_path 等），
    // 否则纯图片消息无法在网关侧拿到附件路径。
    this._rpc("watch.subscribe", { attachments: true, debounce_ms: 200 }).catch((e) => this.log?.error?.(`imessage: subscribe failed ${e}`));
    // 预探测高级特性（typing/read receipts），失败静默降级。
    this.probeFeatures().catch(() => {});
  }

  /** 停止监听（dispose）。 */
  stopListener() {
    this._disposed = true;
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
  }

  /**
   * 注入健康检查（启动保障 + 定时探活共用）：
   * spawn `imsg status --json` 解析 advanced_features（注入正常=true）。
   * 异常 → 自动 `imsg launch` 重新注入 → 复查 → 恢复后重启 rpc 监听衔接新注入。
   * @returns {Promise<boolean>} true=注入可用（含自动恢复成功）。
   */
  async checkInjectionHealth() {
    if (this._healing) return false;
    if (await this._probeInjection()) return true;
    this._healing = true;
    try {
      this.log?.info?.(`imessage: 注入检测异常，尝试自动恢复（${this.imsgCmd} launch）`);
      const recovered = await this._launchInjection();
      if (!recovered) {
        this.log?.info?.(`imessage: imsg launch 多次失败，请手动执行 ${this.imsgCmd} launch`);
        return false;
      }
      this.log?.info?.(`imessage: 注入已自动恢复`);
      // 注入重建后旧 rpc 会话可能失效：重启监听衔接
      if (this.child) {
        this.log?.info?.(`imessage: 重启 rpc 监听以衔接新注入`);
        try { this.child.kill(); } catch { /* ignore */ }
        this.child = null;
        await this.startListener();
      }
      return true;
    } finally {
      this._healing = false;
    }
  }

  /** spawn `imsg status --json`，返回注入是否正常。
   * 探针：bridge_version >= 2（v2 = 注入正常，v0 = 未注入）。
   * 注意：advanced_features / message 在未注入时仍返回 true/"Connected to Messages.app"，不可靠（2026-09-09 实测）。 */
  _probeInjection() {
    return new Promise((resolve) => {
      const [cmd, ...prefix] = splitCmd(this.imsgCmd);
      const child = spawn(cmd, [...prefix, "status", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (c) => { buf += c; });
      child.on("error", () => resolve(false));
      child.on("close", (code) => {
        if (code !== 0) return resolve(false);
        try {
          const s = JSON.parse(buf);
          resolve(Number(s.bridge_version) >= 2);
        } catch { resolve(false); }
      });
    });
  }

  /** spawn `imsg launch`（kill Messages.app 后带 dylib 重启注入）；失败返回 false。 */
  /**
   * 执行 imsg launch 并确认注入生效（最多 3 次）。
   * 经验（2026-09-09 用户实测）：launch 第一次常报 "Timeout waiting for Messages.app to initialize"
   * （Messages.app 启动慢），紧接着再执行一次通常成功。launch 失败时 exit code 也是 0，
   * 所以以 launch 后 probe（bridge_version>=2）为准，不以 exit code 判断。
   * @returns {Promise<boolean>} true=注入已生效
   */
  async _launchInjection() {
    // launch 必须在 fatatalia 的 GUI 会话上下文执行：root 直接 sudo -u 会因无 GUI 上下文
    // 而超时失败（2026-09-09 实测：launchctl asuser <uid> 一次成功，root→sudo 两次失败）。
    let uid = this._launchUid;
    if (!uid) {
      try { uid = this._launchUid = Number(spawnSync("id", ["-u", "fatatalia"], { encoding: "utf8" }).stdout.trim()); } catch { uid = 501; }
    }
    // 全部用绝对路径：launchd 服务 PATH=/usr/bin:/bin:/usr/sbin:/sbin（无 /usr/local/bin），
    // 相对命令名会 posix_spawn ENOENT（2026-09-09 实测 launch exit=2）。
    const imsgBin = "/usr/local/bin/imsg";
    for (let attempt = 1; attempt <= 3; attempt++) {
      await new Promise((resolve) => {
        const child = spawn("/bin/launchctl", ["asuser", String(uid), "/usr/bin/sudo", "-u", "fatatalia", imsgBin, "launch"], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (c) => { out += c; });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (c) => { err += c; });
        child.on("error", (e) => { this.log?.error?.(`imessage: launch spawn 错误: ${e.message}`); resolve(); });
        child.on("close", (code) => {
          this.log?.info?.(`imessage: launch exit=${code} out=${out.trim().slice(0, 200)} err=${err.trim().slice(0, 200)}`);
          resolve();
        });
      });
      // 等注入生效（launch 超时常见，注入可能已生效或需重试）
      await new Promise((r) => setTimeout(r, 5000));
      if (await this._probeInjection()) {
        if (attempt > 1) this.log?.info?.(`imessage: imsg launch 第 ${attempt} 次成功（前次超时，重试生效）`);
        return true;
      }
      this.log?.info?.(`imessage: imsg launch 第 ${attempt} 次后注入未生效${attempt < 3 ? "，重试" : "，放弃"}`);
    }
    return false;
  }

  /** 同步健康检查定时器：autoLaunch 开 → 启动/重置（每 healthIntervalMin 分钟）；关 → 清除。 */
  syncHealthTimer() {
    if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    if (!this.autoLaunch) return;
    this._healthTimer = setInterval(() => {
      this.checkInjectionHealth().then((ok) => {
        if (!ok) this.log?.info?.(`imessage: 注入健康检查（${this.healthIntervalMin}min 周期）: 异常`);
      }).catch((e) => this.log?.warn?.(`imessage: 健康检查异常: ${e instanceof Error ? e.message : e}`));
    }, this.healthIntervalMin * 60_000);
    if (this._healthTimer.unref) this._healthTimer.unref();
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

    // 文本：去掉 iMessage 图片消息的对象替换符（U+FFFC "￼"）等无意义占位。
    const rawText = String(m.text || m.body || "");
    const text = rawText.replace(/\uFFFC/g, "").trim();
    // 图片等附件：取本机真实路径（chat.db 附件目录），投递给 agent 供 modlens 等工具读取。
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    const images = atts
      .filter((a) => a && !a.missing && a.original_path && /^image\//i.test(a.mime_type || ""))
      .map((a) => a.original_path);

    // 无文本且无图片附件（纯垃圾/占位消息）→ 不投递。
    if (!sender || (!text && images.length === 0)) return;
    if (!this.autoReply) return;

    let content = text;
    if (images.length > 0) {
      const imgRef = images.map((p) => `[图片: ${p}]`).join(" ");
      content = content ? `${content} ${imgRef}` : `用户发来图片：${images.join("、")}`;
    }
    // 队列长度 = 本条入队后的总数（含本条）：1=正常处理，>1=前面还有 N-1 条在排队。
    const queueLen = (this._deliverPending.get(sender) ?? 0) + 1;
    this.log?.info?.(`imessage: 收到来自 ${sender}: ${String(content).slice(0, 80)}...（队列 ${queueLen}）`);
    try {
      const feats = await this.probeFeatures();
      // 已读回执：收到外部消息后立即标记该会话已读。
      if (feats.readReceipts) await this.markRead(sender);
      // typing 由 deliver 内部跟随模型调用（step/start→on，step/end→off）。
      const workspace = this.workspaceFor(sender);
      const reply = await this.deliver(sender, workspace, content);
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
   * 投递入口：同一 sender 的 deliver 串行执行（iMessage 同一会话无并发必要）。
   * 并发 deliver 会互相覆盖 _streamSeenSeq——deliver 完成时 finally 里
   * `_streamSeenSeq.delete(id)` 会破坏其他 deliver 的 seen，使 _syncStream
   * 读到 0 从 seq 0 全量重发整个会话历史（一次 379 条事故的根因）。
   * 串行后同一时刻只有一个 deliver 在跑，seen 状态安全。
   * @returns 该条消息的 deliver 结果（streamReplies 开启时为 null）。
   */
  deliver(sender, workspace, message) {
    // 停止指令优先拦截：必须在入链之前判断——串行链会让"停止"排队等前一条
    // deliver 完成，等轮到它时 agent 已 idle、拦截条件失效（8/26 实测翻车根因）。
    // 收到"停止"时立即检查当前活跃会话的 agent：忙碌且整条精确命中 → 中断 + 回执，不排队。
    // 同时递增该 sender 的 deliver 代次：作废已在串行链上排队的旧消息（停止前发的
    // 其它消息不再投递，OpenClaw /stop 的"连排队消息一起丢弃"语义）。
    const busyAgent = this.sessionMap[sender] ? this.agents.get(this.sessionMap[sender]) : null;
    if (busyAgent?.status === "running" && this.isStopRequest(message)) {
      this.log?.info?.(`imessage: ${sender} 发送停止指令（${String(message).slice(0, 20)}），中断当前轮并作废排队消息`);
      busyAgent.cancel(new Error("user stop via imessage"));
      this._deliverGeneration.set(sender, (this._deliverGeneration.get(sender) ?? 0) + 1);
      this.send(sender, "⏹ 已停止（已清理排队消息）").catch(() => {});
      return Promise.resolve(null);
    }
    const generation = this._deliverGeneration.get(sender) ?? 0;
    const pending = (this._deliverPending.get(sender) ?? 0) + 1;
    this._deliverPending.set(sender, pending);
    const chain = this._deliverChains.get(sender) ?? Promise.resolve();
    const task = chain.then(() => this._deliver(sender, workspace, message, generation));
    // 链尾吞错：前一条失败不阻塞后续消息。
    this._deliverChains.set(sender, task.then(() => void 0, () => void 0));
    // 任务 settle 后递减排队计数（finally 保证失败也清理）。
    task.finally(() => {
      const left = (this._deliverPending.get(sender) ?? 1) - 1;
      if (left <= 0) this._deliverPending.delete(sender);
      else this._deliverPending.set(sender, left);
    });
    return task;
  }

  /**
   * 投递一条用户消息到工作区，返回 agent 回复（deliver 串行链内的实际执行体）。
   * 固定会话：同一 sender 复用同一 session（live 优先复用，其次 resume 持久，最后 create），
   * 使同一发送者的连续消息延续上下文，而不是每次新建会话。
   * 归档迁移：若原稳定会话已被 UI 归档，则不再 resume 它（归档会话从列表隐藏，
   * 继续写入用户看不到），而是新建一个随机 id 会话，并把 sender→新会话 的映射
   * 持久化到状态文件，后续消息延续新会话。
   */
  async _deliver(sender, workspace, message, generation) {
    // 停止指令作废检查：本条消息入链后被该 sender 的停止指令作废（代次已过期）→ 直接丢弃，不投递。
    // 串行链上停止前排队的其它消息由此被清掉，agent 不受干扰。
    if (generation < (this._deliverGeneration.get(sender) ?? 0)) {
      this.log?.info?.(`imessage: 丢弃停止后作废的排队消息 from ${sender}`);
      return null;
    }
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

    // iMessage 会话禁止 ask_user_question：提问卡片渲染在 Web GUI，iMessage 用户看不到，
    // 调用会挂起等一个永远不来的回答。per-agent restrict 只影响本会话，web 会话不受影响。
    // 每次投递都确保执行（live 复用/持久化恢复/新建都覆盖），agent 对象上挂标记幂等。
    if (agent && !agent.__askUserRestricted) {
      try {
        agent.ctx.tools.restrict({ deny: ["ask_user_question"] });
        agent.__askUserRestricted = true;
      } catch (e) {
        this.log?.warn?.(`imessage: 禁用 ask_user_question 失败: ${e instanceof Error ? e.message : e}`);
      }
    }

    // turn 级单步超时配置（dsh-turn-guard 读取）：从 settings 的 stepTimeoutSec 读值（单位秒），
    // 挂到 agent 上的通用扩展容器 __pluginConfig（不可枚举、不持久化、分区）。
    // 幂等：每次投递都挂（live 复用/恢复/新建都覆盖）；无配置不挂（turn-guard 不干预）。
    if (agent && !agent.__pluginConfig) {
      try {
        Object.defineProperty(agent, "__pluginConfig", {
          enumerable: false,
          writable: true,
          configurable: true,
          value: {},
        });
      } catch (e) {
        this.log?.warn?.(`imessage: 初始化 __pluginConfig 失败: ${e instanceof Error ? e.message : e}`);
      }
    }
    const stepSec = this.stepTimeoutSec > 0 ? this.stepTimeoutSec : 0;
    if (agent?.__pluginConfig) {
      if (stepSec > 0) agent.__pluginConfig.turnGuard = { stepSec };
      else delete agent.__pluginConfig.turnGuard; // 配置清零 → 不干预
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

    // 收到消息即开始 typing（keepalive 每 3s 续发，OpenClaw 同款机制）。
    this.startTyping(sender).catch(() => {});

    // 流式事件消费轮询：assistant 消息即时发送（typing 已由 keepalive 统一管理）。
    // 任一流式开关开启都需要轮询（streamReplies 发回复、toolCallReplies 发工具提示）。
    let streamPoller = null;
    if (this.streamReplies || this.toolCallReplies) {
      this._streamSeenSeq.set(agent.session.id, agent.session.snapshotEvents().at(-1)?.seq ?? 0);
      this._activeStreams.set(agent.session.id, { agent, sender });
      streamPoller = setInterval(() => this._syncStream(agent, sender), 200);
    }
    try {
      // 停止指令拦截：agent 正在运行时，整条消息规范化后精确命中停止词表 → 中断当前轮并回执，
      // 不投递、不排队（参考 OpenClaw /stop 语义：仅 busy 时拦截，空闲时当作普通消息）。
      if (agent?.status === "running" && this.isStopRequest(message)) {
        this.log?.info?.(`imessage: ${sender} 发送停止指令（${String(message).slice(0, 20)}），中断当前轮`);
        agent.cancel(new Error("user stop via imessage"));
        await this.send(sender, "⏹ 已停止");
        return null;
      }
      await agent.whenIdle();
      const firstSeq = agent.session.seq;
      // 入站消息时间戳注入：投递前加 `[周三 YYYY-MM-DD HH:MM UTC+8] ` 前缀（开关可配，默认开）。
      // 一次性打戳并随消息持久化——历史重放字节固定，prompt 缓存不受影响（OpenClaw issue #3658 同款结论）。
      const injectedText = this.injectTimestamp ? injectTimestampPrefix(message, this.userTimezone) : message;
      agent.followup(createUserMessage({
        content: [{ type: "text", text: injectedText }],
        source: { kind: "user" },
      }));
      await agent.whenIdle();
      await this.sessions.flush(agent.session);
      // 补扫一次：确保 turn 结束前产生的最后一条 assistant 消息也被即时发出。
      if (streamPoller !== null) this._syncStream(agent, sender);
      // 流式开启时所有回复已逐条发送，这里返回空避免调用方重复发送；
      // 关闭时返回最后一条完整回复文本（调用方统一发送）。
      // turn/end reason.kind === "max-tokens" 表示输出被 token 上限截断 → 追加截断提示。
      const { text, reason } = summarizeReply(agent.session.snapshotEvents(), firstSeq);
      const truncated = reason?.kind === "max-tokens";
      // 会话中断提示（2026-09-13 加，代码东要求）：turn 非正常结束（单步超时 / 被中断 /
      // 异常中止）时，回一条提示给【本会话的发送者】——就当正常对话的一部分，回给当前来源
      // 号码，不固定号码、不带具体单步。正常完成与 max-tokens（已有专门截断提示）不打扰。
      // "disposed" 是进程正在关闭，此时发送未必成功，但尝试无害（失败静默）。
      if (reason !== undefined && reason?.kind !== "completed" && reason?.kind !== "max-tokens") {
        const why = reason?.reason?.reason ?? reason?.reason?.kind ?? "";
        const detail = reason.kind === "aborted" && why ? `（${reason.kind}: ${why}）`
          : reason.kind === "interrupted" ? "（被中断）"
          : `（${reason.kind}）`;
        this.log?.warn?.(`imessage: ${sender} 会话中断 kind=${reason.kind}${why ? ` reason=${why}` : ""}，回送提示`);
        this.send(sender, `⚠️ 会话中断了${detail}。回复「继续」可以接着来。`).catch(() => {});
      }
      const reply = this.streamReplies ? null : (truncated && text ? `${text}\n\n${MAX_TOKENS_NOTICE}` : text);
      this.log?.info?.(`deliver 完成 id=${id} reply=${text?.length ?? 0}字 stream=${this.streamReplies}${truncated ? " truncated=max-tokens" : ""}${reason !== undefined && reason?.kind !== "completed" ? ` reason=${reason.kind}` : ""}`);
      return reply;
    } finally {
      if (streamPoller !== null) clearInterval(streamPoller);
      this._activeStreams.delete(agent.session.id);
      this._streamSeenSeq.delete(id);
      // 停止 typing：清 keepalive + 发送一次 stop。引用计数保证同一 sender
      // 并发 deliver 全部结束后才真正 stop（setTyping 内部自带能力检查）。
      await this.stopTyping(sender);
    }
  }

  /** 通过 RPC send 回复（真实发送）。plainText 开启时出口统一做 Markdown→纯文本清洗（两条发送链路都经过这里）。 */
  async send(to, text) {
    const payload = this.plainText ? sanitizeForIM(text) : text;
    const r = await this._rpc("send", { to, text: payload });
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
    if (/^streamReplies\s*:/.test(trimmed)) { cfg.streamReplies = trimmed.slice(trimmed.indexOf(":") + 1).trim() === "true"; continue; }
    if (/^toolCallReplies\s*:/.test(trimmed)) { cfg.toolCallReplies = trimmed.slice(trimmed.indexOf(":") + 1).trim() === "true"; continue; }
    if (/^plainText\s*:/.test(trimmed)) { cfg.plainText = trimmed.slice(trimmed.indexOf(":") + 1).trim() === "true"; continue; }
    if (/^injectTimestamp\s*:/.test(trimmed)) { cfg.injectTimestamp = trimmed.slice(trimmed.indexOf(":") + 1).trim() === "true"; continue; }
    if (/^userTimezone\s*:/.test(trimmed)) { cfg.userTimezone = trimmed.slice(trimmed.indexOf(":") + 1).trim().replace(/^["']|["']$/g, ""); continue; }
    if (/^stepTimeoutSec\s*:/.test(trimmed)) { cfg.stepTimeoutSec = Number(trimmed.slice(trimmed.indexOf(":") + 1).trim()); continue; }
    if (/^autoLaunch\s*:/.test(trimmed)) { cfg.autoLaunch = trimmed.slice(trimmed.indexOf(":") + 1).trim() === "true"; continue; }
    if (/^healthIntervalMin\s*:/.test(trimmed)) { cfg.healthIntervalMin = Number(trimmed.slice(trimmed.indexOf(":") + 1).trim().replace(/\s*#.*$/, "")); continue; }
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
