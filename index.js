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

// 需要 typert/settings（配置 remote）+ agents/agentPresets/workspaceRegistry/sessionPersistence/sessionTitle/tools（网关投递+归属+标题+message工具）。
export const inject = ["typert", "settings", "agents", "agentDefaultModel", "agentPresets", "sessions", "workspaceRegistry", "sessionPersistence", "sessionTitle", "tools"];

// 插件自身 config schema（settingsPath 指向 $DSH_HOME/settings.yaml；statePath 存 sender→会话映射）。
// 默认值基于 homedir() 推导，不写死个人路径。
export const Config = z.object({
  settingsPath: z.string().default(join(homedir(), ".dsh", "settings.yaml")),
  statePath: z.string().default(join(homedir(), ".dsh", "imessage-gateway-state.json")),
});

/** `imessage` settings namespace 数据 schema：路由表 + imsgCmd + autoReply + streamReplies。 */
const GatewaySchema = z.object({
  routes: z.dict(z.string()),
  imsgCmd: z.string().required(),
  autoReply: z.boolean(),
  streamReplies: z.boolean(),
});

// ── Typert wire schemas ───────────────────────────────────────────────────
// Typert 要求 codec.schema 是带 `parse(value)` 的对象。这里手工构造
// parse（宽松校验），避免引入 zod 依赖；client 端已做基本校验兜底。
function parseObj() {
  return {
    parse(value) {
      if (typeof value !== "object" || value === null) throw new Error("expected object");
      return value;
    },
  };
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
      result: { mode: "strict", typeSymbol: "dsh-imessage#GatewayConfig", schema: getResultSchema },
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
          codec: { mode: "strict", typeSymbol: "dsh-imessage#SetPayload", schema: setPayloadSchema },
        },
      ],
      result: { mode: "strict", typeSymbol: "dsh-imessage#SetResult", schema: setResultSchema },
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
    return { routes, imsgCmd, autoReply, streamReplies, writable: true };
  }

  /** 写入配置（稀疏合并）到 settings.yaml 的 imessage 用户层。 */
  async setConfig(payload) {
    const patch = {};
    if (payload?.routes && typeof payload.routes === "object") patch.routes = payload.routes;
    if (payload?.clearImsgCmd) patch.imsgCmd = "";
    else if (typeof payload?.imsgCmd === "string") patch.imsgCmd = payload.imsgCmd;
    if (typeof payload?.autoReply === "boolean") patch.autoReply = payload.autoReply;
    if (typeof payload?.streamReplies === "boolean") patch.streamReplies = payload.streamReplies;
    if (Object.keys(patch).length === 0) return { ok: true };
    await this.scope.update(patch);
    return { ok: true };
  }
}

export function apply(ctx, config) {
  // 注册 schema + 拿 scope（host 侧读写，落盘 settings.yaml）。
  const scope = ctx.settings.register("imessage", GatewaySchema, {
    base: {
      routes: { "+8613800000000": join(homedir(), "dsh", "mayacode") },
      imsgCmd: "imsg",
      autoReply: true,
    },
  });
  // 配置 remote（配置页读写）
  new GatewayService(ctx, scope);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-imessage: typert manifest");

  // 启动 iMessage 网关监听（RPC watch.subscribe + 投递 + 自动回复）。
  // 孤儿：作为 host 插件创建，随 web 进程生命周期启停。
  const Logger = ctx.logger;
  const ts = () => new Date().toISOString();
  const log = {
    info: (m) => { console.log(`[${ts()}] [im] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[${ts()}] [im:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[${ts()}] [im:err] ${m}`); try { Logger?.error?.(m); } catch {} },
    debug: (m) => { try { Logger?.debug?.(m); } catch {} },
  };
  log.info("GatewayCore 创建，依赖注入完成（agents/sessions/defaultModel/agentPresets）");
  const core = new GatewayCore({
    agents: ctx.get("agents"),
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
  ctx.on("dispose", () => core.stopListener());
  core.startListener().then(() => log.info("网关监听已启动")).catch((e) => log.error(`启动监听失败 ${e instanceof Error ? e.message : e}`));

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
