/**
 * @doiiarx/dsh-todo-continuation —— 浏览器设置页（Todo 门禁小节）。
 * 与 @doiiarx/dsh-user-language 的 client.js 同一套加载模式：
 * `window.__ModuleLoader__.load` 注册浏览器端插件，绑定 `todo-continuation`
 * settings 命名空间，在设置页渲染三个可编辑字段。保存后宿主端下一轮
 * turn-stopping 即按新值生效，无需重启。
 */
window.__ModuleLoader__.load({
  id: "@doiiarx/dsh-todo-continuation",
  factory: (require) => {
    const React = require("react");
    const inject = ["slots", "configForms", "connection", "remote"];
    const h = React.createElement;

    const NAMESPACE = "todo-continuation";
    // 计数单位是 step（一次模型调用）：本机一轮约 16 个 step，64 步≈4 轮。
    const DEFAULT_NO_TODO_STEPS = 64;
    const DEFAULT_STALE_STEPS = 256;

    function numberValue(value, fallback) {
      return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
    }

    function TodoContinuationSettings({ scope }) {
      const snapshot = React.useSyncExternalStore(
        (fn) => scope.subscribe(fn),
        () => scope.getSnapshot(),
      );
      const value = snapshot.value;
      // 'unavailable' 表示宿主没把这个 namespace 暴露给客户端（entry 不在
      // describe 里，通常因为 Config 缺少 volatile），与仍在加载区分开。
      const unavailable = snapshot.status === "unavailable";
      const busy = snapshot.status !== "ready" || value === undefined;
      const current = {
        noTodo: numberValue(value?.noTodoPromptEveryNSteps, DEFAULT_NO_TODO_STEPS),
        stale: numberValue(value?.staleTodoPromptEveryNSteps, DEFAULT_STALE_STEPS),
        prefixes: Array.isArray(value?.waitingTodoPrefixes)
          ? value.waitingTodoPrefixes.join("\n")
          : "",
      };

      const numberField = (label, desc, field, currentValue) => h("label", {
        "data-settings-item": field,
        style: {
          display: "grid", gap: "8px", padding: "18px",
          border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px",
          background: "var(--dsw-alias-bg-layer-1)",
        },
      },
        h("strong", null, label),
        h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } }, desc),
        h("input", {
          type: "number", min: 1, step: 1,
          value: currentValue,
          disabled: !snapshot.writable,
          style: {
            height: "38px", padding: "0 11px", width: "140px",
            border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
            color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)",
            font: "inherit",
          },
          onChange: (event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (Number.isSafeInteger(parsed) && parsed >= 1) void scope.set(field, parsed);
          },
        }),
      );

      return h("div", { style: { display: "grid", gap: "18px", color: "var(--dsw-alias-label-primary)" } },
        h("div", null,
          h("h2", { style: { margin: "0 0 6px" } }, "Todo 门禁"),
          h("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } },
            "控制模型使用 Todo 列表的方式：未完成工作不放行结束，长期不用或不更新 Todo 列表时给出建议性提示。")
        ),
        unavailable ? h("p", { style: { color: "var(--dsw-alias-label-secondary)" } }, "宿主未暴露本设置：插件 Config 缺少 volatile 元数据，或插件未处于活动状态。")
          : busy ? h("p", { style: { color: "var(--dsw-alias-label-secondary)" } }, "正在读取配置…")
          : h(React.Fragment, null,
            numberField("无 Todo 提示间隔（步）", "连续多少个 step（一次模型调用）没有任何 Todo 后，提示模型开始用 Todo 管理任务。", "noTodoPromptEveryNSteps", current.noTodo),
            numberField("过期 Todo 提示间隔（步）", "已有 Todo 列表却连续多少个 step 不更新后，提示模型保持列表最新。", "staleTodoPromptEveryNSteps", current.stale),
            h("label", {
              "data-settings-item": "waitingTodoPrefixes",
              style: {
                display: "grid", gap: "8px", padding: "18px",
                border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "14px",
                background: "var(--dsw-alias-bg-layer-1)",
              },
            },
              h("strong", null, "等待用户前缀"),
              h("small", { style: { color: "var(--dsw-alias-label-tertiary)" } },
                "每行一个前缀。未完成项以这些前缀开头时视为「等待用户」，允许结束。"),
              h("textarea", {
                value: current.prefixes,
                disabled: !snapshot.writable,
                rows: 3,
                placeholder: "信息不足：\n要求用户确认：",
                style: {
                  padding: "11px",
                  border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "10px",
                  color: "var(--dsw-alias-label-primary)", background: "var(--dsw-specific-input-major)",
                  font: "inherit", resize: "vertical",
                },
                onChange: (event) => {
                  const prefixes = event.target.value.split("\n").map(s => s.trim()).filter(Boolean);
                  void scope.set("waitingTodoPrefixes", prefixes.length > 0 ? prefixes : []);
                },
              }),
            ),
          ),
      );
    }

    function apply(ctx) {
      const scope = ctx.configForms.get(NAMESPACE);
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({
          name: "settings.section",
          id: NAMESPACE,
          order: 140,
          label: "Todo 门禁",
          inject: () => ({ scope }),
        }, TodoContinuationSettings),
      );
      const search = (globalThis.__DSH_SETTINGS_SEARCH__ ??= {
        sections: new Map(),
        register(sectionId, spec) {
          this.sections.set(sectionId, spec);
          return () => { this.sections.delete(sectionId) };
        },
      });
      search.register(NAMESPACE, {
        label: "Todo 门禁",
        keywords: "todo 待办 任务 列表 门禁 提示 过期 更新",
        items: [
          { id: "noTodoPromptEveryNSteps", label: "无 Todo 提示间隔", desc: "连续无 Todo 的步数后提示", keywords: "todo 待办 提示 间隔 步" },
          { id: "staleTodoPromptEveryNSteps", label: "过期 Todo 提示间隔", desc: "Todo 不更新的步数后提示", keywords: "todo 待办 过期 更新 间隔 步" },
          { id: "waitingTodoPrefixes", label: "等待用户前缀", desc: "视为等待用户的前缀", keywords: "等待 用户 前缀 确认" },
        ],
      });
    }

    return { inject, apply };
  },
});
