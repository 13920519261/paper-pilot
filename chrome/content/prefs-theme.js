/* PaperPilot 设置窗格 · 主题系统交互脚本（0.16.0）
 * 由 Zotero.PreferencePanes.register({scripts:[...]}) 注入设置窗口执行。
 * 主题库与切换接口经 Zotero.PaperPilot.uiTheme / pdfTheme 访问（主模块挂载）。
 * 交互设计：主题卡片 = 名称 + 四色色板预览条 + 深浅标记，点选即时生效
 * （借鉴 yaobian 设置面板的色板 chip 预览思路）。
 */
/* global Zotero, window, document */

(function () {
  const PREFIX = "extensions.zotero.paperpilot.";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");

  const $ = (id) => document.getElementById(id);
  const XHTML = "http://www.w3.org/1999/xhtml";
  const h = (tag) => document.createElementNS(XHTML, tag);
  const uiT = () => (Zotero.PaperPilot && Zotero.PaperPilot.uiTheme) || null;
  const pdfT = () => (Zotero.PaperPilot && Zotero.PaperPilot.pdfTheme) || null;

  const getPref = (key, fallback) => {
    try {
      const v = Zotero.Prefs.get(PREFIX + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) { return fallback; }
  };
  const setPref = (key, value) => {
    try { Zotero.Prefs.set(PREFIX + key, value, true); } catch (e) { /* ignore */ }
  };

  function msg(id, text, ok) {
    const el = $(id);
    if (el) {
      el.textContent = text;
      el.style.color = ok ? "var(--pp-success)" : "var(--pp-danger)";
    }
  }

  /* ---------- 界面主题：卡片网格 ---------- */

  function themeCard(t, selected) {
    const card = h("div");
    card.setAttribute("class", "pp-theme-card" + (selected ? " pp-theme-on" : ""));
    // 色板预览条：背景 / 侧栏 / 表面 / 强调（一目了然的四色缩略）
    const c = t.colors;
    const sw = h("div");
    sw.setAttribute("class", "pp-theme-swatches");
    for (const col of [c.background, c.side, c.surface, c.accent]) {
      const chip = h("span");
      chip.setAttribute("class", "pp-theme-chip");
      chip.style.background = col;
      sw.appendChild(chip);
    }
    const label = h("div");
    label.setAttribute("class", "pp-theme-name");
    label.textContent = (t.dark ? "🌙 " : "☀️ ") + t.name;
    const tag = h("div");
    tag.setAttribute("class", "pp-theme-tag");
    tag.textContent = t.tag === "anime"
      ? (zh ? "动漫" : "Anime")
      : (t.tag === "custom" ? (zh ? "自定义" : "Custom") : (zh ? "标准" : "Std"));
    card.appendChild(sw);
    card.appendChild(label);
    card.appendChild(tag);
    card.addEventListener("click", () => {
      try {
        setPref("uiTheme", t.id);
        // 主模块的 pref observer 会自动换肤；这里同步选中态视觉
        renderUiGrid();
      } catch (e) { /* ignore */ }
    });
    return card;
  }

  function nativeCard(selected) {
    const card = h("div");
    card.setAttribute("class", "pp-theme-card" + (selected ? " pp-theme-on" : ""));
    const sw = h("div");
    sw.setAttribute("class", "pp-theme-swatches");
    for (const col of ["#ffffff", "#f0f0f0", "#d9d9d9", "#666666"]) {
      const chip = h("span");
      chip.setAttribute("class", "pp-theme-chip");
      chip.style.background = col;
      sw.appendChild(chip);
    }
    const label = h("div");
    label.setAttribute("class", "pp-theme-name");
    label.textContent = "🍃 " + (zh ? "跟随 Zotero 原生" : "Follow native");
    const tag = h("div");
    tag.setAttribute("class", "pp-theme-tag");
    tag.textContent = zh ? "默认" : "Default";
    card.appendChild(sw);
    card.appendChild(label);
    card.appendChild(tag);
    card.addEventListener("click", () => {
      setPref("uiTheme", "");
      renderUiGrid();
    });
    return card;
  }

  function customCard(selected) {
    const colors = (uiT() && uiT().customColors()) || {};
    const t = {
      id: "custom", name: zh ? "自定义色板" : "Custom", tag: "custom", dark: !!colors.__dark,
      colors: {
        background: colors.background || "#ffffff",
        side: colors.side || "#f6f8fa",
        surface: colors.surface || "#ffffff",
        accent: colors.accent || "#0969da",
      },
    };
    return themeCard(t, selected);
  }

  function renderUiGrid() {
    const grid = $("pp-ui-theme-grid");
    const mod = uiT();
    if (!grid || !mod) return;
    while (grid.firstChild) grid.removeChild(grid.firstChild);
    const cur = String(getPref("uiTheme", "") || "");
    grid.appendChild(nativeCard(cur === ""));
    const groups = ["standard", "anime"];
    for (const g of groups) {
      for (const t of mod.THEMES) {
        if (t.tag !== g) continue;
        grid.appendChild(themeCard(t, cur === t.id));
      }
    }
    grid.appendChild(customCard(cur === "custom"));
  }

  /* ---------- 自定义色板表单 ---------- */

  const UT_FIELDS = [
    ["pp-ut-bg", "background", "#ffffff"],
    ["pp-ut-side", "side", ""],
    ["pp-ut-surface", "surface", ""],
    ["pp-ut-ink", "ink", "#1f2328"],
    ["pp-ut-accent", "accent", "#0969da"],
    ["pp-ut-line", "line", ""],
  ];

  function loadCustomForm() {
    let saved = {};
    try { saved = JSON.parse(getPref("uiThemeCustom", "") || "{}"); } catch (e) { /* ignore */ }
    for (const [id, key, def] of UT_FIELDS) {
      const input = $(id);
      if (input) input.value = saved[key] || def;
    }
    const dark = $("pp-ut-dark");
    if (dark) dark.checked = !!saved.__dark;
    // 文本输入 ↔ 取色器双向同步
    for (const [id] of UT_FIELDS) {
      const input = $(id);
      const pick = $(id + "-pick");
      if (!input || !pick) continue;
      pick.value = /^#[0-9a-f]{6}$/i.test(input.value) ? input.value : "#ffffff";
      input.addEventListener("input", () => {
        if (/^#[0-9a-f]{6}$/i.test(input.value)) pick.value = input.value;
      });
      pick.addEventListener("input", () => { input.value = pick.value; });
    }
  }

  function applyCustom() {
    const out = { __dark: !!($("pp-ut-dark") && $("pp-ut-dark").checked) };
    for (const [id, key, def] of UT_FIELDS) {
      const input = $(id);
      let v = input ? String(input.value || "").trim() : "";
      if (!/^#[0-9a-f]{6}$/i.test(v)) {
        if (!v) { if (def) out[key] = def; continue; }
        msg("pp-ut-result", zh ? "颜色格式应为 #rrggbb" : "Use #rrggbb format");
        return;
      }
      out[key] = v;
    }
    setPref("uiThemeCustom", JSON.stringify(out));
    setPref("uiTheme", "custom");
    renderUiGrid();
    msg("pp-ut-result", zh ? "✓ 已应用自定义色板" : "✓ Custom palette applied", true);
  }

  /* ---------- PDF 阅读主题列表 ---------- */

  function renderPdfList() {
    const list = $("pp-pdf-theme-list");
    const mod = pdfT();
    if (!list || !mod) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    const cur = String(getPref("pdfTheme", "default") || "default");
    for (const t of mod.THEMES) {
      const row = h("label");
      row.setAttribute("class", "pp-pdf-item" + (t.id === cur ? " pp-pdf-on" : ""));
      const radio = h("input");
      radio.setAttribute("type", "radio");
      radio.setAttribute("name", "pp-pdf-theme");
      radio.checked = t.id === cur;
      const name = h("span");
      name.textContent = (t.dark ? "🌙 " : "📄 ") + t.name;
      const badge = h("span");
      badge.setAttribute("class", "pp-pdf-badge");
      badge.textContent = t.dark
        ? (zh ? "反色·黑纸白字" : "Inverted")
        : (t.id === "default"
          ? (zh ? "原始白纸" : "Original")
          : (zh ? "叠色·护眼" : "Tint"));
      row.appendChild(radio);
      row.appendChild(name);
      row.appendChild(badge);
      if (t.custom) {
        const color = h("span");
        color.setAttribute("class", "pp-theme-chip");
        color.style.background = String(getPref("pdfThemeCustomColor", "#578f32"));
        row.appendChild(color);
      }
      row.addEventListener("click", () => {
        setPref("pdfTheme", t.id);
        renderPdfList();
      });
      list.appendChild(row);
    }
  }

  function loadPdfCustomForm() {
    const color = $("pp-pt-color");
    const pick = $("pp-pt-color-pick");
    const op = $("pp-pt-opacity");
    if (color) color.value = String(getPref("pdfThemeCustomColor", "#578f32"));
    if (op) op.value = String(getPref("pdfThemeCustomOpacity", 30));
    if (color && pick) {
      pick.value = /^#[0-9a-f]{6}$/i.test(color.value) ? color.value : "#578f32";
      color.addEventListener("input", () => {
        if (/^#[0-9a-f]{6}$/i.test(color.value)) pick.value = color.value;
      });
      pick.addEventListener("input", () => { color.value = pick.value; });
    }
  }

  function applyPdfCustom() {
    const color = $("pp-pt-color");
    const op = $("pp-pt-opacity");
    let v = color ? String(color.value || "").trim() : "";
    if (!/^#[0-9a-f]{6}$/i.test(v)) {
      msg("pp-pt-result", zh ? "颜色格式应为 #rrggbb" : "Use #rrggbb format");
      return;
    }
    let n = parseInt(op ? op.value : "30", 10);
    if (!isFinite(n)) n = 30;
    n = Math.min(60, Math.max(5, n));
    setPref("pdfThemeCustomColor", v);
    setPref("pdfThemeCustomOpacity", n);
    setPref("pdfTheme", "custom");
    renderPdfList();
    msg("pp-pt-result", zh ? "✓ 已保存并应用到已打开的 PDF" : "✓ Saved & applied", true);
  }

  /* ---------- 初始化（DOM 就绪探测，模式与 prefs-pane.js 一致） ---------- */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !uiT() || !pdfT()) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-ui-theme-grid") || !$("pp-pdf-theme-list")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    renderUiGrid();
    loadCustomForm();
    renderPdfList();
    loadPdfCustomForm();

    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bind("pp-ut-apply", "click", applyCustom);
    bind("pp-pt-apply", "click", applyPdfCustom);
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
