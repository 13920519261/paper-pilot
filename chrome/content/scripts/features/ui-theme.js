/* PaperPilot 界面主题（0.16.0）
 * 借鉴设计来源（详见 docs/0.16.0-theme-credits.md）：
 *  - Sum-su/yaobian-zotero（MIT）：CSS 变量映射方案——Zotero 7+ 界面颜色完全由
 *    --material-* / --fill-* / --color-accent 等变量驱动，向窗口注入 <style> 用
 *    !important 覆盖即可整窗换肤；作用域收在 #main-window，不污染 reader 子文档；
 *    Services.wm.getEnumerator 枚举 + load 事件 watch 兼容设置窗口 reload。
 *  - tefkah/zotero-night（GPL-3.0，思路借鉴不抄代码）：Nord 色板基调、"UI+阅读器
 *    一起换色"的产品形态。
 *  - 色板派生（tab/quaternary/quinary 由基色混合）沿用 yaobian 的"36 家族不必
 *    逐个手调"思想，但 mix 在 JS 侧完成，产出静态色值，不依赖 color-mix 兼容性。
 *
 * 主题 = 一套完整色板（12 个语义角色）。深浅基调由主题自身决定（如"Nord 夜色"
 * 就是深色），与 Zotero 原生外观设置解耦，避免双重控制打架。
 */
/* global Zotero, Services, Prefs, Components */

var UiTheme = {
  STYLE_ID: "paperpilot-ui-theme-style",
  PREF_KEY: "uiTheme",        // "" = 跟随 Zotero 原生；否则主题 id
  PREF_CUSTOM: "uiThemeCustom", // 自定义主题 JSON 色板（部分角色，缺省派生）

  _winListener: null,

  /* ---------- 主题库 ----------
   * 角色：background 全窗底 / side 侧栏 / toolbar 工具栏 / tab 标签栏 /
   *       surface 卡片表面 / menu 菜单 / ink 正文 / ink2 ink3 次级文字 /
   *       line 分割线 / accent 强调 / select 选中底
   * tag: standard=标准系列 anime=动漫系列 custom=用户自定义 */
  THEMES: [
    { id: "primer-light", tag: "standard", dark: false, name: "Primer 浅色",
      colors: { background: "#ffffff", side: "#f6f8fa", toolbar: "#f6f8fa", tab: "#eceff2", surface: "#ffffff", menu: "#ffffff", ink: "#1f2328", ink2: "#59636e", ink3: "#818b98", line: "#d1d9e0", accent: "#0969da", select: "#0969da26" } },
    { id: "primer-dark", tag: "standard", dark: true, name: "Primer 深色",
      colors: { background: "#0d1117", side: "#161b22", toolbar: "#161b22", tab: "#21262d", surface: "#161b22", menu: "#1c2128", ink: "#e6edf3", ink2: "#9198a1", ink3: "#6e7681", line: "#3d444d", accent: "#4493f8", select: "#4493f840" } },
    { id: "nord-night", tag: "standard", dark: true, name: "Nord 夜色",
      colors: { background: "#2e3440", side: "#3b4252", toolbar: "#3b4252", tab: "#434c5e", surface: "#3b4252", menu: "#434c5e", ink: "#eceff4", ink2: "#aeb8c6", ink3: "#7b88a1", line: "#434c5e", accent: "#88c0d0", select: "#88c0d040" } },
    { id: "sepia-paper", tag: "standard", dark: false, name: "护眼米纸",
      colors: { background: "#f5f0e1", side: "#efe8d5", toolbar: "#efe8d5", tab: "#e5dcc4", surface: "#faf6ea", menu: "#f5f0e1", ink: "#433422", ink2: "#6d5c44", ink3: "#94836b", line: "#dccfb2", accent: "#a05a2c", select: "#a05a2c30" } },

    { id: "sakura", tag: "anime", dark: false, name: "樱花前线",
      colors: { background: "#fff5f7", side: "#fdeef2", toolbar: "#fdeef2", tab: "#f8e0e8", surface: "#fff9fa", menu: "#fdeef2", ink: "#5c3a44", ink2: "#8a626d", ink3: "#b08e98", line: "#f0d4dc", accent: "#e56a8f", select: "#e56a8f30" } },
    { id: "mint-soda", tag: "anime", dark: false, name: "薄荷苏打",
      colors: { background: "#f0fbf6", side: "#e4f7ee", toolbar: "#e4f7ee", tab: "#d4f0e3", surface: "#f5fcf9", menu: "#e4f7ee", ink: "#1f4739", ink2: "#46705f", ink3: "#6f9787", line: "#c4e6d6", accent: "#17a673", select: "#17a67330" } },
    { id: "violet-eternity", tag: "anime", dark: true, name: "紫罗兰夜",
      colors: { background: "#221a2e", side: "#2c223b", toolbar: "#2c223b", tab: "#372b49", surface: "#2c223b", menu: "#372b49", ink: "#eae4f4", ink2: "#b4a8cc", ink3: "#857a9f", line: "#453858", accent: "#a78bfa", select: "#a78bfa40" } },
    { id: "azure-fleet", tag: "anime", dark: true, name: "苍蓝晨风",
      colors: { background: "#0e1b2e", side: "#16263d", toolbar: "#16263d", tab: "#1f3350", surface: "#16263d", menu: "#1f3350", ink: "#e2ecf9", ink2: "#a3b8d4", ink3: "#75899f", line: "#2a4260", accent: "#5ba3f5", select: "#5ba3f540" } },
  ],

  /* ---------- 色彩工具（十六进制解析 / 混合，全部产出静态色值） ---------- */

  _hex2rgb(hex) {
    let h = String(hex || "").replace("#", "").trim();
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length !== 6 || /[^0-9a-f]/i.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  },

  /** c1 占比 t 的线性混合（0-1），任一无效则回退 c1 */
  _mix(c1, c2, t) {
    const a = this._hex2rgb(c1), b = this._hex2rgb(c2);
    if (!a) return c1;
    if (!b) return c1;
    const r = Math.round(a[0] * t + b[0] * (1 - t));
    const g = Math.round(a[1] * t + b[1] * (1 - t));
    const bl = Math.round(a[2] * t + b[2] * (1 - t));
    return "#" + [r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("");
  },

  /* ---------- 当前主题解析（内置 / 自定义 / 跟随原生） ---------- */

  /** 返回 {id,name,dark,colors} 或 null（跟随原生） */
  current() {
    const id = String(Prefs.get(this.PREF_KEY, "") || "");
    if (!id) return null;
    if (id === "custom") {
      const c = this.customColors();
      return { id: "custom", name: "自定义", dark: !!c.__dark, colors: c };
    }
    return this.THEMES.find((t) => t.id === id) || null;
  },

  /** 读取自定义色板并补全派生角色（用户只填 7 个核心角色） */
  customColors() {
    let saved = {};
    try { saved = JSON.parse(Prefs.get(this.PREF_CUSTOM, "") || "{}"); } catch (e) { /* ignore */ }
    const bg = saved.background || "#ffffff";
    const side = saved.side || bg;
    const ink = saved.ink || "#1f2328";
    const accent = saved.accent || "#0969da";
    return {
      __dark: !!saved.__dark,
      background: bg,
      side: side,
      toolbar: side,
      tab: this._mix(side, bg, 0.65),
      surface: saved.surface || this._mix(bg, "#ffffff", 0.85),
      menu: this._mix(side, bg, 0.8),
      ink: ink,
      ink2: this._mix(ink, bg, 0.65),
      ink3: this._mix(ink, bg, 0.4),
      line: saved.line || this._mix(ink, bg, 0.18),
      accent: accent,
      select: saved.select || (this._hex2rgb(accent) ? accent : "#0969da"),
    };
  },

  /* ---------- CSS 生成（借鉴 yaobian 的 YB_MAPPING 变量契约） ---------- */

  _css(theme) {
    if (!theme) return "";
    const c = theme.colors;
    // select 需要 alpha 形式：内置色板直接给 8 位 hex；自定义的 accent 兜底拼 26（~15%）
    let select = c.select || "";
    if (select.length === 7) select += "26";
    const decls = [
      // 面（Zotero material 设计变量）
      "--material-background: " + c.background,
      "--material-sidepane: " + c.side,
      "--material-toolbar: " + c.toolbar,
      "--material-tabbar: " + c.tab,
      "--material-menu: " + c.menu,
      "--material-surface: " + c.surface,
      "--material-border: 1px solid " + c.line,
      "--material-accent: " + c.accent,
      // 字
      "--fill-primary: " + c.ink,
      "--fill-secondary: " + c.ink2,
      "--fill-tertiary: " + c.ink3,
      "--fill-quaternary: " + this._mix(c.ink, c.background, 0.16),
      "--fill-quinary: " + this._mix(c.ink, c.background, 0.09),
      // 强调色：选中 / 链接 / 进度
      "--color-accent: " + c.accent,
      "--color-background: " + c.background,
      "--accent-blue: " + c.accent,
      "--accent-azure: " + this._mix(c.accent, c.background, 0.7),
      "--accent-red: " + (theme.dark ? "#f85149" : "#cf222e"),
      "--accent-green: " + (theme.dark ? "#3fb950" : "#1a7f37"),
      "--accent-yellow: " + (theme.dark ? "#d29922" : "#9a6700"),
      // Firefox 侧：弹窗与窗口底色
      "--arrowpanel-background: " + c.surface,
      "--arrowpanel-color: " + c.ink,
      "--arrowpanel-border-color: " + c.line,
      "--toolbar-bgcolor: " + c.toolbar,
      "--toolbar-color: " + c.ink,
      "--lwt-accent-color: " + c.toolbar,
      "--lwt-selected-tab-background-color: " + c.background,
      "--tabpanel-background-color: " + c.background,
    ].map((d) => d + " !important;").join("\n  ");

    return (
      "/* PaperPilot 界面主题 · " + theme.name + " */\n" +
      "#main-window {\n  " + decls + "\n}\n" +
      "#zotero-prefs {\n  " + decls + "\n}\n" +
      // 自绘不透明背景的面板（不跟随 --material-* 的漏网之鱼，
      // 选择器清单经验值来自 yaobian 对 Zotero pane 栈的实测）
      "#main-window #zotero-pane,\n" +
      "#main-window #zotero-collections-pane,\n" +
      "#main-window #zotero-tag-selector-container,\n" +
      "#main-window #zotero-items-pane,\n" +
      "#main-window #zotero-items-tree,\n" +
      "#main-window #zotero-item-pane,\n" +
      "#main-window .virtualized-table-container,\n" +
      "#main-window .virtualized-table,\n" +
      "#main-window .item-pane-content {\n" +
      "  background-color: " + c.background + " !important;\n}\n" +
      // 条目树/分类树：行与悬停跟随主题
      "#main-window .virtualized-table .row:hover:not(.selected) {\n" +
      "  background-color: " + this._mix(c.ink, c.background, 0.06) + " !important;\n}\n" +
      // 选中行：Zotero 原生是中性灰，换主题必须跟着换（yaobian 实证点）
      "#main-window #zotero-items-tree .selected,\n" +
      "#main-window #zotero-collections-tree .selected {\n" +
      "  background-color: " + select + " !important;\n" +
      "  color: " + c.ink + " !important;\n}\n" +
      // 标签栏激活页签
      "#main-window .tab:not([selected]):hover {\n" +
      "  background-color: " + this._mix(c.ink, c.tab, 0.08) + " !important;\n}\n" +
      "#main-window .tabs .tab.selected {\n" +
      "  background-color: " + c.surface + " !important;\n" +
      "  color: " + c.ink + " !important;\n}\n"
    );
  },

  /* ---------- 应用 / 清除 ---------- */

  _applyToWindow(win) {
    try {
      this._watchWindow(win);
      const root = win.document && win.document.documentElement;
      if (!root) return;
      const isMain = root.id === "main-window" || root.id === "zotero-prefs";
      if (!isMain) return;
      const theme = this.current();
      let style = win.document.getElementById(this.STYLE_ID);
      if (!theme) {
        if (style) style.remove();
        return;
      }
      if (!style) {
        style = win.document.createElementNS("http://www.w3.org/1999/xhtml", "style");
        style.id = this.STYLE_ID;
        root.appendChild(style);
      }
      const css = this._css(theme);
      if (style.textContent !== css) style.textContent = css;
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /** watchWindow：设置窗口会被 Zotero 自行 reload（文档换新，旧监听随全局一起蒸发），
   *  重新挂 load 监听让主题在窗口文档重建后自动恢复（yaobian 的 watchWindow 思路） */
  _watchWindow(win) {
    if (!win || win.__ppThemeWatched) return;
    win.__ppThemeWatched = true;
    win.addEventListener("load", () => {
      win.__ppThemeWatched = false; // 新文档新全局，重新可挂
      this._applyToWindow(win);
    });
  },

  /** 枚举全部 chrome 窗口（含设置窗口；Zotero.getMainWindows 拿不到后者） */
  _allWindows() {
    const out = [];
    try {
      const en = Services.wm.getEnumerator(null);
      while (en.hasMoreElements()) {
        const w = en.getNext();
        if (w) out.push(w);
      }
    } catch (e) { /* ignore */ }
    return out;
  },

  /** 主入口：立即对全部窗口应用/清除当前主题 */
  apply() {
    for (const win of this._allWindows()) this._applyToWindow(win);
  },

  /** pref 变更 / 菜单切换入口 */
  setTheme(id) {
    Prefs.set(this.PREF_KEY, id || "");
    this.apply();
  },

  register() {
    // 存量窗口立即应用
    this.apply();
    // 新窗口（含运行中打开的设置窗口）双通道监听：
    // ① nsIWindowMediator.addListener（FF ≤126 可用；FF128+ 已移除，走 ②）
    // ② Services.obs domwindowopened（全版本可用的兜底）
    const onWindow = (win) => {
      try {
        if (!win) return;
        win.addEventListener("load", () => this._applyToWindow(win), { once: true });
        // 某些窗口 load 已触发过，直接试一次（幂等）
        this._applyToWindow(win);
      } catch (e) { /* ignore */ }
    };
    try {
      this._winListener = {
        onOpenWindow(xulWin) {
          try {
            onWindow(xulWin && xulWin.docShell
              ? xulWin.docShell.contentViewer.DOMDocument.defaultView
              : null);
          } catch (e) { /* ignore */ }
        },
        onCloseWindow() {},
        onWindowTitleChange() {},
      };
      Services.wm.addListener(this._winListener);
    } catch (e) {
      this._winListener = null; // FF128+：移除接口，走 domwindowopened
    }
    try {
      const self = this;
      this._obsObserver = {
        observe(subject) {
          try {
            const doc = subject && subject.QueryInterface
              ? subject.QueryInterface(Components.interfaces.nsIDOMWindow)
              : null;
            const win = doc || (subject && subject.defaultView);
            onWindow(win || subject);
          } catch (e) {
            try { onWindow(subject); } catch (e2) { /* ignore */ }
          }
        },
      };
      Services.obs.addObserver(this._obsObserver, "domwindowopened", false);
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  unregister() {
    try {
      if (this._winListener) Services.wm.removeListener(this._winListener);
    } catch (e) { /* ignore */ }
    this._winListener = null;
    try {
      if (this._obsObserver) Services.obs.removeObserver(this._obsObserver, "domwindowopened");
    } catch (e) { /* ignore */ }
    this._obsObserver = null;
    // 移除全部注入的 <style>（窗口随后交还 Zotero 原生配色）
    for (const win of this._allWindows()) {
      try {
        const s = win.document && win.document.getElementById(this.STYLE_ID);
        if (s) s.remove();
      } catch (e) { /* ignore */ }
    }
  },
};
