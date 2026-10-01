/* PaperPilot 设置窗格脚本（0.14.0 重构）
 * 由 Zotero.PreferencePanes.register({scripts:[...]}) 注入设置窗口执行。
 * 运行上下文是设置窗口：访问不到 bootstrap 作用域，但可经 Zotero.PaperPilot
 * 访问主模块暴露的 rankColumn / citationColumn。
 * 账号与 AI 模型通道的 UI 逻辑在 prefs-account.js（同一窗格的第二个脚本）。
 *
 * ⚠️ Zotero 先加载本脚本、后插入 fragment DOM（_loadPane 顺序）——init 必须
 * 探测关键节点、不存在就延迟重试，否则 null 崩溃导致面板永远不 loaded。
 */
/* global Zotero, Components, window, document */

(function () {
  const PREFIX = "extensions.zotero.paperpilot.";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const txt = {
    pickJson: zh ? "选择分区数据 JSON" : "Select rank data JSON",
    cacheCleared: zh ? "缓存已清空" : "Cache cleared",
  };

  const $ = (id) => document.getElementById(id);
  const rankColumn = () => Zotero.PaperPilot && Zotero.PaperPilot.rankColumn;

  const getPref = (key, fallback) => {
    try {
      const v = Zotero.Prefs.get(PREFIX + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) { return fallback; }
  };

  function setText(id, msg, color) {
    const el = $(id);
    if (el) { el.textContent = msg; el.style.color = color || "#888"; }
  }

  /* ---------- easyScholar ---------- */

  function refreshEsStats() {
    try {
      setText("pp-es-stats", (zh ? "缓存条目：" : "Cached: ") + rankColumn().esCacheSize(), "#888");
    } catch (e) { /* ignore */ }
  }

  async function onEsClear() {
    try { await rankColumn().esClearCache(); } catch (e) { /* ignore */ }
    refreshEsStats();
    setText("pp-es-stats", txt.cacheCleared, "#1e7d32");
  }

  /* ---------- Semantic Scholar 被引量 ---------- */

  const citationColumn = () => Zotero.PaperPilot && Zotero.PaperPilot.citationColumn;

  function refreshS2Stats() {
    try {
      setText("pp-s2-stats", (zh ? "缓存条目：" : "Cached: ") + citationColumn().cacheSize(), "#888");
    } catch (e) { /* ignore */ }
  }

  async function onS2Clear() {
    try { await citationColumn().clearCache(); } catch (e) { /* ignore */ }
    refreshS2Stats();
    setText("pp-s2-stats", txt.cacheCleared, "#1e7d32");
  }

  /* ---------- 分区数据文件选择 ---------- */

  function browseRankData() {
    const nsIFilePicker = Components.interfaces.nsIFilePicker;
    const fp = Components.classes["@mozilla.org/filepicker;1"]
      .createInstance(nsIFilePicker);
    fp.init(window, txt.pickJson, nsIFilePicker.modeOpen);
    fp.appendFilter("JSON", "*.json");
    fp.open((rv) => {
      if (rv !== nsIFilePicker.returnOK || !fp.file) return;
      const path = fp.file.path;
      Zotero.Prefs.set(PREFIX + "rankDataPath", path, true);
      const input = $("pp-rank-path-input");
      if (input) input.value = path;
    });
  }

  /* ---------- 敏感信息掩码：👁 切换明文/隐藏 ---------- */

  function bindEye(inputId, btnId) {
    const input = $(inputId), btn = $(btnId);
    if (!input || !btn) return;
    btn.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.style.opacity = show ? "1" : "0.55";
      btn.title = show ? (zh ? "点击隐藏" : "Click to hide") : (zh ? "点击显示" : "Click to show");
    });
    btn.style.opacity = "0.55";
  }

  /* ---------- 初始化（DOM 就绪探测） ---------- */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !rankColumn()) {
      window.setTimeout(init, 400);
      return;
    }
    // Zotero 先执行脚本、后插入 fragment：关键节点不存在就延迟重试
    if (!$("pp-es-clear") || !$("pp-s2-clear")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    try { refreshEsStats(); } catch (e) { /* ignore */ }
    try { refreshS2Stats(); } catch (e) { /* ignore */ }

    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bind("pp-es-clear", "click", onEsClear);
    bind("pp-s2-clear", "click", onS2Clear);
    bind("pp-rank-browse", "click", browseRankData);
    // 敏感字段掩码切换（账号服务器 / easyScholar Key / S2 Key）
    bindEye("pp-account-server", "pp-account-server-eye");
    bindEye("pp-es-key", "pp-es-key-eye");
    bindEye("pp-s2-key", "pp-s2-key-eye");
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
