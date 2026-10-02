/* PaperPilot 设置窗格 · 主题系统交互脚本（0.17.0 主题库版）
 * 由 Zotero.PreferencePanes.register({scripts:[...]}) 注入设置窗口执行。
 * 主题库/壁纸引擎经 Zotero.PaperPilot.uiTheme / pdfTheme 访问（主模块挂载）。
 * 交互：分类卡片网格（壁纸缩略预览）→ 点击即应用（一键切换，pref 持久化，
 * 重启自动恢复）；自定义主题 = 自定义配色 + 自定义壁纸文件（图片/视频）。
 */
/* global Zotero, Components, Services, window, document */

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

  /* ==================== 主题库卡片 ==================== */

  function themeCard(t, selected) {
    const card = h("div");
    card.setAttribute("class", "pp-theme-card" + (selected ? " pp-theme-on" : ""));
    const sw = h("div");
    sw.setAttribute("class", "pp-theme-swatches pp-wp-preview");
    const mod = uiT();
    if (t.wp && t.wp.svg && mod) {
      // 壁纸缩略：SVG 作背景图（静态渲染——动态壁纸缩略取首帧，正合适）
      sw.style.backgroundImage = 'url("' + mod._svgURI(t.wp.svg) + '")';
      sw.style.backgroundSize = "cover";
      sw.style.backgroundPosition = "center";
    } else if (t.colors) {
      const c = t.colors;
      for (const col of [c.background, c.side, c.surface, c.accent]) {
        const chip = h("span");
        chip.setAttribute("class", "pp-theme-chip");
        chip.style.background = col;
        sw.appendChild(chip);
      }
    }
    const label = h("div");
    label.setAttribute("class", "pp-theme-name");
    const icon = t.anim ? "⚡ " : (t.dark ? "🌙 " : "☀️ ");
    label.textContent = icon + t.name;
    card.appendChild(sw);
    card.appendChild(label);
    if (t.badge) {
      const tag = h("div");
      tag.setAttribute("class", "pp-theme-tag");
      tag.textContent = t.badge;
      card.appendChild(tag);
    }
    card.addEventListener("click", () => {
      try {
        if (t.id === "custom") {
          applyCustom(); // 自定义主题：把表单色板写入并应用
        } else if (t.id === "") {
          setPref("uiTheme", "");
          renderAll();
        } else {
          // 一键切换 = 配色 + 壁纸 + 推荐可见度（与主模块 setTheme 同语义）
          setPref("uiTheme", t.id);
          const wpMode = String(getPref("uiWallpaper", "theme") || "theme");
          if (wpMode !== "off" && wpMode !== "custom") setPref("uiWallpaper", "theme");
          if (typeof t.wpOpacity === "number") setPref("uiWallpaperOpacity", t.wpOpacity);
          renderAll();
        }
      } catch (e) { /* ignore */ }
    });
    return card;
  }

  function renderThemeLibrary() {
    const mod = uiT();
    const special = $("pp-ui-special");
    if (!special || !mod) return;
    try { mod._resolveSVGs(); } catch (e) { /* 确保 wp.svg 占位符已展开 */ }
    const cur = String(getPref("uiTheme", "") || "");
    // 特殊卡：跟随原生 + 自定义主题
    while (special.firstChild) special.removeChild(special.firstChild);
    special.appendChild(themeCard({
      id: "", name: zh ? "跟随 Zotero 原生" : "Follow native", dark: false,
      badge: zh ? "默认" : "Default",
      colors: { background: "#ffffff", side: "#f0f0f0", surface: "#d9d9d9", accent: "#666666" },
    }, cur === ""));
    const cc = mod.customColors();
    special.appendChild(themeCard({
      id: "custom", name: zh ? "自定义主题" : "Custom theme", dark: !!cc.__dark,
      badge: zh ? "配色+壁纸全自定义" : "Fully custom",
      colors: {
        background: cc.background || "#ffffff",
        side: cc.side || "#f6f8fa",
        surface: cc.surface || "#ffffff",
        accent: cc.accent || "#0969da",
      },
    }, cur === "custom"));
    // 分类卡（标准 / 动漫 / 风景 / 动态）
    for (const cat of ["standard", "anime", "scenery", "dynamic"]) {
      const grid = $("pp-cat-" + cat);
      if (!grid) continue;
      while (grid.firstChild) grid.removeChild(grid.firstChild);
      for (const t of mod.THEMES) {
        if (t.cat !== cat) continue;
        grid.appendChild(themeCard(
          Object.assign({}, t, { anim: t.wp && t.wp.anim }),
          cur === t.id
        ));
      }
    }
  }

  /* ==================== 外观参数 ==================== */

  function isVideoPath(p) {
    return /\.(mp4|webm|mkv|mov|m4v|ogv)$/i.test(String(p || ""));
  }

  function refreshCustomPreview() {
    const box = $("pp-wp-custom-preview");
    if (!box) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    const path = String(getPref("uiWallpaperPath", "") || "");
    if (!path) { box.style.display = "none"; return; }
    box.style.display = "block";
    try {
      const file = Zotero.File.pathToFile(path);
      if (!file.exists()) {
        const warn = h("div");
        warn.setAttribute("class", "pp-hint");
        warn.style.color = "var(--pp-danger)";
        warn.textContent = zh ? "⚠ 文件不存在或不可读" : "⚠ File not found";
        box.appendChild(warn);
        return;
      }
      const url = Services.io.newFileURI(file).spec;
      let el;
      if (isVideoPath(path)) {
        el = h("video");
        el.src = url;
        el.muted = true;
        el.loop = true;
        el.autoplay = true;
        el.setAttribute("playsinline", "");
        try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
      } else {
        el = h("img");
        el.src = url;
      }
      el.style.cssText =
        "max-width:280px;max-height:150px;border-radius:8px;border:1px solid var(--pp-border);object-fit:cover;display:block;";
      box.appendChild(el);
      const cap = h("div");
      cap.setAttribute("class", "pp-hint");
      cap.style.marginTop = "4px";
      cap.textContent = isVideoPath(path)
        ? (zh ? "视频壁纸预览（静音循环）" : "Video preview (muted loop)")
        : (zh ? "图片预览" : "Image preview");
      box.appendChild(cap);
    } catch (e) { /* ignore */ }
  }

  function initAppearanceControls() {
    // 壁纸模式
    const mode = $("pp-wp-mode");
    const customRow = $("pp-wp-custom-row");
    const syncModeUI = () => {
      const v = mode ? mode.value : "theme";
      if (customRow) customRow.style.display = v === "custom" ? "flex" : "none";
      if (v === "custom") refreshCustomPreview();
      else {
        const box = $("pp-wp-custom-preview");
        if (box) box.style.display = "none";
      }
    };
    if (mode) {
      mode.value = String(getPref("uiWallpaper", "theme") || "theme");
      mode.addEventListener("change", () => {
        setPref("uiWallpaper", mode.value);
        syncModeUI();
      });
    }
    // 可见度滑条
    const slider = $("pp-wp-opacity");
    const label = $("pp-wp-opacity-label");
    if (slider) {
      slider.value = String(getPref("uiWallpaperOpacity", 70));
      const sync = () => {
        if (label) label.textContent = slider.value + "%";
        setPref("uiWallpaperOpacity", parseInt(slider.value, 10) || 70);
      };
      slider.addEventListener("input", sync);
      sync();
    }
    // 自定义文件路径 + 浏览（图片 + 视频）
    const path = $("pp-wp-path");
    if (path) {
      path.value = String(getPref("uiWallpaperPath", "") || "");
      path.addEventListener("change", () => {
        setPref("uiWallpaperPath", path.value.trim());
        refreshCustomPreview();
      });
    }
    const browse = $("pp-wp-browse");
    if (browse) {
      browse.addEventListener("click", () => {
        try {
          const nsIFilePicker = Components.interfaces.nsIFilePicker;
          const fp = Components.classes["@mozilla.org/filepicker;1"]
            .createInstance(nsIFilePicker);
          fp.init(window, zh ? "选择壁纸文件（图片或视频）" : "Choose wallpaper (image/video)", nsIFilePicker.modeOpen);
          fp.appendFilter(zh ? "图片与视频" : "Images & Videos",
            "*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.mp4;*.webm;*.mkv;*.mov;*.m4v;*.ogv");
          fp.appendFilter(zh ? "图片" : "Images", "*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp");
          fp.appendFilter(zh ? "视频" : "Videos", "*.mp4;*.webm;*.mkv;*.mov;*.m4v;*.ogv");
          fp.open((rv) => {
            if (rv !== nsIFilePicker.returnOK || !fp.file) return;
            const p = fp.file.path;
            setPref("uiWallpaperPath", p);
            setPref("uiWallpaper", "custom");
            if (path) path.value = p;
            if (mode) mode.value = "custom";
            syncModeUI();
          });
        } catch (e) { /* ignore */ }
      });
    }
    syncModeUI();
  }

  /* ==================== 自定义配色表单 ==================== */

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
    renderAll();
    msg("pp-ut-result", zh ? "✓ 已应用自定义主题" : "✓ Custom theme applied", true);
  }

  /* ==================== PDF 阅读主题 ==================== */

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

  /* ==================== 初始化 ==================== */

  function renderAll() {
    renderThemeLibrary();
    initAppearanceControls();
    renderPdfList();
  }

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !uiT() || !pdfT()) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-cat-anime") || !$("pp-pdf-theme-list") || !$("pp-wp-mode")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    renderAll();
    loadCustomForm();
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
