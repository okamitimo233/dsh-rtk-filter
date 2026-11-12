window.__ModuleLoader__.load({
  id: "@rtk-ai/dsh-rtk-filter",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");

    const h = React.createElement;
    const NS = "settings.rtkFilter";
    const STATUS_PATH = "rtk-filter/status";
    const RANGE_OPTIONS = [7, 30];

    const zh = {
      nav: "RTK 命令过滤",
      statusTab: "状态",
      settingsTab: "设置",
      statusTitle: "RTK 运行状态",
      statusDescription: "Bash 输出由 RTK 自动压缩。以下数据来自本机 RTK 历史记录。",
      runtimeReady: "运行中",
      runtimeInstalling: "准备中",
      runtimeUnavailable: "不可用",
      versionUnknown: "版本未知",
      sourceManaged: "托管版本",
      sourcePath: "PATH 版本",
      sourceExplicit: "自定义版本",
      updatedAt: "更新于 {time}",
      calls: "调用次数",
      callsHint: "RTK 已处理的命令",
      saved: "节省 Token",
      savedHint: "压缩后少发送的 Token",
      rate: "Token 节省率",
      rateHint: "已节省 Token 占原始输出 Token 的比例",
      perCall: "平均每次节省",
      perCallHint: "每个 RTK 调用的平均值",
      trend: "节省趋势",
      days7: "近 7 天",
      days30: "近 30 天",
      chartAria: "近 {days} 天，共调用 {calls} 次，节省 {tokens} Token",
      chartTooltip: "{date} · {calls} 次 · 节省 {tokens} Token",
      noDataTitle: "还没有 RTK 调用记录",
      noDataDescription: "下一次经过 RTK 的 bash 调用之后，这里会出现节省趋势。",
      errorTitle: "暂时无法读取状态",
      errorDescription: "RTK 历史记录或状态接口当前不可用，请稍后重试。",
      statsError: "状态已连上，但 RTK 历史数据读取失败。",
      retry: "重试",
      loading: "读取中…",
      refreshing: "刷新中…",
      refresh: "刷新",
      settingsPlaceholderTitle: "设置项即将到来",
      settingsPlaceholderDescription: "这里会集中放置 RTK 过滤器的可调选项。当前版本无需额外设置，插件参数仍可通过 profile 配置调整。",
      settingsBadge: "即将推出",
    };

    const en = {
      nav: "RTK command filtering",
      statusTab: "Status",
      settingsTab: "Settings",
      statusTitle: "RTK runtime status",
      statusDescription: "Bash output is compressed by RTK. These numbers come from RTK's local history.",
      runtimeReady: "Running",
      runtimeInstalling: "Preparing",
      runtimeUnavailable: "Unavailable",
      versionUnknown: "Version unknown",
      sourceManaged: "Managed build",
      sourcePath: "PATH build",
      sourceExplicit: "Custom build",
      updatedAt: "Updated {time}",
      calls: "Calls",
      callsHint: "Commands handled by RTK",
      saved: "Tokens saved",
      savedHint: "Tokens kept out of the model context",
      rate: "Token savings rate",
      rateHint: "Saved tokens as a percentage of raw output tokens",
      perCall: "Saved per call",
      perCallHint: "Average across RTK calls",
      trend: "Savings trend",
      days7: "Last 7 days",
      days30: "Last 30 days",
      chartAria: "Last {days} days: {calls} calls and {tokens} tokens saved",
      chartTooltip: "{date} · {calls} calls · {tokens} tokens saved",
      noDataTitle: "No RTK activity yet",
      noDataDescription: "The savings trend appears after the next bash call that goes through RTK.",
      errorTitle: "Status is unavailable",
      errorDescription: "RTK history or the status endpoint is unavailable right now. Try again shortly.",
      statsError: "The status endpoint answered, but RTK history could not be read.",
      retry: "Retry",
      loading: "Loading…",
      refreshing: "Refreshing…",
      refresh: "Refresh",
      settingsPlaceholderTitle: "Settings are coming",
      settingsPlaceholderDescription: "This is where configurable RTK filter options will live. Nothing needs tuning today; plugin parameters remain available through profile configuration.",
      settingsBadge: "Coming soon",
    };

    const dictionaries = { zh, en };

    const css = `
.rtk-root{display:flex;flex-direction:column;gap:14px;min-height:100%;color:var(--dsw-alias-label-primary,#202124);font-size:13px;line-height:1.5}
.rtk-topbar{display:flex;align-items:center;gap:14px;min-width:0;padding:5px 7px 5px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.035))}
.rtk-topbar-title{flex:none;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:11px;font-weight:600;letter-spacing:.03em;white-space:nowrap}
.rtk-tabs{display:flex;align-items:center;gap:3px;min-width:0;overflow-x:auto}
.rtk-nav-button{display:flex;align-items:center;gap:7px;flex:none;padding:7px 11px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#555b63);font:inherit;text-align:center;white-space:nowrap;cursor:pointer;transition:background .15s ease,color .15s ease}
.rtk-nav-button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09));color:var(--dsw-alias-label-primary,#202124)}
.rtk-nav-button[aria-current="page"]{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(79,124,240,.12));color:var(--dsw-alias-label-primary,#202124);font-weight:600}
.rtk-nav-icon{display:inline-flex;flex:none;opacity:.9}
.rtk-content{display:flex;flex-direction:column;gap:14px;min-width:0}
.rtk-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:16px 18px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(127,127,127,.16)));border-radius:14px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,transparent))}
.rtk-hero-main{display:flex;align-items:flex-start;gap:12px;min-width:0}
.rtk-mark{display:flex;align-items:center;justify-content:center;width:36px;height:36px;flex:none;border-radius:10px;background:linear-gradient(145deg,var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d7df3),var(--dsw-alias-state-business-primary,#7757e8));color:#fff;box-shadow:0 4px 14px rgba(77,125,243,.22)}
.rtk-hero h2{margin:0;font-size:15px;line-height:1.35;font-weight:650}
.rtk-hero p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary,#858b94);font-size:12px}
.rtk-badge{display:inline-flex;align-items:center;gap:6px;flex:none;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
.rtk-badge-dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.rtk-badge.ready{color:var(--dsw-alias-state-success-primary,#188746);background:rgba(24,135,70,.1)}
.rtk-badge.installing{color:var(--dsw-alias-state-warn-label,#a66a00);background:rgba(166,106,0,.1)}
.rtk-badge.unavailable{color:var(--dsw-alias-state-error-primary,#c53b3b);background:rgba(197,59,59,.1)}
.rtk-runtime-meta{margin-top:7px;color:var(--dsw-alias-label-tertiary,#858b94);font-size:11px}
.rtk-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.rtk-kpi{padding:13px 14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16));border-radius:12px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.025))}
.rtk-kpi-label{color:var(--dsw-alias-label-tertiary,#858b94);font-size:11px;font-weight:600}
.rtk-kpi-value{margin-top:4px;color:var(--dsw-alias-label-primary,#202124);font-size:22px;line-height:1.15;font-weight:680;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.rtk-kpi-hint{margin-top:4px;color:var(--dsw-alias-label-tertiary,#858b94);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rtk-card{padding:16px 18px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(127,127,127,.16)));border-radius:14px;background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,transparent))}
.rtk-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.rtk-card-title{margin:0;font-size:13px;font-weight:650}
.rtk-range{display:inline-flex;padding:2px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16));border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.04))}
.rtk-range button{padding:4px 9px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#858b94);font:inherit;font-size:11px;cursor:pointer}
.rtk-range button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#202124);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.12)}
.rtk-chart{position:relative;padding-top:4px}
.rtk-chart-plot{position:relative;height:168px;margin-top:4px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16))}
.rtk-chart-grid{position:absolute;inset:0 0 0 0;display:flex;flex-direction:column;justify-content:space-between;pointer-events:none}
.rtk-chart-grid span{border-top:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.13))}
.rtk-chart-bars{position:absolute;inset:0 2px 0 2px;display:flex;align-items:stretch;gap:6px}
.rtk-chart-bars.dense{gap:2px}
.rtk-bar-slot{position:relative;display:flex;align-items:flex-end;flex:1;min-width:0}
.rtk-bar{width:100%;min-height:0;border-radius:5px 5px 2px 2px;background:linear-gradient(180deg,var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d7df3),var(--dsw-alias-state-business-primary,#7757e8));opacity:.88;transform-origin:bottom;animation:rtk-bar-in .32s ease both}
.rtk-bar-slot:hover .rtk-bar{opacity:1}
.rtk-chart-axis{display:flex;gap:6px;margin-top:7px;color:var(--dsw-alias-label-tertiary,#858b94);font-size:10px;font-variant-numeric:tabular-nums}
.rtk-chart-axis.dense{gap:2px}
.rtk-chart-axis span{flex:1;min-width:0;text-align:center;white-space:nowrap;overflow:hidden}
.rtk-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:2px;color:var(--dsw-alias-label-tertiary,#858b94);font-size:11px}
.rtk-refresh{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#555b63);font:inherit;font-size:11px;cursor:pointer}
.rtk-refresh:hover{border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.16));background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.rtk-refresh:disabled{opacity:.55;cursor:default}
.rtk-empty,.rtk-error{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:220px;padding:26px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:14px;text-align:center;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.02))}
.rtk-empty-icon,.rtk-error-icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin-bottom:12px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-tertiary,#858b94)}
.rtk-error-icon{color:var(--dsw-alias-state-error-primary,#c53b3b);background:rgba(197,59,59,.08)}
.rtk-empty h3,.rtk-error h3{margin:0;font-size:13px;font-weight:650}
.rtk-empty p,.rtk-error p{max-width:420px;margin:6px 0 0;color:var(--dsw-alias-label-tertiary,#858b94);font-size:12px}
.rtk-action{margin-top:14px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#202124);font:inherit;font-size:12px;cursor:pointer}
.rtk-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.rtk-notice{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;border:1px solid rgba(166,106,0,.2);border-radius:9px;background:rgba(166,106,0,.07);color:var(--dsw-alias-state-warn-label,#8a5d00);font-size:11.5px}
.rtk-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:330px;padding:32px;border:1px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:14px;text-align:center}
.rtk-placeholder-badge{display:inline-flex;margin-bottom:14px;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));color:var(--dsw-alias-label-tertiary,#858b94);font-size:10.5px;font-weight:600}
.rtk-placeholder h3{margin:0;font-size:14px;font-weight:650}
.rtk-placeholder p{max-width:440px;margin:8px 0 0;color:var(--dsw-alias-label-tertiary,#858b94);font-size:12px;line-height:1.65}
.rtk-placeholder-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;margin-bottom:16px;border-radius:14px;background:linear-gradient(145deg,var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4d7df3),var(--dsw-alias-state-business-primary,#7757e8));color:#fff;opacity:.9}
.rtk-spinner{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:rtk-spin .7s linear infinite}
.rtk-skeleton{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.rtk-skeleton span{display:block;height:82px;border-radius:12px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05)),var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1)),var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05)));background-size:200% 100%;animation:rtk-shimmer 1.2s linear infinite}
@keyframes rtk-bar-in{from{transform:scaleY(.02);opacity:.2}to{transform:scaleY(1);opacity:.88}}
@keyframes rtk-spin{to{transform:rotate(360deg)}}
@keyframes rtk-shimmer{to{background-position:-200% 0}}
@media (max-width:900px){.rtk-kpis,.rtk-skeleton{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:720px){.rtk-topbar{align-items:flex-start;flex-direction:column;gap:6px;padding:8px}.rtk-tabs{width:100%}.rtk-hero{flex-direction:column}.rtk-footer{align-items:flex-start;flex-direction:column}}
@media (prefers-reduced-motion:reduce){.rtk-bar,.rtk-spinner,.rtk-skeleton span{animation:none}}
`;

    const tagId = "@rtk-ai/dsh-rtk-filter/SettingsSection.module.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@rtk-ai/dsh-rtk-filter";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    function localeTag(locale) {
      if (typeof locale !== "string" || locale === "") return "en";
      if (locale.startsWith("zh")) return "zh-CN";
      return locale;
    }

    function finite(value) {
      return Number.isFinite(value) ? value : 0;
    }

    function formatNumber(value, locale, options) {
      try {
        return new Intl.NumberFormat(localeTag(locale), options).format(value);
      } catch {
        return null;
      }
    }

    function formatInteger(value, locale) {
      const number = finite(value);
      const formatted = formatNumber(number, locale);
      return formatted === null ? String(number) : formatted;
    }

    function formatCompact(value, locale) {
      const number = finite(value);
      if (number < 1000) return formatInteger(number, locale);
      const formatted = formatNumber(number, locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      });
      return formatted === null ? formatInteger(number, locale) : formatted;
    }

    function formatPercent(value) {
      return `${finite(value).toFixed(1)}%`;
    }

    function formatClock(value, locale) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) return "—";
      try {
        return new Intl.DateTimeFormat(localeTag(locale), {
          hour: "2-digit",
          minute: "2-digit",
        }).format(date);
      } catch {
        return date.toISOString().slice(11, 16);
      }
    }

    function shortDate(value) {
      return typeof value === "string" && value.length >= 10 ? value.slice(5).replace("-", "/") : value;
    }

    function icon(name, size) {
      const common = {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.8,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      };
      if (name === "activity") return h("svg", common, h("path", { d: "M3 12h4l2.2-7 4.1 14 2.2-7H21" }));
      if (name === "sliders") return h("svg", common, h("path", { d: "M4 7h9M17 7h3M4 17h3M11 17h9" }), h("circle", { cx: 15, cy: 7, r: 2 }), h("circle", { cx: 9, cy: 17, r: 2 }));
      if (name === "refresh") return h("svg", common, h("path", { d: "M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7" }));
      if (name === "spark") return h("svg", common, h("path", { d: "M12 3v3M12 18v3M3 12h3M18 12h3M5.64 5.64l2.12 2.12M16.24 16.24l2.12 2.12M18.36 5.64l-2.12 2.12M7.76 16.24l-2.12 2.12" }), h("circle", { cx: 12, cy: 12, r: 3 }));
      if (name === "warning") return h("svg", common, h("path", { d: "M12 4 3.8 19h16.4L12 4Z" }), h("path", { d: "M12 9v4M12 16.5h.01" }));
      return null;
    }

    function runtimeLabel(state, t) {
      if (state === "ready") return t("runtimeReady");
      if (state === "installing") return t("runtimeInstalling");
      return t("runtimeUnavailable");
    }

    function sourceLabel(source, t) {
      if (source === "managed") return t("sourceManaged");
      if (source === "path") return t("sourcePath");
      if (source === "explicit") return t("sourceExplicit");
      return null;
    }

    function RuntimeHero({ data, t, locale }) {
      const runtime = data?.runtime ?? { state: "unavailable", version: null, source: null };
      const state = runtime.state === "ready" || runtime.state === "installing" ? runtime.state : "unavailable";
      const source = sourceLabel(runtime.source, t);
      return h(
        "div",
        { className: "rtk-hero" },
        h(
          "div",
          { className: "rtk-hero-main" },
          h("span", { className: "rtk-mark", "aria-hidden": "true" }, icon("activity", 20)),
          h(
            "div",
            { style: { minWidth: 0 } },
            h("h2", null, t("statusTitle")),
            h("p", null, t("statusDescription")),
            h(
              "div",
              { className: "rtk-runtime-meta" },
              [
                runtime.version ? `RTK ${runtime.version}` : t("versionUnknown"),
                source,
              ].filter(Boolean).join(" · "),
            ),
          ),
        ),
        h(
          "span",
          { className: "rtk-badge " + state },
          h("span", { className: "rtk-badge-dot", "aria-hidden": "true" }),
          runtimeLabel(state, t),
        ),
      );
    }

    function Metric({ label, value, hint }) {
      return h(
        "div",
        { className: "rtk-kpi" },
        h("div", { className: "rtk-kpi-label" }, label),
        h("div", { className: "rtk-kpi-value" }, value),
        h("div", { className: "rtk-kpi-hint", title: hint }, hint),
      );
    }

    function TrendChart({ daily, days, t, locale, onRange }) {
      const rows = Array.isArray(daily) ? daily : [];
      const max = Math.max(1, ...rows.map((row) => finite(row.savedTokens)));
      const dense = rows.length > 14;
      const labelEvery = dense ? 5 : 1;
      const totalSaved = rows.reduce((sum, row) => sum + finite(row.savedTokens), 0);
      const totalCalls = rows.reduce((sum, row) => sum + finite(row.calls), 0);
      return h(
        "section",
        { className: "rtk-card", "aria-label": t("trend") },
        h(
          "div",
          { className: "rtk-card-head" },
          h("h3", { className: "rtk-card-title" }, t("trend")),
          h(
            "div",
            { className: "rtk-range", role: "group" },
            RANGE_OPTIONS.map((option) => h(
              "button",
              {
                key: option,
                type: "button",
                "aria-pressed": option === days ? "true" : "false",
                onClick: () => onRange?.(option),
              },
              t(option === 7 ? "days7" : "days30"),
            )),
          ),
        ),
        h(
          "div",
          {
            className: "rtk-chart",
            role: "img",
            "aria-label": t("chartAria", {
              days,
              calls: formatInteger(totalCalls, locale),
              tokens: formatCompact(totalSaved, locale),
            }),
          },
          h(
            "div",
            { className: "rtk-chart-plot" },
            h(
              "div",
              { className: "rtk-chart-grid", "aria-hidden": "true" },
              [0, 1, 2, 3].map((line) => h("span", { key: line })),
            ),
            h(
              "div",
              { className: "rtk-chart-bars" + (dense ? " dense" : "") },
              rows.map((row) => {
                const saved = finite(row.savedTokens);
                const height = saved > 0 ? Math.max(3, (saved / max) * 100) : 0;
                return h(
                  "div",
                  {
                    key: row.date,
                    className: "rtk-bar-slot",
                    title: t("chartTooltip", {
                      date: row.date,
                      calls: formatInteger(row.calls, locale),
                      tokens: formatCompact(saved, locale),
                    }),
                  },
                  h("div", { className: "rtk-bar", style: { height: `${height}%` } }),
                );
              }),
            ),
          ),
          h(
            "div",
            { className: "rtk-chart-axis" + (dense ? " dense" : "") },
            rows.map((row, index) => h(
              "span",
              { key: row.date },
              index % labelEvery === 0 || index === rows.length - 1 ? shortDate(row.date) : "",
            )),
          ),
        ),
      );
    }

    function StatusPage({ data, error, loading, days, onRange, onRetry, t, locale }) {
      if (error !== null) {
        return h(
          "div",
          { className: "rtk-error", role: "alert" },
          h("span", { className: "rtk-error-icon" }, icon("warning", 21)),
          h("h3", null, t("errorTitle")),
          h("p", null, t("errorDescription")),
          h("button", { type: "button", className: "rtk-action", onClick: onRetry }, t("retry")),
        );
      }
      if (data === null) {
        return h(
          "div",
          { "aria-busy": "true" },
          h("div", { className: "rtk-skeleton", "aria-hidden": "true" }, [0, 1, 2, 3].map((n) => h("span", { key: n }))),
          h("p", { className: "rtk-footer", style: { justifyContent: "center" } }, t("loading")),
        );
      }

      const summary = data.summary ?? { calls: 0, savedTokens: 0, savingsPct: 0, avgSavedPerCall: 0 };
      const hasActivity = summary.calls > 0;
      return h(
        React.Fragment,
        null,
        h(RuntimeHero, { data, t, locale }),
        data.statsError
          ? h(
            "div",
            { className: "rtk-notice", role: "status", title: String(data.statsError) },
            icon("warning", 15),
            h("span", null, t("statsError")),
          )
          : null,
        hasActivity
          ? h(
            React.Fragment,
            null,
            h(
              "div",
              { className: "rtk-kpis" },
              h(Metric, {
                label: t("calls"),
                value: formatInteger(summary.calls, locale),
                hint: t("callsHint"),
              }),
              h(Metric, {
                label: t("saved"),
                value: formatCompact(summary.savedTokens, locale),
                hint: t("savedHint"),
              }),
              h(Metric, {
                label: t("rate"),
                value: formatPercent(summary.savingsPct),
                hint: t("rateHint"),
              }),
              h(Metric, {
                label: t("perCall"),
                value: formatCompact(summary.avgSavedPerCall, locale),
                hint: t("perCallHint"),
              }),
            ),
            h(TrendChart, { daily: data.daily, days, t, locale, onRange }),
          )
          : h(
            "div",
            { className: "rtk-empty" },
            h("span", { className: "rtk-empty-icon" }, icon("spark", 22)),
            h("h3", null, t("noDataTitle")),
            h("p", null, t("noDataDescription")),
          ),
        h(
          "div",
          { className: "rtk-footer" },
          h("span", null, t("updatedAt", { time: formatClock(data.generatedAt, locale) })),
          h(
            "button",
            {
              type: "button",
              className: "rtk-refresh",
              onClick: onRetry,
              disabled: loading,
            },
            loading ? h("span", { className: "rtk-spinner", "aria-hidden": "true" }) : icon("refresh", 13),
            loading ? t("refreshing") : t("refresh"),
          ),
        ),
      );
    }

    function SettingsPlaceholder({ t }) {
      return h(
        "div",
        { className: "rtk-placeholder" },
        h("span", { className: "rtk-placeholder-icon" }, icon("sliders", 22)),
        h("span", { className: "rtk-placeholder-badge" }, t("settingsBadge")),
        h("h3", null, t("settingsPlaceholderTitle")),
        h("p", null, t("settingsPlaceholderDescription")),
      );
    }

    function RtkSettingsSection({ ctx, t }) {
      const [tab, setTab] = React.useState("status");
      const [days, setDays] = React.useState(7);
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [revision, setRevision] = React.useState(0);
      const [, refreshLocale] = React.useState(0);
      const locale = ctx.locale.getLocale().active;
      const visibleData = data !== null && data.range?.days === days ? data : null;

      React.useEffect(() => {
        const dispose = ctx.locale.subscribe(() => refreshLocale((value) => value + 1));
        return dispose;
      }, [ctx]);

      React.useEffect(() => {
        const controller = new AbortController();
        let alive = true;
        setLoading(true);
        setError(null);
        const url = new URL(STATUS_PATH, document.baseURI);
        url.searchParams.set("days", String(days));
        fetch(url.href, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
          credentials: "same-origin",
        })
          .then((response) => {
            if (!response.ok) throw new Error(`status request failed (${response.status})`);
            return response.json();
          })
          .then((payload) => {
            if (!alive) return;
            setData(payload);
            setLoading(false);
          })
          .catch((reason) => {
            if (!alive || reason?.name === "AbortError") return;
            setData(null);
            setError(reason instanceof Error ? reason.message : String(reason));
            setLoading(false);
          });
        return () => {
          alive = false;
          controller.abort();
        };
      }, [days, revision, ctx]);

      return h(
        "div",
        { className: "rtk-root" },
        h(
          "nav",
          { className: "rtk-topbar", "aria-label": t("nav") },
          h("span", { className: "rtk-topbar-title" }, t("nav")),
          h(
            "div",
            { className: "rtk-tabs", role: "tablist" },
            h(
              "button",
              {
                type: "button",
                role: "tab",
                className: "rtk-nav-button",
                "aria-selected": tab === "status",
                "aria-controls": "rtk-status-panel",
                onClick: () => setTab("status"),
              },
              h("span", { className: "rtk-nav-icon", "aria-hidden": "true" }, icon("activity", 15)),
              t("statusTab"),
            ),
            h(
              "button",
              {
                type: "button",
                role: "tab",
                className: "rtk-nav-button",
                "aria-selected": tab === "settings",
                "aria-controls": "rtk-settings-panel",
                onClick: () => setTab("settings"),
              },
              h("span", { className: "rtk-nav-icon", "aria-hidden": "true" }, icon("sliders", 15)),
              t("settingsTab"),
            ),
          ),
        ),
        h(
          "div",
          {
            className: "rtk-content",
            id: tab === "status" ? "rtk-status-panel" : "rtk-settings-panel",
            role: "tabpanel",
            "aria-busy": loading ? "true" : "false",
          },
          tab === "status"
            ? h(StatusPage, {
              data: visibleData,
              error,
              loading,
              days,
              onRange: setDays,
              onRetry: () => setRevision((value) => value + 1),
              t,
              locale,
            })
            : h(SettingsPlaceholder, { t }),
        ),
      );
    }

    const inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, dictionaries),
        "rtk-filter: settings dictionaries",
      );
      const t = ctx.locale.bind(NS);
      ctx.slots.inject("settings.section", () => ctx.slots.register(
        {
          name: "settings.section",
          id: "rtk-filter",
          order: 30,
          label: () => t("nav"),
          locale: NS,
        },
        (props) => h(RtkSettingsSection, { ...props, ctx, t }),
      ));
    }

    exports.NS = NS;
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
