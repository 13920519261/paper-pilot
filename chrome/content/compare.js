/* PaperPilot 多篇 PDF 并排对比 · 窗口逻辑（0.21.0）
 *
 * 结构：
 *   stage（position:relative）里放 N 个 .pp-cmp-pane（position:absolute，百分比定位）
 *   每个 pane = [面板头 hbox] + [<browser type=content> 内嵌 Zotero 阅读器预览]
 *
 * 关键约束与实证结论（写在这里免得后人重复踩）：
 *   1) 挂预览前必须等 <browser> 的 contentDocument.readyState 到 interactive/complete
 *      ——contentWindow 在 DOMContentLoaded 之前就存在，提前 createReader 会炸
 *      （官方 attachmentPreview.js 的同名注释就是这条坑）。
 *   2) Zotero.Reader.openPreview() 只负责构造 ReaderPreview，真正加载要自己
 *      `await reader._open({})`（官方调用序：openPreview → _open）。
 *   3) ReaderPreview 注入的 CSS 把 #viewerContainer 设成 overflow:hidden（悬停预览
 *      只要第一屏）。并排对比必须滚动，故再注入一条 !important 把它还原成 auto。
 *   4) 预览恒只读（ReaderPreview._isReadOnly() 返回 true）且 textLayerMode=0
 *      （不可划词）。面板内不提供新增标注，用「在阅读器中打开」跳正式阅读器。
 *   5) 同步滚动走容器 scrollTop/scrollHeight 的百分比映射；同步缩放走 pdf.js
 *      eventBus 的 scalechanging。两条都要防回环（suppress 标志 + 下一帧/延时释放）。
 */
(function () {
  "use strict";

  const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const args = (window.arguments && window.arguments[0]) || {};
  const Zotero = args.Zotero;
  const T = typeof args.t === "function" ? args.t : (k) => k;
  const MAX = Number(args.maxPanes) || 4;

  const panes = [];        // 面板记录
  let layout = (args.prefs && args.prefs.layout) || "auto";
  let syncScroll = !(args.prefs && args.prefs.syncScroll === false);
  let syncZoom = !!(args.prefs && args.prefs.syncZoom);
  let activeIdx = -1;
  let zoomGuard = false;

  /* ---------------- DOM 小工具 ---------------- */

  function xul(tag, attrs, style) {
    const el = document.createElementNS(XUL_NS, tag);
    if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (style) el.style.cssText = style;
    return el;
  }

  function html(tag, style, text) {
    const el = document.createElementNS(HTML_NS, tag);
    if (style) el.style.cssText = style;
    if (text != null) el.textContent = text;
    return el;
  }

  const $ = (id) => document.getElementById(id);
  const stage = () => $("pp-cmp-stage");

  function setStatus(msg) {
    try { $("pp-cmp-status").textContent = msg || ""; } catch (e) { /* ignore */ }
  }

  /* ---------------- 面板构建 ---------------- */

  function paneTitle(rec) {
    return rec.title || T("compareUnnamed");
  }

  function addPane(pdf) {
    if (panes.length >= MAX) {
      setStatus(T("compareLimitReached").replace("%n", String(MAX)));
      return false;
    }
    if (panes.some((p) => p.attID === pdf.id)) {
      setStatus(T("compareDuplicated"));
      return false;
    }

    const wrapper = xul("vbox", { class: "pp-cmp-pane" },
      "position:absolute;box-sizing:border-box;padding:2px;" +
      "display:flex;flex-direction:column;min-width:0;min-height:0;");

    const header = xul("hbox", { align: "center" },
      "flex:0 0 auto;gap:6px;padding:2px 6px;" +
      "background:var(--material-toolbar,#f2f2f2);" +
      "border:1px solid var(--material-border,#ccc);border-bottom:none;" +
      "border-radius:5px 5px 0 0;");

    const idxBadge = html("span",
      "flex:0 0 auto;font-size:10.5px;font-weight:700;color:var(--fill-secondary,#666);",
      "#" + (panes.length + 1));
    const titleEl = html("div",
      "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "font-size:11.5px;color:var(--fill-primary,#222);", "");
    const pageEl = html("span",
      "flex:0 0 auto;font-size:11px;color:var(--fill-secondary,#666);white-space:nowrap;", "");

    const openBtn = html("button",
      "flex:0 0 auto;font-size:11px;padding:0 7px;");
    openBtn.textContent = T("compareOpenInReader");
    openBtn.title = T("compareOpenInReaderHint");

    const closeBtn = html("button",
      "flex:0 0 auto;font-size:11px;padding:0 6px;");
    closeBtn.textContent = "✕";
    closeBtn.title = T("compareRemove");

    header.appendChild(idxBadge);
    header.appendChild(titleEl);
    header.appendChild(pageEl);
    header.appendChild(openBtn);
    header.appendChild(closeBtn);

    const browser = xul("browser", {
      type: "content",
      primary: "true",
      transparent: "transparent",
      tooltip: "iframeTooltip",
      src: "resource://zotero/reader/reader.html",
      flex: "1",
    }, "min-width:0;min-height:0;" +
       "border:1px solid var(--material-border,#ccc);border-radius:0 0 5px 5px;");

    wrapper.appendChild(header);
    wrapper.appendChild(browser);

    const rec = {
      attID: pdf.id,
      title: pdf.title || "",
      wrapper, header, browser, titleEl, pageEl, openBtn, closeBtn,
      reader: null, viewer: null, loaded: false,
    };
    panes.push(rec);

    titleEl.textContent = paneTitle(rec);

    // 点面板任意处置为「当前面板」（焦点面板）——非同步缩放时只作用于它
    wrapper.addEventListener("mousedown", () => { setActive(rec); }, true);
    wrapper.addEventListener("focusin", () => { setActive(rec); }, true);

    openBtn.addEventListener("click", () => {
      try { Zotero.Reader.open(rec.attID); } catch (e) { /* ignore */ }
    });
    closeBtn.addEventListener("click", () => removePane(rec));

    stage().appendChild(wrapper);
    applyLayout();
    updateCount();
    loadPane(rec);
    return true;
  }

  function setActive(rec) {
    const i = panes.indexOf(rec);
    if (i < 0 || i === activeIdx) return;
    activeIdx = i;
    for (const p of panes) {
      if (p === rec) {
        p.wrapper.style.boxShadow = "0 0 0 2px var(--color-accent,#0a84ff) inset";
      } else {
        p.wrapper.style.boxShadow = "";
      }
    }
  }

  function removePane(rec) {
    const i = panes.indexOf(rec);
    if (i < 0) return;
    try { if (rec.reader && rec.reader.uninit) rec.reader.uninit(); } catch (e) { /* ignore */ }
    try { if (rec.unsub) rec.unsub(); } catch (e) { /* ignore */ }
    try { rec.wrapper.remove(); } catch (e) { /* ignore */ }
    panes.splice(i, 1);
    if (activeIdx >= panes.length) activeIdx = panes.length - 1;
    applyLayout();
    updateCount();
  }

  function updateCount() {
    try {
      $("pp-cmp-count").textContent =
        T("compareCount").replace("%n", String(panes.length)).replace("%m", String(MAX));
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 加载单个预览 ---------------- */

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 等 <browser> 把 reader.html 真正跑起来。
   *  ⚠️ 只看 readyState 是不够的：新建 <browser> 的 about:blank 立刻就是
   *  "complete"，判定会过早通过；此时 reader.html 的 window.createReader 还没定义，
   *  而 ReaderPreview._open 内部把 createReader 的 TypeError 整个 try/catch 吞掉、
   *  只返回 false —— 面板于是空白且毫无报错（本功能第一次自检就是这么翻车的）。
   *  所以必须等到 createReader 真的可调用为止。 */
  async function waitBrowserReady(browser, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 20000);
    for (;;) {
      try {
        const w = browser.contentWindow;
        if (w) {
          let uw = null;
          try { uw = w.wrappedJSObject || w; } catch (e) { /* 跨隔间未就绪 */ }
          if (uw && typeof uw.createReader === "function") return true;
        }
      } catch (e) { /* docShell 还没挂上 */ }
      if (Date.now() > deadline) return false;
      await delay(40);
    }
  }

  /** 从 ReaderPreview 里挖出 pdf.js 视图（_primaryView 是 pdf.js 的 PDFView 包装） */
  function resolveViewer(rec) {
    const pick = (w) => {
      if (!w) return null;
      let uw = w;
      try { uw = w.wrappedJSObject || w; } catch (e) { /* 普通窗口 */ }
      const app = uw.PDFViewerApplication;
      if (!app || !app.pdfViewer) return null;
      let container = null;
      try { container = uw.document.getElementById("viewerContainer"); } catch (e) { /* ignore */ }
      return { win: uw, app, viewer: app.pdfViewer, container };
    };

    try {
      const ir = rec.reader && rec.reader._internalReader;
      const pv = ir && ir._primaryView;
      let hit = pick(pv && pv._iframeWindow);
      if (hit) return hit;
      // 兜底：扫 reader.html 里的 iframe 找 pdf.js 全局
      const rw = rec.reader && rec.reader._iframeWindow;
      if (rw && rw.document) {
        for (const f of rw.document.querySelectorAll("iframe")) {
          hit = pick(f.contentWindow);
          if (hit) return hit;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  /* ---------------- 可滚动性（0.21.1 核心修正） ----------------
   * 实测（Zotero 9.0.6 + 本功能自检）：
   *   预览打开后 pdf.js 的 `scrollMode` 是 **3 = PAGE（单页模式）**，DOM 里只有
   *   1 个 .page，`#viewerContainer` 的 scrollHeight≈clientHeight（20 页文档也只有
   *   7px 滚动范围）——用户看到的就是「PDF 页面无法滚动」。
   *   把 `scrollMode` 置回 **0 = VERTICAL（连续垂直）** 后，全部页参与布局，
   *   滚动范围立刻变成正常值（实测 20 页 → scrollHeight 8242 / clientHeight 407）。
   *   该赋值不会被阅读器改回去（实测 600ms 后仍为 0）。
   * 所以这里做两件事：① 强制连续垂直；② 注入 CSS 解禁 overflow（ReaderPreview
   * 把 #viewerContainer 设成 overflow:hidden，那是悬停预览「只看第一屏」的取舍）。
   */

  /** 注入/刷新面板内的可滚动样式（幂等且廉价：内容不变则不写 DOM） */
  const VIEWER_CSS =
    // overflow 简写 = 两轴 auto：竖向可滚，放大后横向也可滚（内容不会被裁掉）
    "#viewerContainer{overflow:auto !important;" +
    // 到边界不把滚动传给外层（对比窗口/另一面板），保证各面板互不干扰
    "overscroll-behavior:contain !important;" +
    // 显式允许触摸平移，触摸屏/触控板双指都能滚
    "touch-action:pan-x pan-y !important;}" +
    ".pdfViewer .page{border-radius:4px !important;}";

  function unclampViewer(v) {
    try {
      const d = v.win.document;
      let s = d.getElementById("pp-cmp-viewer-style");
      if (!s) {
        s = d.createElement("style");
        s.id = "pp-cmp-viewer-style";
        (d.head || d.documentElement).appendChild(s);
      }
      if (s.textContent !== VIEWER_CSS) s.textContent = VIEWER_CSS;
    } catch (e) { /* ignore */ }
  }

  /** 确保面板可正常滚动：连续垂直模式 + 解禁 overflow。
   *  缩放会重建页面布局，故每次缩放后也要再确认一次。 */
  function ensureScrollable(rec) {
    const v = rec && rec.viewer;
    if (!v) return;
    try {
      // 0 = pdf.js ScrollMode.VERTICAL；已是目标值时为 no-op（内部的 setter 会自行短路）
      if (v.viewer.scrollMode !== 0) v.viewer.scrollMode = 0;
    } catch (e) { /* ignore */ }
    unclampViewer(v);
  }

  function hookViewer(rec, v) {
    ensureScrollable(rec);
    try {
      if (v.container) {
        rec._onScroll = () => onPaneScroll(rec);
        v.container.addEventListener("scroll", rec._onScroll, { passive: true });
      }
    } catch (e) { /* ignore */ }
    try {
      v.app.eventBus.on("updateviewarea", (ev) => {
        try {
          const loc = (ev && ev.location) || {};
          const total = v.viewer.pagesCount || "?";
          rec.pageEl.textContent = loc.pageNumber ? (loc.pageNumber + " / " + total) : "";
        } catch (e) { /* ignore */ }
      });
      v.app.eventBus.on("scalechanging", () => onPaneScale(rec));
      // 文档页布局完成后（首次 + 缩放后）再确认一次连续滚动
      v.app.eventBus.on("pagesloaded", () => ensureScrollable(rec));
      rec._scaleEvtHooked = true;
    } catch (e) { /* eventBus 缺失时同步缩放降级为仅工具栏按钮生效 */ }
  }

  async function loadPane(rec) {
    setPaneMessage(rec, T("compareLoading"));
    const ok = await waitBrowserReady(rec.browser);
    if (!ok) { setPaneMessage(rec, T("compareLoadFailed") + "reader.html 未就绪"); return; }
    try {
      rec.reader = await Zotero.Reader.openPreview(rec.attID, rec.browser);
      // ReaderPreview._open 内部 try/catch 会吞异常并 return false —— 必须看返回值，
      // 否则失败与成功无法区分，用户只会看到一块空白面板。
      const opened = await rec.reader._open({});
      if (opened === false || !rec.reader._internalReader) {
        setPaneMessage(rec, T("compareViewUnavailable"));
        return;
      }
      rec.loaded = true;
      const v = resolveViewer(rec);
      if (v) {
        rec.viewer = v;
        hookViewer(rec, v);
        setPaneMessage(rec, "");
        // 阅读器可能在文档就绪后再套一次自己的视图状态：延迟一拍再确认，
        // 防止「打开时能滚、过一会儿又不能滚」。
        setTimeout(() => ensureScrollable(rec), 800);
      } else {
        setPaneMessage(rec, T("compareViewUnavailable"));
      }
    } catch (e) {
      setPaneMessage(rec, T("compareLoadFailed") + " " + shortErr(e));
      try { Zotero.logError(e); } catch (e2) { /* ignore */ }
    }
  }

  function shortErr(e) {
    const m = String((e && e.message) || e || "");
    return m.length > 120 ? m.slice(0, 120) + "…" : m;
  }

  function setPaneMessage(rec, msg) {
    try {
      if (!msg) {
        if (rec._msgEl) { rec._msgEl.remove(); rec._msgEl = null; }
        rec.browser.style.visibility = "";
        return;
      }
      rec.browser.style.visibility = "hidden";
      if (!rec._msgEl) {
        const el = html("div",
          "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
          "padding:14px;text-align:center;font-size:12px;" +
          "color:var(--fill-secondary,#666);pointer-events:none;");
        rec._msgEl = el;
        rec.wrapper.appendChild(el);
      }
      rec._msgEl.textContent = msg;
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 布局 ---------------- */

  function applyLayout() {
    const n = panes.length;
    if (!n) return;
    let mode = layout;
    if (mode === "auto") mode = n <= 3 ? "h" : "grid";
    if (mode === "grid" && n <= 3) mode = "h";

    panes.forEach((p, i) => {
      const st = p.wrapper.style;
      if (mode === "v") {
        st.left = "0%"; st.top = (i * 100 / n) + "%";
        st.width = "100%"; st.height = (100 / n) + "%";
      } else if (mode === "grid") {
        const c = i % 2, r = Math.floor(i / 2);
        st.left = (c * 50) + "%"; st.top = (r * 50) + "%";
        st.width = "50%"; st.height = "50%";
      } else { // h
        st.left = (i * 100 / n) + "%"; st.top = "0%";
        st.width = (100 / n) + "%"; st.height = "100%";
      }
    });
  }

  /* ---------------- 同步滚动 ----------------
   * 程序化滚动会打出「自己触发自己」的 scroll 事件，必须只吞掉这些回声。
   * 旧实现用布尔 guard + rAF 释放：窗口被遮挡/最小化时 rAF 不触发，guard 会永久
   * 卡住，之后所有同步静默失效。改成「每个滚动容器一个待吞计数」，不依赖帧回调；
   * 再加 300ms 兜底清零，防止「赋的值没变→没有 scroll 事件」导致计数泄漏。 */

  function ratio(cur, total, view) {
    const max = Math.max(0, total - view);
    return max > 0 ? Math.min(1, Math.max(0, cur / max)) : 0;
  }

  function markSkip(rec) {
    const c = rec.viewer && rec.viewer.container;
    if (!c) return;
    c.__ppSkip = (c.__ppSkip || 0) + 1;
    if (!c.__ppSkipTimer) {
      c.__ppSkipTimer = setTimeout(() => { c.__ppSkip = 0; c.__ppSkipTimer = null; }, 300);
    }
  }

  function takeSkip(container) {
    if (!container) return false;
    if (container.__ppSkip > 0) { container.__ppSkip--; return true; }
    return false;
  }

  function onPaneScroll(src) {
    const sc = src.viewer && src.viewer.container;
    if (!sc) return;
    if (takeSkip(sc)) return;      // 自己刚设的值引起的回声：吞掉，不扩散
    if (!syncScroll) return;       // 关闭同步 = 各面板完全独立滚动
    const vr = ratio(sc.scrollTop, sc.scrollHeight, sc.clientHeight);
    const hr = ratio(sc.scrollLeft, sc.scrollWidth, sc.clientWidth);
    for (const p of panes) {
      if (p === src) continue;
      const t = p.viewer && p.viewer.container;
      if (!t) continue;
      try {
        const top = vr * Math.max(0, t.scrollHeight - t.clientHeight);
        const left = hr * Math.max(0, t.scrollWidth - t.clientWidth);
        if (Math.abs(t.scrollTop - top) <= 0.5 && Math.abs(t.scrollLeft - left) <= 0.5) continue;
        markSkip(p);
        t.scrollTop = top;
        t.scrollLeft = left;
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- 同步缩放 ---------------- */

  function onPaneScale(src) {
    if (!syncZoom || zoomGuard) return;
    const v = src.viewer;
    if (!v) return;
    let target;
    try { target = String(v.viewer.currentScale); } catch (e) { return; }
    zoomGuard = true;
    for (const p of panes) {
      if (p === src) continue;
      const pv = p.viewer;
      if (!pv) continue;
      try { pv.viewer.currentScaleValue = target; } catch (e) { /* ignore */ }
    }
    setTimeout(() => { zoomGuard = false; }, 80);
  }

  /** 缩放：同步开时作用于全部面板，否则只作用于当前面板。
   *  缩放会重建页面布局（scrollHeight 变化），故之后再确认一次
   *  「连续垂直 + 可滚」——保证放大后滚动范围跟着更新。 */
  function zoom(kind) {
    const targets = syncZoom ? panes.slice() : [panes[activeIdx >= 0 ? activeIdx : 0]].filter(Boolean);
    if (!targets.length) {
      setStatus(T("compareNoFocus"));
      return;
    }
    for (const p of targets) {
      const v = p.viewer;
      if (!v) continue;
      try {
        if (kind === "fit") {
          v.viewer.currentScaleValue = "page-width";
        } else {
          const cur = Number(v.viewer.currentScale) || 1;
          const next = kind === "in" ? cur * 1.2 : cur / 1.2;
          v.viewer.currentScaleValue = String(Math.min(6, Math.max(0.2, next)));
        }
      } catch (e) { /* ignore */ }
      // 布局是异步的：稍后再确认一次，确保放大后的滚动范围立刻可用
      setTimeout(() => ensureScrollable(p), 150);
    }
  }

  /* ---------------- 「添加选中文献」 ---------------- */

  let adding = false;
  async function addFromSelection() {
    if (adding) return;
    if (panes.length >= MAX) {
      setStatus(T("compareLimitReached").replace("%n", String(MAX)));
      return;
    }
    if (typeof args.resolveSelected !== "function") return;
    adding = true;
    setStatus(T("compareReadingSelection"));
    try {
      const pdfs = await args.resolveSelected();
      if (!pdfs || !pdfs.length) {
        setStatus(T("compareNoSelectionPdf"));
        return;
      }
      let added = 0;
      for (const pdf of pdfs) {
        if (panes.length >= MAX) break;
        if (addPane(pdf)) added++;
      }
      setStatus(added ? T("compareAdded").replace("%n", String(added)) : T("compareNothingAdded"));
    } catch (e) {
      setStatus(T("compareLoadFailed") + " " + shortErr(e));
    } finally {
      adding = false;
    }
  }

  /* ---------------- 工具栏接线 ---------------- */

  function wireToolbar() {
    const zh = !!args.isZh;

    try { $("pp-cmp-layout-label").textContent = T("compareLayout"); } catch (e) { /* ignore */ }
    const opt = (id, text) => { try { $(id).setAttribute("label", text); } catch (e) { /* ignore */ } };
    opt("pp-cmp-layout-auto", T("compareLayoutAuto"));
    opt("pp-cmp-layout-h", T("compareLayoutH"));
    opt("pp-cmp-layout-v", T("compareLayoutV"));
    opt("pp-cmp-layout-grid", T("compareLayoutGrid"));

    try {
      $("pp-cmp-layout").value = layout;
      $("pp-cmp-layout").addEventListener("command", (ev) => {
        layout = ev.target.value || "auto";
        applyLayout();
        if (args.setPref) args.setPref("compareLayout", layout);
      });
    } catch (e) { /* ignore */ }

    try {
      const sc = $("pp-cmp-sync-scroll");
      sc.setAttribute("label", T("compareSyncScroll"));
      sc.checked = syncScroll;
      sc.addEventListener("command", () => {
        syncScroll = !!sc.checked;
        if (args.setPref) args.setPref("compareSyncScroll", syncScroll);
      });
    } catch (e) { /* ignore */ }

    try {
      const sz = $("pp-cmp-sync-zoom");
      sz.setAttribute("label", T("compareSyncZoom"));
      sz.checked = syncZoom;
      sz.addEventListener("command", () => {
        syncZoom = !!sz.checked;
        if (args.setPref) args.setPref("compareSyncZoom", syncZoom);
      });
    } catch (e) { /* ignore */ }

    const bindBtn = (id, text, title, fn) => {
      try {
        const b = $(id);
        b.textContent = text;
        b.title = title;
        b.addEventListener("click", fn);
      } catch (e) { /* ignore */ }
    };
    bindBtn("pp-cmp-zoom-out", "−", T("compareZoomOut"), () => zoom("out"));
    bindBtn("pp-cmp-zoom-fit", zh ? "适宽" : "Fit", T("compareZoomFit"), () => zoom("fit"));
    bindBtn("pp-cmp-zoom-in", "+", T("compareZoomIn"), () => zoom("in"));
    bindBtn("pp-cmp-add", T("compareAddSelected"), T("compareAddSelectedHint"), addFromSelection);

    document.title = T("compareWindowTitle");
    updateCount();
  }

  /* ---------------- 启动 / 卸载 ---------------- */

  function boot() {
    if (!Zotero || !Zotero.Reader || !Zotero.Reader.openPreview) {
      setStatus(T("compareApiUnavailable"));
      return;
    }
    wireToolbar();
    const initial = (args.panes || []).slice();
    if (!initial.length) {
      setStatus(T("compareEmptyHint"));
      return;
    }
    for (const pdf of initial) {
      if (panes.length >= MAX) break;
      addPane(pdf);
    }
    activeIdx = panes.length ? 0 : -1;
    if (panes[0]) setActive(panes[0]);
  }

  // 供开窗方（PdfCompare.openWith，窗口已存在时）追加面板
  window.ppCompareAddMany = function (list) {
    try {
      window.focus();
      for (const pdf of list || []) {
        if (panes.length >= MAX) break;
        addPane(pdf);
      }
    } catch (e) { /* ignore */ }
  };

  /* 诊断快照（只读）：排障时用来判断「面板是不是真的挂上了 PDF 视图」——
   * 内嵌预览失败是静默的（面板空白），没有这个就只能靠猜。
   * 由 PdfCompare.selfTest() 与人工在浏览器/终端排障时调用。 */
  window.ppCompareSnapshot = function () {
    return panes.map((p, i) => {
      const d = diagnose(p);
      return {
        index: i + 1,
        attID: p.attID,
        title: String(p.title || "").slice(0, 60),
        loaded: !!p.loaded,
        hasViewer: !!p.viewer,
        pages: p.viewer ? (p.viewer.viewer.pagesCount || 0) : 0,
        scale: p.viewer ? p.viewer.viewer.currentScale : 0,
        pageLabel: p.pageEl ? p.pageEl.textContent : "",
        message: p._msgEl ? p._msgEl.textContent : "",
        layout: { left: p.wrapper.style.left, top: p.wrapper.style.top, width: p.wrapper.style.width, height: p.wrapper.style.height },
        diag: d,
      };
    });
  };

  /** 逐层探测视图句柄的可达性（排障专用；正常路径不走这里） */
  function diagnose(p) {
    const d = {};
    const t = (fn, key) => { try { d[key] = fn(); } catch (e) { d[key] = "ERR:" + (e && e.message); } };
    t(() => !!p.reader, "hasReader");
    t(() => !!(p.reader && p.reader._internalReader), "hasInternalReader");
    t(() => {
      const ir = p.reader && p.reader._internalReader;
      return ir ? Object.getOwnPropertyNames(ir).slice(0, 40) : null;
    }, "internalReaderKeys");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      return pv ? Object.getOwnPropertyNames(pv).slice(0, 40) : null;
    }, "primaryViewKeys");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      return !!w;
    }, "hasPvWin");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      if (!w) return null;
      return Object.getOwnPropertyNames(w).filter((k) => /pdf|PDF|view|View|reader/.test(k)).slice(0, 25);
    }, "pvWinGlobals");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      if (!w) return null;
      return String((w.location && w.location.href) || "");
    }, "pvWinHref");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      return w ? typeof w.PDFViewerApplication : null;
    }, "pvWinAppType");
    t(() => {
      const pv = p.reader && p.reader._internalReader && p.reader._internalReader._primaryView;
      const w = pv && pv._iframeWindow;
      return w ? typeof w.wrappedJSObject : null;
    }, "pvWinWrappedType");
    t(() => {
      const rw = p.reader && p.reader._iframeWindow;
      if (!rw || !rw.document) return null;
      const out = [];
      for (const f of rw.document.querySelectorAll("iframe")) out.push(f.getAttribute("src") || "(no-src)");
      return out;
    }, "readerIframes");
    t(() => {
      const rw = p.reader && p.reader._iframeWindow;
      return rw ? typeof rw.PDFViewerApplication : null;
    }, "readerWinAppType");
    return d;
  }

  /** 同步滚动探针（排障/自检用）：真的滚一下第一个面板，回报其他面板是否跟着走，
   *  并顺带回报容器 overflow 是否已被解禁（ReaderPreview 默认把它设成 hidden）。 */
  window.ppCompareSyncProbe = function () {
    const src = panes.find((p) => p.viewer && p.viewer.container);
    if (!src) return Promise.resolve(null);
    const sc = src.viewer.container;
    let overflowY = "";
    try { overflowY = sc.ownerDocument.defaultView.getComputedStyle(sc).overflowY; } catch (e) { /* ignore */ }
    const maxV = Math.max(0, sc.scrollHeight - sc.clientHeight);
    const before = panes.filter((p) => p !== src).map((p) => (p.viewer && p.viewer.container ? p.viewer.container.scrollTop : -1));
    sc.scrollTop = Math.round(maxV * 0.5);
    // 派发真实 scroll 事件，走的就是面板上挂的那个监听器（不直接调内部函数）
    try {
      const evt = sc.ownerDocument.createEvent("Event");
      evt.initEvent("scroll", false, false);
      sc.dispatchEvent(evt);
    } catch (e) { /* ignore */ }
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          overflowY,
          srcMaxScroll: maxV,
          srcScrollTop: sc.scrollTop,
          othersBefore: before,
          othersAfter: panes.filter((p) => p !== src).map((p) => {
            if (!p.viewer || !p.viewer.container) return null;
            const c = p.viewer.container;
            const m = Math.max(0, c.scrollHeight - c.clientHeight);
            return {
              scrollTop: c.scrollTop,
              max: m,
              ratio: m > 0 ? Number((c.scrollTop / m).toFixed(3)) : 0,
            };
          }),
        });
      }, 200);
    });
  };

  /** 滚动结构探针（排障用）：回答「到底有没有内容可滚、真正的滚动容器是谁」。
   *  只看 overflow 是不够的——overflow:auto 但 scrollHeight≈clientHeight 时
   *  用户看到的就是「滚不动」。 */
  window.ppCompareScrollProbe = function () {
    const facts = panes.map((p, i) => {
      const out = { pane: i + 1, attID: p.attID, hasViewer: !!p.viewer };
      if (!p.viewer) return out;
      const v = p.viewer;
      try {
        const sc = v.container;
        const cs = sc ? v.win.getComputedStyle(sc) : null;
        out.scrollMode = v.viewer.scrollMode;          // 0=连续垂直，3=单页(滚不动)
        out.pageEls = v.win.document.querySelectorAll(".page").length;
        out.clientHeight = sc ? sc.clientHeight : -1;
        out.scrollHeight = sc ? sc.scrollHeight : -1;
        out.maxScroll = sc ? Math.max(0, sc.scrollHeight - sc.clientHeight) : -1;
        out.overflowY = cs ? cs.overflowY : "?";
        out.overscroll = cs ? cs.overscrollBehaviorY : "?";
        out.scaleValue = v.viewer.currentScaleValue;
      } catch (e) { out.err = String(e && e.message); }
      return out;
    });

    // A) 同步滚动开：滚面板1，其余应跟到同一比例
    // B) 同步滚动关：其余必须完全不动（面板间互不干扰）
    const fire = (c) => {
      try {
        const ev = c.ownerDocument.createEvent("Event");
        ev.initEvent("scroll", false, false);
        c.dispatchEvent(ev);
      } catch (e) { /* ignore */ }
    };

    return new Promise((resolve) => {
      const first = panes.find((p) => p.viewer && p.viewer.container);
      if (!first) { resolve({ facts, sync: null }); return; }
      const sc = first.viewer.container;
      const others = () => panes.filter((p) => p !== first && p.viewer && p.viewer.container);

      // 滚轮能不能滚，取决于面板中心点上「最顶层」的元素是否把事件交给滚动容器。
      // 用 elementFromPoint 直接看命中谁（比派发 untrusted 事件可靠：合成事件
      // 不会触发浏览器默认滚动行为）。
      let hit = null;
      try {
        const d = first.viewer.win.document;
        const el = d.elementFromPoint(Math.round(sc.clientWidth / 2), Math.round(sc.clientHeight / 2));
        hit = el ? { tag: el.tagName, id: el.id || "", cls: String(el.className || "").slice(0, 60), inScroller: sc.contains(el) } : null;
      } catch (e) { hit = "ERR:" + (e && e.message); }

      const wasOn = syncScroll;
      syncScroll = true;
      sc.scrollTop = Math.round(Math.max(0, sc.scrollHeight - sc.clientHeight) * 0.5);
      fire(sc);

      setTimeout(() => {
        const onRatio = others().map((p) => {
          const c = p.viewer.container;
          const m = Math.max(0, c.scrollHeight - c.clientHeight);
          return m > 0 ? Number((c.scrollTop / m).toFixed(3)) : 0;
        });

        syncScroll = false;
        const beforeOff = others().map((p) => p.viewer.container.scrollTop);
        sc.scrollTop = 0;
        fire(sc);

        setTimeout(() => {
          const offAfter = others().map((p) => p.viewer.container.scrollTop);
          syncScroll = wasOn;

          // C) 缩放后滚动范围是否跟着更新（用户明确要求）
          const zBefore = { scale: Number(first.viewer.viewer.currentScale.toFixed(4)), max: Math.max(0, sc.scrollHeight - sc.clientHeight) };
          zoom("in");
          setTimeout(() => {
            const zAfter = {
              scale: Number(first.viewer.viewer.currentScale.toFixed(4)),
              max: Math.max(0, sc.scrollHeight - sc.clientHeight),
              scrollMode: first.viewer.viewer.scrollMode,
              pageEls: first.viewer.win.document.querySelectorAll(".page").length,
            };
            resolve({
              facts,
              wheelHit: hit,
              syncOn: { srcRatio: 0.5, othersRatios: onRatio },
              syncOff: { othersBefore: beforeOff, othersAfter: offAfter, moved: offAfter.some((v, i) => v !== beforeOff[i]) },
              zoom: { before: zBefore, after: zAfter, maxGrew: zAfter.max > zBefore.max },
            });
          }, 900);
        }, 250);
      }, 250);
    });
  };

  window.addEventListener("unload", () => {
    for (const p of panes) {
      try { if (p.reader && p.reader.uninit) p.reader.uninit(); } catch (e) { /* ignore */ }
    }
    panes.length = 0;
    try {
      if (Zotero && Zotero.PaperPilot && Zotero.PaperPilot.pdfCompare) {
        Zotero.PaperPilot.pdfCompare.onWindowClosed();
      }
    } catch (e) { /* ignore */ }
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("DOMContentLoaded", boot, { once: true });
  }
})();
