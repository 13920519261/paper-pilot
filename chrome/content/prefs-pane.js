/* PaperPilot 设置窗格脚本（0.5.0 重写）
 * 由 Zotero.PreferencePanes.register({scripts:[...]}) 注入设置窗口执行。
 * 运行上下文是设置窗口：访问不到 bootstrap 作用域，但可经 Zotero.PaperPilot
 * 访问主模块暴露的 providers / rankColumn。
 *
 * ⚠️ Zotero 先加载本脚本、后插入 fragment DOM（_loadPane 顺序）——init 必须
 * 探测关键节点、不存在就延迟重试，否则 null 崩溃导致面板永远不 loaded。
 */
/* global Zotero, Components, window, document */

(function () {
  const PREFIX = "extensions.zotero.paperpilot.";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const txt = {
    testing: zh ? "测试中…" : "Testing…",
    ok: (model) => zh ? `连接成功（${model}）` : `Connected (${model})`,
    noKey: zh ? "请先填写 API Key" : "Please fill in the API key first",
    noBase: zh ? "请先填写 Base URL" : "Please fill in the Base URL first",
    noModel: zh ? "请选择或填写模型" : "Please select or enter a model",
    fail: zh ? "连接失败" : "Connection failed",
    pickJson: zh ? "选择分区数据 JSON" : "Select rank data JSON",
    detecting: zh ? "探测中（并发请求各服务商）…" : "Detecting provider…",
    detected: (name, n) => zh ? `✓ 识别为「${name}」，拉到 ${n} 个可用模型` : `✓ Detected: ${name}, ${n} models`,
    detectFail: zh ? "✗ 探测失败：" : "✗ Detect failed: ",
    profileSaved: zh ? "✓ 快照已保存" : "✓ Profile saved",
    profileApplied: (n) => zh ? `✓ 已应用快照「${n}」` : `✓ Profile "${n}" applied`,
    profileNeedName: zh ? "请先填写快照名称" : "Enter a profile name first",
    cacheCleared: zh ? "缓存已清空" : "Cache cleared",
  };

  const $ = (id) => document.getElementById(id);
  const providers = () => Zotero.PaperPilot && Zotero.PaperPilot.providers;
  const rankColumn = () => Zotero.PaperPilot && Zotero.PaperPilot.rankColumn;

  const getPref = (key, fallback) => {
    try {
      const v = Zotero.Prefs.get(PREFIX + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) { return fallback; }
  };
  const setPref = (key, value) => {
    try { Zotero.Prefs.set(PREFIX + key, value, true); } catch (e) { /* ignore */ }
  };

  function setText(id, msg, color) {
    const el = $(id);
    if (el) { el.textContent = msg; el.style.color = color || "#888"; }
  }

  /** 程序化设置 pref 绑定输入框的值：写 pref + 同步显示 + 触发 change 让绑定层知情 */
  function setBoundInput(id, prefKey, value) {
    setPref(prefKey, value);
    const el = $(id);
    if (el && el.value !== value) {
      el.value = value;
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch (e) { /* ignore */ }
    }
  }

  /* ---------- 服务商与模型 ---------- */

  function fillProviders() {
    const sel = $("pp-provider");
    if (!sel || sel.options.length || !providers()) return;
    for (const p of providers().PROVIDERS) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name;
      sel.appendChild(opt);
    }
    const cur = getPref("aiProvider", "");
    // 无有效服务商记录时默认显示「自定义」，避免与实际 Base URL 不符的错觉
    sel.value = (cur && providers().getProvider(cur)) ? cur : "custom";
  }

  function fillModels(models, current) {
    const sel = $("pp-model-select");
    if (!sel) return;
    sel.innerHTML = "";
    for (const m of models || []) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    }
    if (current && models && models.includes(current)) sel.value = current;
  }

  function onProviderChange() {
    const p = providers() && providers().getProvider($("pp-provider").value);
    if (!p) return;
    if (!p.custom && p.base) {
      setBoundInput("pp-baseurl", "aiBaseUrl", p.base);
    }
    fillModels(p.models, getPref("aiModel", ""));
    setPref("aiProvider", p.id);
    setText("pp-detect-result", p.noKey ? (zh ? "该服务商无需 API Key" : "No API key needed") : "", "#888");
  }

  function onModelSelect() {
    const v = $("pp-model-select").value;
    if (v) setBoundInput("pp-model", "aiModel", v);
  }

  async function onDetect() {
    const key = (getPref("aiApiKey", "") || "").trim();
    const selProvider = providers().getProvider($("pp-provider").value);
    const customBase = selProvider && selProvider.custom
      ? (getPref("aiBaseUrl", "") || "").trim() : "";
    if (!key && !customBase && !(selProvider && selProvider.noKey)) {
      return setText("pp-detect-result", txt.noKey, "#c0392b");
    }
    setText("pp-detect-result", txt.detecting, "#888");
    $("pp-detect").disabled = true;
    try {
      const r = await providers().detectProvider(key, customBase);
      $("pp-provider").value = r.provider.id;
      if (!r.provider.custom) setBoundInput("pp-baseurl", "aiBaseUrl", r.base);
      fillModels(r.models && r.models.length ? r.models : r.provider.models, getPref("aiModel", ""));
      setPref("aiProvider", r.provider.id);
      setText("pp-detect-result", txt.detected(r.provider.name, (r.models || []).length), "#1e7d32");
    } catch (e) {
      setText("pp-detect-result", txt.detectFail + (e && e.message || e), "#c0392b");
    } finally {
      $("pp-detect").disabled = false;
    }
  }

  /* ---------- 测试连接 ---------- */

  function setResult(msg, color) { setText("pp-test-result", msg, color); }

  async function testConnection() {
    const base = (getPref("aiBaseUrl", "") || "").trim();
    const apiKey = getPref("aiApiKey", "");
    const model = getPref("aiModel", "");
    if (!base) return setResult(txt.noBase, "#c0392b");
    if (!apiKey) return setResult(txt.noKey, "#c0392b");
    if (!model) return setResult(txt.noModel, "#c0392b");

    const btn = $("pp-test-connection");
    if (btn) btn.disabled = true;
    setResult(txt.testing, "#888");
    try {
      const okModel = await providers().testChat(base, apiKey, model);
      setResult("✓ " + txt.ok(okModel), "#1e7d32");
    } catch (e) {
      let detail = "";
      try {
        const resp = e.xmlhttp && e.xmlhttp.response;
        detail = (resp && resp.error && resp.error.message) || e.xmlhttp.responseText || "";
      } catch (_) { /* ignore */ }
      if (typeof detail !== "string") detail = "";
      const status = e && e.xmlhttp && e.xmlhttp.status;
      const head = status ? `${txt.fail}（HTTP ${status}）` : `${txt.fail}：${e.message || e}`;
      setResult(head + (detail ? " " + detail.slice(0, 200) : ""), "#c0392b");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---------- 配置快照 ---------- */

  function refreshProfiles() {
    const sel = $("pp-profile-list");
    if (!sel || !providers()) return;
    sel.innerHTML = "";
    for (const p of providers().getProfiles()) {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = `${p.name} ｜ ${p.model} ｜ ${p.base}`;
      sel.appendChild(opt);
    }
  }

  function onProfileSave() {
    const name = (($("pp-profile-name") || {}).value || "").trim();
    if (!name) return setText("pp-profile-result", txt.profileNeedName, "#c0392b");
    providers().addProfile(name, {
      base: getPref("aiBaseUrl", ""),
      key: getPref("aiApiKey", ""),
      model: getPref("aiModel", ""),
      provider: getPref("aiProvider", ""),
    });
    refreshProfiles();
    setText("pp-profile-result", txt.profileSaved, "#1e7d32");
  }

  function onProfileApply() {
    const name = $("pp-profile-list") && $("pp-profile-list").value;
    if (!name) return;
    if (providers().applyProfile(name)) {
      // 同步界面显示
      const p = providers().getProfiles().find((x) => x.name === name);
      if (p) {
        const setVal = (id, v) => { const el = $(id); if (el) el.value = v || ""; };
        setVal("pp-baseurl", p.base);
        setVal("pp-apikey", p.key);
        setVal("pp-model", p.model);
        if (p.provider && providers().getProvider(p.provider)) {
          $("pp-provider").value = p.provider;
          fillModels(providers().getProvider(p.provider).models, p.model);
        }
      }
      setText("pp-profile-result", txt.profileApplied(name), "#1e7d32");
    }
  }

  function onProfileDel() {
    const name = $("pp-profile-list") && $("pp-profile-list").value;
    if (!name) return;
    providers().removeProfile(name);
    refreshProfiles();
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

  /* ---------- 初始化（DOM 就绪探测） ---------- */

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !providers()) {
      window.setTimeout(init, 400);
      return;
    }
    // Zotero 先执行脚本、后插入 fragment：关键节点不存在就延迟重试
    if (!$("pp-provider") || !$("pp-test-connection") || !$("pp-es-clear")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    try { fillProviders(); } catch (e) { /* ignore */ }
    try {
      const p = providers().getProvider(getPref("aiProvider", ""));
      fillModels(p ? p.models : [], getPref("aiModel", ""));
    } catch (e) { /* ignore */ }
    try { refreshProfiles(); } catch (e) { /* ignore */ }
    try { refreshEsStats(); } catch (e) { /* ignore */ }
    try { refreshS2Stats(); } catch (e) { /* ignore */ }

    const bind = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
    bind("pp-provider", "change", onProviderChange);
    bind("pp-model-select", "change", onModelSelect);
    bind("pp-detect", "click", onDetect);
    bind("pp-test-connection", "click", testConnection);
    bind("pp-profile-save", "click", onProfileSave);
    bind("pp-profile-apply", "click", onProfileApply);
    bind("pp-profile-del", "click", onProfileDel);
    bind("pp-es-clear", "click", onEsClear);
    bind("pp-s2-clear", "click", onS2Clear);
    bind("pp-rank-browse", "click", browseRankData);
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
