/**
 * dsh-imessage — host 半部分（Typert Remote Service 版）
 *
 * iMessage 收发完整接入 dsh：RPC 监听入站、按 handle 路由工作区、agent 处理
 * 自动回复、配置页（Typert remote）、全局 message 出站工具。随 dsh web 启停，
 * 零 dsh 框架改动。
 *
 * 数据落盘：$DSH_HOME/settings.yaml 的 `imessage` 段（routes/imsgCmd/autoReply）
 * 与 $DSH_HOME/imessage-gateway-state.json（sender→会话映射，归档迁移用）。
 * client 通过 Typert remote `imessageGateway`（getConfig/setConfig）读写配置。
 */
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatewayCore, splitCmd } from "./lib/gateway-core.mjs";

export const name = "dsh-imessage";

// 需要 typert（配置 remote）+ agents/agentPresets/workspaceRegistry/sessionPersistence/sessionTitle/tools（网关投递+归属+标题+message工具）。
export const inject = ["typert", "agents", "agentDefaultModel", "agentPresets", "sessions", "workspaceRegistry", "sessionPersistence", "sessionTitle", "tools"];

// 插件自身 config schema（settingsPath 指向 $DSH_HOME/settings.yaml；statePath 存 sender→会话映射）。
// 默认值基于 homedir() 推导，不写死个人路径。
//
// 2026-09-24 适配 dsh 0.1.7：ctx.settings.register() 已移除，原 `imessage`
// settings namespace 并入插件 Config；.volatile() 字段可在设置页热改，改动由
// loader 提交进运行中的引用并广播 loader/volatile-update。
export const Config = z.object({
  settingsPath: z.string().default(join(homedir(), ".dsh", "settings.yaml")),
  statePath: z.string().default(join(homedir(), ".dsh", "imessage-gateway-state.json")),
  /** 路由表：handle → 工作区路径。 */
  routes: z.dict(z.string()).default({}).volatile(),
  /** imsg CLI 调用前缀（可为 sudo 包装）。 */
  imsgCmd: z.string().default("imsg").volatile(),
  autoReply: z.boolean().default(true).volatile(),
  streamReplies: z.boolean().volatile(),
  toolCallReplies: z.boolean().volatile(),
  /** 压缩事件通知开关：上下文被压缩时提示"正在压缩"与压缩结果（含失败原因）。默认开。 */
  compactionNotice: z.boolean().volatile(),
  /** 纯文本清洗开关：iMessage 不支持 Markdown，开启后 send() 出口统一转纯文本。 */
  plainText: z.boolean().volatile(),
  /** 入站消息时间戳注入开关：投递用户消息前加 `[周三 YYYY-MM-DD HH:MM UTC+8] ` 前缀，让模型感知当前时间。默认开。 */
  injectTimestamp: z.boolean().volatile(),
  /** 时间戳时区（IANA 名）：显式配置不读系统时区。默认 Asia/Shanghai。 */
  userTimezone: z.string().volatile(),
  /** turn 级单步超时（秒）：step 超过该时长被 dsh-turn-guard 强制 cancel；不配/0 = 不限制。 */
  stepTimeoutSec: z.number().volatile(),
  /** 停止指令关键词表：agent 忙碌时整条精确匹配这些词即中断当前轮；不配 = 默认多语言表（见 DEFAULT_STOP_KEYWORDS）。 */
  stopKeywords: z.array(z.string()).volatile(),
  /** 注入自愈开关：开启后启动时 + 每 healthIntervalMin 分钟检查 imsg 注入，异常自动 launch 恢复；关闭则不检查也不 launch。 */
  autoLaunch: z.boolean().default(true).volatile(),
  /** 注入健康检查间隔（分钟，1-60）：autoLaunch 开启时的检查周期。 */
  healthIntervalMin: z.number().default(5).volatile(),
});

// ── Typert wire schemas ───────────────────────────────────────────────────
// Typert 要求 codec.schema 是带 `parse(value)` 的对象。这里手工构造
// parse（宽松校验），避免引入 zod 依赖；client 端已做基本校验兜底。
function parseObj() {
  // 0.1.7：typert strict codec 必须有 create() 工厂（gateway 走 codec.create().parse(v)）。
  const parse = (value) => {
    if (typeof value !== "object" || value === null) throw new Error("expected object");
    return value;
  };
  return { parse, create: () => ({ parse }) };
}
const getResultSchema = parseObj();
const setPayloadSchema = parseObj();
const setResultSchema = parseObj();

/** 注册给 API gateway 的远程方法清单（Typert MANIFEST）。 */
const MANIFEST = {
  package: "dsh-imessage",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-imessage#imessageGateway/getConfig",
      service: "imessageGateway",
      namespace: "imessageGateway",
      method: "getConfig",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-imessage#GatewayConfig", schema: getResultSchema, create: () => getResultSchema },
    },
    {
      id: "dsh-imessage#imessageGateway/setConfig",
      service: "imessageGateway",
      namespace: "imessageGateway",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "payload",
          wire: "payload",
          source: "json",
          codec: { mode: "strict", typeSymbol: "dsh-imessage#SetPayload", schema: setPayloadSchema, create: () => setPayloadSchema },
        },
      ],
      result: { mode: "strict", typeSymbol: "dsh-imessage#SetResult", schema: setResultSchema, create: () => setResultSchema },
    },
  ],
  model: { services: [], events: [], objects: [] },
};

/** Remote service 实现：读写 imessage 配置（落盘 settings.yaml）。 */
class GatewayService extends TypertRemoteService {
  constructor(ctx, scope) {
    super(ctx, "imessageGateway");
    this.scope = scope;
  }

  /** 返回当前 resolved 配置 + 可写标记。 */
  getConfig() {
    const snap = this.scope.get();
    const routes = snap?.routes && typeof snap.routes === "object" ? snap.routes : {};
    const imsgCmd = typeof snap?.imsgCmd === "string" ? snap.imsgCmd : "";
    const autoReply = snap?.autoReply !== false;
    const streamReplies = snap?.streamReplies !== false;
    const toolCallReplies = snap?.toolCallReplies !== false;
    const compactionNotice = snap?.compactionNotice !== false;
    const plainText = snap?.plainText !== false;
    const injectTimestamp = snap?.injectTimestamp !== false;
    const userTimezone = typeof snap?.userTimezone === "string" && snap.userTimezone.trim() ? snap.userTimezone.trim() : "Asia/Shanghai";
    const stepTimeoutSec = typeof snap?.stepTimeoutSec === "number" && snap.stepTimeoutSec > 0 ? snap.stepTimeoutSec : 0;
    const stopKeywords = Array.isArray(snap?.stopKeywords) ? snap.stopKeywords : undefined;
    const autoLaunch = snap?.autoLaunch !== false;
    const healthIntervalMin = typeof snap?.healthIntervalMin === "number" && snap.healthIntervalMin >= 1
      ? Math.min(Math.floor(snap.healthIntervalMin), 60) : 5;
    return { routes, imsgCmd, autoReply, streamReplies, toolCallReplies, compactionNotice, plainText, injectTimestamp, userTimezone, stepTimeoutSec, stopKeywords, autoLaunch, healthIntervalMin, writable: true };
  }

  /** 写入配置到 settings.yaml 的 imessage 用户层。
   * 用 replace（整体替换）而非 update（merge）：settings 的 update 是递归深合并，
   * patch 里缺失的键（如被删除的路由）会保留旧值——用户删路由后保存不生效。
   * client 保存总是传完整状态（routes 全表 + 各开关），replace 语义正确。
   */
  async setConfig(payload) {
    const current = this.scope.get() ?? {};
    const routes = payload?.routes && typeof payload.routes === "object"
      ? payload.routes
      : current.routes && typeof current.routes === "object" ? current.routes : {};
    const imsgCmd = payload?.clearImsgCmd
      ? ""
      : typeof payload?.imsgCmd === "string" ? payload.imsgCmd : typeof current.imsgCmd === "string" ? current.imsgCmd : "imsg";
    const autoReply = typeof payload?.autoReply === "boolean" ? payload.autoReply : current.autoReply !== false;
    const streamReplies = typeof payload?.streamReplies === "boolean" ? payload.streamReplies : current.streamReplies !== false;
    const toolCallReplies = typeof payload?.toolCallReplies === "boolean" ? payload.toolCallReplies : current.toolCallReplies !== false;
    const compactionNotice = typeof payload?.compactionNotice === "boolean" ? payload.compactionNotice : current.compactionNotice !== false;
    const plainText = typeof payload?.plainText === "boolean" ? payload.plainText : current.plainText !== false;
    const injectTimestamp = typeof payload?.injectTimestamp === "boolean" ? payload.injectTimestamp : current.injectTimestamp !== false;
    const userTimezone = typeof payload?.userTimezone === "string" && payload.userTimezone.trim()
      ? payload.userTimezone.trim()
      : typeof current?.userTimezone === "string" && current.userTimezone.trim() ? current.userTimezone.trim() : "Asia/Shanghai";
    const stepTimeoutSec = typeof payload?.stepTimeoutSec === "number" && payload.stepTimeoutSec > 0 ? payload.stepTimeoutSec : 0;
    const stopKeywords = Array.isArray(payload?.stopKeywords)
      ? payload.stopKeywords
      : Array.isArray(current?.stopKeywords) ? current.stopKeywords : undefined;
    const autoLaunch = typeof payload?.autoLaunch === "boolean" ? payload.autoLaunch : current.autoLaunch !== false;
    const healthIntervalMin = typeof payload?.healthIntervalMin === "number" && payload.healthIntervalMin >= 1
      ? Math.min(Math.floor(payload.healthIntervalMin), 60) : 5;
    const section = { routes, imsgCmd, autoReply, streamReplies, toolCallReplies, compactionNotice, plainText, injectTimestamp, userTimezone, stepTimeoutSec, ...(stopKeywords ? { stopKeywords } : {}), autoLaunch, healthIntervalMin };
    try { console.log(`[${new Date().toLocaleString("zh-CN", { hour12: false })}] [im] setConfig: replace section=${JSON.stringify(section).slice(0, 240)}`); } catch { /* ignore */ }
    await this.scope.replace(section);
    return { ok: true };
  }
}

export function apply(ctx, config) {
  // 注册 schema + 拿 scope（host 侧读写，落盘 settings.yaml）。
  // base 只放中性默认值：routes 不能硬编码具体号码（base+user 合并会让删除的路由
  // 又回来——"删路由不生效"的根因），业务路由全部走 user 层。
  // 0.1.7：配置即插件 Config 的 volatile 字段，这里适配出等价的 scope 外壳。
  const scope = {
    get: () => ({
      routes: config.routes.get(),
      imsgCmd: config.imsgCmd.get(),
      autoReply: config.autoReply.get(),
      streamReplies: config.streamReplies.get(),
      toolCallReplies: config.toolCallReplies.get(),
      compactionNotice: config.compactionNotice.get(),
      plainText: config.plainText.get(),
      injectTimestamp: config.injectTimestamp.get(),
      userTimezone: config.userTimezone.get(),
      stepTimeoutSec: config.stepTimeoutSec.get(),
      stopKeywords: config.stopKeywords.get(),
      autoLaunch: config.autoLaunch.get(),
      healthIntervalMin: config.healthIntervalMin.get(),
    }),
    async update(patch) {
      const editor = ctx.get("configEditor");
      const entry = ctx.fiber?.entry;
      if (!editor || entry === undefined) return;
      await editor.edit(entry, (current) => ({ ...current, ...patch }));
    },
    watch(cb) {
      ctx.on("loader/volatile-update", () => { cb(scope.get()); });
    },
  };
  // 配置 remote（配置页读写）
  new GatewayService(ctx, scope);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-imessage: typert manifest");

  // 启动 iMessage 网关监听（RPC watch.subscribe + 投递 + 自动回复）。
  // 孤儿：作为 host 插件创建，随 web 进程生命周期启停。
  const Logger = ctx.logger;  // 本地时间戳（时区跟随系统，如 Asia/Shanghai +08）。曾用 toISOString() 输出 UTC，
  // 本地 16:xx 显示 08:xxZ 造成误解。
  const ts = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const log = {
    info: (m) => { console.log(`[${ts()}] [im] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [im:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[${ts()}] [im:err] ${m}`); try { Logger?.error?.(m); } catch {} },
    debug: (m) => { try { Logger?.debug?.(m); } catch {} },
  };
  log.info("GatewayCore 创建，依赖注入完成（agents/sessions/defaultModel/agentPresets）");
  // 0.1.5 起 agents.create/resume 需要 ownerCtx 第一参（0.1.2 为单参 options）。
  // 按函数形参个数探测，双版本兼容：0.1.2 直接透传，0.1.5 包装补 ctx。
  const agentsSvc = ctx.get("agents");
  const agents = agentsSvc.create.length >= 2
    ? {
        get: (id) => agentsSvc.get(id),
        create: (options) => agentsSvc.create(ctx, options),
        resume: (options) => agentsSvc.resume(ctx, options),
      }
    : agentsSvc;
  const core = new GatewayCore({
    agents,
    defaultModel: ctx.get("agentDefaultModel"),
    sessions: ctx.get("sessions"),
    agentPresets: ctx.get("agentPresets"),
    workspaceRegistry: ctx.get("workspaceRegistry"),
    sessionPersistence: ctx.get("sessionPersistence"),
    sessionTitle: ctx.get("sessionTitle"),
    log,
    settingsPath: config.settingsPath,
    statePath: config.statePath,
  });
  // ── 0.1.7 修复：必须显式喂一次初始配置 ──────────────────────────────────
  // 配置来源已从 settings.yaml 文本改为插件 Config 的 volatile 字段，
  // 但 GatewayCore 的构造函数仍带着旧默认值（toolCallReplies = true 等）。
  // 而下面的 scope.watch 只是在 ctx.on("loader/volatile-update") 上注册回调，
  // **启动时不会触发** —— 少了这一步，进程每次重启都会退回默认值，
  // 表现为「设置页关掉工具执行提示 → 当场生效 → 一重启又开始发」。
  // （旧路径 loadConfig() 读 settingsPath，而该文件在 0.1.7 已改名为
  //   settings.yaml.imported，readFile 抛 ENOENT 被 catch 吞掉，形同虚设。）
  core.applyConfig(scope.get());
  log.info(`配置已初始化: routes=${Object.keys(core.routes).length}条 autoReply=${core.autoReply} streamReplies=${core.streamReplies} toolCallReplies=${core.toolCallReplies} compactionNotice=${core.compactionNotice}`);
  ctx.on("dispose", () => core.stopListener());
  core.startListener().then(() => log.info("网关监听已启动")).catch((e) => log.error(`启动监听失败 ${e instanceof Error ? e.message : e}`));

  // 软依赖：注册退出前检查（dsh-shutdown-hook 统一调度）。进程退出前等投递链清空，
  // 保证重启/停止时未完成的 iMessage 投递不丢失（框架强制，不依赖模型自觉）。
  // shutdown-hook 是独立插件，不强制绑定：服务存在则注册，不存在则跳过（退回无屏障原行为），
  // 服务延迟加载/重载时通过 internal/service 事件补注册。
  let drainRegistered = false;
  const registerDrain = (barrier) => {
    if (drainRegistered || !barrier) return;
    barrier.register("imessage-drain", () => core.drain(), { timeoutMs: 5000 });
    drainRegistered = true;
    log.info("已注册退出前检查: imessage-drain（投递链清空）");
  };
  registerDrain(ctx.get("shutdownHook"));
  ctx.on("internal/service", (name, value) => {
    if (name !== "shutdownHook") return;
    if (value) registerDrain(value);
    else drainRegistered = false; // 服务被注销：允许下次重新注册
  });

  // 配置热更新：配置页保存后立即推给运行中的网关（autoReply/streamReplies/toolCallReplies/compactionNotice），无需重启。
  scope.watch((next) => {
    core.applyConfig(next);
    log.info(`配置热更新: routes=${Object.keys(core.routes).length}条 autoReply=${core.autoReply} streamReplies=${core.streamReplies} toolCallReplies=${core.toolCallReplies} compactionNotice=${core.compactionNotice}`);
  });

  // 注册全局 `message` 工具：任何 agent（含心跳会话）可调用它发 iMessage。
  // 职责归 dsh-imessage 插件；心跳只触发，调用的还是这个工具。
  const messageTool = defineTool({
    name: "message",
    description: "通过 iMessage 向联系人发送一条文本消息。用于主动通知/提醒用户（例如心跳检查发现的异常、日程提醒、早安问候）。仅在确有需要时调用。",
    parameters: {
      action: { type: "string", required: true, description: "操作类型，目前仅支持 send" },
      channel: { type: "string", required: true, description: "发送渠道，目前仅支持 imessage" },
      target: { type: "string", required: true, description: "目标联系人 handle（号码如 +8613800000000 或 email）" },
      message: { type: "string", required: true, description: "要发送的文本内容" },
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
      render(args, value) {
        const target = (typeof args === "object" && args !== null && typeof args.target === "string") ? args.target : "?";
        return [{ type: "text", text: value.ok ? `已发送到 ${target}` : "发送失败" }];
      },
    },
    async execute(args) {
      let a = args;
      if (typeof args === "string") { try { a = JSON.parse(args); } catch { return { ok: false }; } }
      const action = a?.action ?? "send";
      const channel = a?.channel ?? "imessage";
      const target = a?.target;
      const text = a?.message;
      if (action !== "send" || channel !== "imessage" || !target || !text) return { ok: false };
      try {
        await core.send(target, text);
        log.info(`message 工具已发送到 ${target}: ${String(text).slice(0, 40)}`);
        return { ok: true };
      } catch (e) {
        log.error(`message 工具发送失败: ${e instanceof Error ? e.message : e}`);
        return { ok: false };
      }
    },
  });
  ctx.tools.register(messageTool);
  log.info("已注册全局 message 工具（iMessage 发送）");
}
