/**
 * dsh-imessage — client 半部分（浏览器 bundle，Typert Remote 版）
 *
 * 在 dsh Settings 页注册一个 `settings.section` 卡片，渲染 imessage 配置：
 * handle→workspace 路由表 + imsgCmd 命令 + autoReply 开关。
 *
 * 数据通路：Typert Remote Service —— host 注册 "imessageGateway" remote
 * service（getConfig/setConfig），client 通过 `ctx.remote.$mount` +
 * `ctx.get("remote.imessageGateway")` 调用。落盘在 settings.yaml 的
 * `imessage` 段，网关照常读取。
 *
 * 浏览器可直接执行（`__ModuleLoader__.load`），React.createElement 手写。
 */
window.__ModuleLoader__.load({
  id: "dsh-imessage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const S = require("react/jsx-runtime");

    // ── remote 贡献：声明 host remote service 的方法签名 ─────────────────────
    // client 边界只要求 parse()；服务端 MANIFEST 负责严格校验。
    const identity = (value) => value;
    const codec = (symbol) => ({ mode: "strict", typeSymbol: symbol, schema: { parse: identity } });

    const CONTRIBUTION = {
      package: "dsh-imessage",
      descriptors: [
        {
          id: "dsh-imessage#imessageGateway/getConfig",
          service: "imessageGateway",
          namespace: "imessageGateway",
          method: "getConfig",
          invocation: { kind: "direct" },
          parameters: [],
          result: codec("dsh-imessage#GatewayConfig")
        },
        {
          id: "dsh-imessage#imessageGateway/setConfig",
          service: "imessageGateway",
          namespace: "imessageGateway",
          method: "setConfig",
          invocation: { kind: "direct" },
          parameters: [
            { name: "payload", wire: "payload", source: "json", codec: codec("dsh-imessage#SetPayload") }
          ],
          result: codec("dsh-imessage#SetResult")
        }
      ]
    };

    /** 路由表的一行可编辑输入。 */
    function RouteRow({ handle, workspace, onChange, onRemove, disabled }) {
      return S.jsxs("div", {
        style: { display: "flex", gap: 8, alignItems: "center", marginBottom: 6 },
        children: [
          S.jsx("input", {
            style: { flex: "0 0 200px", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)" },
            placeholder: "iMessage handle，如 +8613800000000",
            value: handle,
            disabled,
            onChange: (e) => onChange("handle", e.target.value),
          }),
          S.jsx("input", {
            style: { flex: 1, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)" },
            placeholder: "工作区绝对路径，如 /Users/<you>/dsh/mayacode",
            value: workspace,
            disabled,
            onChange: (e) => onChange("workspace", e.target.value),
          }),
          S.jsx("button", {
            type: "button",
            disabled,
            onClick: onRemove,
            style: { padding: "4px 8px", color: "#c0392b", background: "none", border: "none", cursor: disabled ? "default" : "pointer" },
            children: "✕",
          }),
        ],
      });
    }

    /**
     * Settings section 主组件。
     * 数据经 props（getConfig/setConfig remote 调用）异步拉取 + 保存。
     */
    function GatewaySection(props) {
      const { getConfig, setConfig } = props;
      const [state, setState] = React.useState({ status: "loading", writable: true });
      const [rows, setRows] = React.useState([]);
      const [cmd, setCmd] = React.useState("");
      const [autoReply, setAutoReply] = React.useState(true);
      const [streamReplies, setStreamReplies] = React.useState(true);
      const [toolCallReplies, setToolCallReplies] = React.useState(true);
      const [saved, setSaved] = React.useState(false);
      const [loadTick, setLoadTick] = React.useState(0);

      // 初始加载：调 host remote 拉配置。
      React.useEffect(() => {
        let current = true;
        setState((prev) => (prev.status === "ready" ? prev : { status: "loading", writable: true }));
        Promise.resolve()
          .then(() => getConfig())
          .then((cfg) => {
            if (!current) return;
            const routes = cfg && cfg.routes ? cfg.routes : {};
            setRows(Object.entries(routes).map(([k, v]) => ({ handle: k, workspace: v })));
            setCmd(typeof cfg?.imsgCmd === "string" ? cfg.imsgCmd : "");
            if (typeof cfg?.autoReply === "boolean") setAutoReply(cfg.autoReply);
            if (typeof cfg?.streamReplies === "boolean") setStreamReplies(cfg.streamReplies);
            if (typeof cfg?.toolCallReplies === "boolean") setToolCallReplies(cfg.toolCallReplies);
            setState({ status: "ready", writable: cfg?.writable !== false });
          }, () => {
            if (current) setState({ status: "error", writable: true });
          });
        return () => { current = false; };
      }, [getConfig, loadTick]);

      const updateRow = (i, field, v) =>
        setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
      const removeRow = (i) => setRows((prev) => prev.filter((_, idx) => idx !== i));
      const addRow = () => setRows((prev) => [...prev, { handle: "", workspace: "" }]);

      const buildRoutes = () => {
        const out = {};
        for (const r of rows) {
          const h = String(r.handle ?? "").trim();
          const w = String(r.workspace ?? "").trim();
          if (h && w) out[h] = w;
        }
        return out;
      };

      const save = () => {
        const payload = { routes: buildRoutes(), autoReply, streamReplies, toolCallReplies };
        if (cmd.trim()) payload.imsgCmd = cmd.trim();
        else payload.clearImsgCmd = true;
        Promise.resolve()
          .then(() => setConfig(payload))
          .then(() => {
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          })
          .catch((e) => console.error("dsh-imessage save failed", e));
      };

      const discard = () => setLoadTick((t) => t + 1);
      const writable = state.writable;
      const count = rows.filter((r) => r.handle.trim() && r.workspace.trim()).length;

      if (state.status === "loading") {
        return S.jsx("p", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: "正在读取配置…" });
      }
      if (state.status === "error") {
        return S.jsxs("div", { children: [
          S.jsx("p", { style: { color: "var(--dsw-alias-state-error-primary)" }, children: "暂时无法读取配置。" }),
          S.jsx("button", { onClick: discard, style: { marginTop: 8, padding: "4px 10px" }, children: "重试" }),
        ] });
      }

      return S.jsxs("div", {
        style: { maxWidth: 640, fontFamily: "inherit", fontSize: 14, lineHeight: 1.6 },
        children: [
          S.jsx("p", {
            style: { color: "var(--dsw-alias-label-secondary)", margin: "0 0 12px" },
            children: `按 iMessage 发送者 handle 路由到不同工作区（共 ${count} 条）。存入 $DSH_HOME/settings.yaml 的 imessage 段。`,
          }),
          S.jsx("div", {
            children: [
              S.jsx("div", { style: { fontWeight: 500, marginBottom: 6 }, children: "路由表（handle → 工作区）" }),
              rows.map((r, i) =>
                S.jsx(RouteRow, {
                  handle: r.handle,
                  workspace: r.workspace,
                  disabled: !writable,
                  onChange: (field, v) => updateRow(i, field, v),
                  onRemove: () => removeRow(i),
                }, `row-${i}`),
              ),
              S.jsx("button", {
                type: "button",
                disabled: !writable,
                onClick: addRow,
                style: { margin: "6px 0", padding: "4px 10px", cursor: writable ? "pointer" : "default" },
                children: "+ 添加路由",
              }),
            ],
          }),
          S.jsx("div", {
            style: { marginTop: 16 },
            children: [
              S.jsx("div", { style: { fontWeight: 500, marginBottom: 6 }, children: "imsg 命令（不配置则直接执行 imsg）" }),
              S.jsx("input", {
                style: { width: "100%", padding: "4px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-divider, #ddd)" },
                placeholder: "如 sudo -u fatatalia imsg，或留空表示直接执行 imsg",
                value: cmd,
                disabled: !writable,
                onChange: (e) => setCmd(e.target.value),
              }),
            ],
          }),
          S.jsxs("label", {
            style: { marginTop: 16, display: "flex", alignItems: "center", gap: 8, cursor: writable ? "pointer" : "default" },
            children: [
              S.jsx("input", {
                type: "checkbox",
                checked: autoReply,
                disabled: !writable,
                onChange: (e) => setAutoReply(e.target.checked),
              }),
              S.jsx("span", { children: "自动回复（收到外部 iMessage 后自动路由并回复 sender）" }),
            ],
          }),
          S.jsxs("label", {
            style: { marginTop: 10, display: "flex", alignItems: "center", gap: 8, cursor: writable ? "pointer" : "default" },
            children: [
              S.jsx("input", {
                type: "checkbox",
                checked: streamReplies,
                disabled: !writable,
                onChange: (e) => setStreamReplies(e.target.checked),
              }),
              S.jsx("span", { children: "流式发送（处理过程中每条回复即时发出，不等全部完成）" }),
            ],
          }),
          S.jsxs("label", {
            style: { marginTop: 10, display: "flex", alignItems: "center", gap: 8, cursor: writable ? "pointer" : "default" },
            children: [
              S.jsx("input", {
                type: "checkbox",
                checked: toolCallReplies,
                disabled: !writable,
                onChange: (e) => setToolCallReplies(e.target.checked),
              }),
              S.jsx("span", { children: "工具执行提示（执行工具时即时发送 🔧 描述，如 bash 的 description）" }),
            ],
          }),
          S.jsxs("div", {
            style: { marginTop: 16, display: "flex", gap: 8 },
            children: [
              S.jsx("button", {
                type: "button",
                disabled: !writable,
                onClick: save,
                style: { padding: "6px 14px", borderRadius: 8, cursor: writable ? "pointer" : "default", fontWeight: 500 },
                children: saved ? "✓ 已保存" : "保存",
              }),
              S.jsx("button", {
                type: "button",
                disabled: !writable,
                onClick: discard,
                style: { padding: "6px 14px", borderRadius: 8, cursor: writable ? "pointer" : "default" },
                children: "放弃修改",
              }),
            ],
          }),
        ],
      });
    }

    /** 需要 slots（注册设置项）+ remote（调用 host remote service）。 */
    const inject = ["slots", "remote"];

    function apply(ctx) {
      // 挂载远程贡献，所有 remote 调用等待挂载完成。
      const mount = ctx.remote.$mount(CONTRIBUTION);
      const callRemote = async (method, ...args) => {
        await mount;
        const remote = ctx.get("remote.imessageGateway");
        if (remote === void 0) throw new Error("remote.imessageGateway 不可用");
        const result = await remote[method](...args);
        if (!result || !result.ok) {
          throw new Error(`imessageGateway.${method} failed: ${result?.error?.code ?? "?"}: ${result?.error?.message ?? "?"}`);
        }
        return result.value;
      };
      const getConfig = () => callRemote("getConfig");
      const setConfig = (payload) => callRemote("setConfig", payload);

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "imessage",
            order: 20,
            label: () => "iMessage 网关",
            inject: () => ({ getConfig, setConfig }),
          },
          GatewaySection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
