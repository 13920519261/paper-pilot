/* PaperPilot 设置窗格脚本·账号与模型通道（0.14.0 新增）
 * 与 prefs-pane.js 同窗格运行；经 Zotero.PaperPilot.account / .channels 访问
 * bootstrap 作用域的 Account / Channels 模块。
 * 交互逻辑移植自「AI 带教中心」模型通道面板：状态卡 + 通道行（切换/实测/参数/删除）
 * + 新增/编辑表单（厂商预设自动填充、密钥检测、上游拉取模型、模型 chips、extraBody）。
 */
/* global Zotero, window, document, Components */

(function () {
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const $ = (id) => document.getElementById(id);
  const PP = () => Zotero.PaperPilot || {};
  const account = () => PP().account;
  const channels = () => PP().channels;

  const el = (tag, attrs, text) => {
    const node = document.createElementNS(HTML_NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k]);
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const fmtDate = (ms) => {
    try { return new Date(ms).toLocaleString(zh ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }); }
    catch (e) { return new Date(ms).toLocaleString(); }
  };

  /* ==================== 账号区块 ==================== */

  function renderAccount() {
    const A = account();
    if (!A || !$("pp-login-view")) return;
    const loggedIn = A.isLoggedIn();
    $("pp-login-view").style.display = loggedIn ? "none" : "";
    $("pp-account-view").style.display = loggedIn ? "" : "none";
    if (!loggedIn) {
      $("pp-login-password").value = "";
      return;
    }
    const u = A.user() || {};
    const name = u.name || u.email || "已登录用户";
    $("pp-account-name").textContent = name;
    $("pp-account-email").textContent = u.email || "";
    $("pp-account-badge").textContent = String(name).trim().charAt(0).toUpperCase() || "P";
    const bits = [];
    if (u.plan) bits.push("套餐：" + u.plan);
    if (typeof u.dailyUsed === "number") {
      bits.push("今日官方模型用量：" + u.dailyUsed + (typeof u.dailyLimit === "number" ? "/" + u.dailyLimit : ""));
    }
    if (A.expiresAt()) bits.push("会话有效期至 " + fmtDate(A.expiresAt()));
    bits.push("服务器 " + A.serverUrl().replace(/^https?:\/\//, ""));
    $("pp-account-meta").textContent = bits.join(" ｜ ");
    fillOfficialModelSelect();
  }

  /** 官方模型下拉：通道模型列表 + 尽力从网关拉取最新（写入通道 models 缓存） */
  async function fillOfficialModelSelect() {
    const A = account(), C = channels();
    const sel = $("pp-account-official-model");
    if (!A || !C || !sel || !A.isLoggedIn()) return;
    const ch = C.getChannel(C.OFFICIAL_ID);
    const render = (models) => {
      if (!sel.parentNode) return; // 面板已关
      sel.innerHTML = "";
      const list = models && models.length ? models : ["auto"];
      for (const m of list) sel.appendChild(el("option", { value: m }, m));
      sel.value = list.includes(ch.model) ? ch.model : "auto";
    };
    render(ch.models);
    try {
      const r = await C.fetchModels({ baseUrl: A.gatewayUrl(), apiKey: A.token(), timeoutMs: 6000 });
      if (r.ok && r.models && r.models.length) {
        // 去重合并 auto，写回通道 models 缓存（下次秒开）
        const merged = ["auto", ...r.models.filter((m) => m !== "auto")];
        C.upsert({ id: C.OFFICIAL_ID, models: merged });
        render(merged);
      }
    } catch (e) { /* 拉取失败保持现列表 */ }
  }

  async function onLogin() {
    const A = account();
    const btn = $("pp-login-btn");
    if (!A || !btn) return;
    const email = $("pp-login-email").value.trim();
    const password = $("pp-login-password").value;
    const result = $("pp-login-result");
    if (!email || !password) {
      result.textContent = "请填写邮箱和密码";
      result.style.color = "#c0392b";
      return;
    }
    btn.disabled = true;
    result.textContent = "登录中…";
    result.style.color = "#888";
    try {
      await A.login(email, password);
      result.textContent = "✓ 登录成功";
      result.style.color = "#1e7d32";
      $("pp-login-password").value = "";
      renderAll(); // 通道状态（官方通道可用性）联动刷新
    } catch (e) {
      result.textContent = "✗ " + (e && e.message || "登录失败");
      result.style.color = "#c0392b";
    } finally {
      btn.disabled = false;
    }
  }

  async function onLogout() {
    const A = account();
    if (!A) return;
    const result = $("pp-account-result");
    result.textContent = "退出中…";
    result.style.color = "#888";
    try { await A.logout(); } catch (e) { /* 本地登出不失败 */ }
    result.textContent = "";
    renderAll();
  }

  async function onRefreshAccount() {
    const A = account();
    const result = $("pp-account-result");
    if (!A) return;
    if (!A.isLoggedIn()) { renderAll(); return; }
    result.textContent = "刷新中…";
    result.style.color = "#888";
    try {
      await A.refreshUser();
      result.textContent = "✓ 已刷新";
      result.style.color = "#1e7d32";
    } catch (e) {
      result.textContent = "✗ " + (e && e.message || "刷新失败");
      result.style.color = "#c0392b";
    }
    renderAccount();
  }

  function onRegisterLink() {
    const A = account();
    try { Zotero.launchURL(A.serverUrl() + "/register"); } catch (e) { /* ignore */ }
  }

  function onOfficialModelChange() {
    const C = channels();
    const v = $("pp-account-official-model").value;
    try { C.upsert({ id: C.OFFICIAL_ID, model: v }); } catch (e) { /* ignore */ }
  }

  /* ==================== 模型通道区块（移植通道面板） ==================== */

  function renderChannels() {
    const C = channels();
    if (!C || !$("pp-ch-list")) return;
    const { channels: chans, active } = C.list();
    const A = account();
    const loggedIn = A && A.isLoggedIn();

    /* 状态卡 */
    const st = $("pp-ch-status");
    st.innerHTML = "";
    const act = chans.find((c) => c.id === active);
    if (!act) {
      st.appendChild(el("span", { style: "color:#c0392b;" }, "⚠ 没有活动通道，AI 功能不可用——请切换或新增一个通道。"));
    } else if (act.official && !loggedIn) {
      st.appendChild(el("span", { style: "color:#b8860b;" },
        "● 活动通道「" + act.name + "」需要登录——请登录账号（官方模型免费），或切换到自己的通道。"));
    } else {
      const dot = el("span", { style: "color:#1e7d32;" }, "● ");
      const b = el("b", null, act.name);
      const rest = el("span", { style: "color:#888;" },
        " " + act.model + " — 活动通道 · 共 " + chans.length + " 个已注册");
      st.appendChild(dot); st.appendChild(b); st.appendChild(rest);
    }

    /* 通道行 */
    const list = $("pp-ch-list");
    list.innerHTML = "";
    if (!chans.length) {
      list.appendChild(el("div", { style: "font-size:12.5px;color:#888;" },
        "暂无通道，点击下方「新增通道」接入。"));
    }
    for (const c of chans) {
      list.appendChild(buildChannelRow(c, active === c.id));
    }
    $("pp-ch-form").style.display = "none";
  }

  function buildChannelRow(c, isActive) {
    const row = el("div", {
      style: "border:1px solid #d8d8d8;border-radius:8px;padding:8px 10px;display:flex;align-items:center;gap:10px;",
    });

    const left = el("div", { style: "flex:1;min-width:0;" });
    const head = el("div", { style: "display:flex;align-items:center;gap:6px;" });
    head.appendChild(el("span", { style: "font-weight:700;font-size:13px;" }, c.name));
    if (isActive) {
      head.appendChild(el("span", {
        style: "font-size:11px;padding:1px 8px;border-radius:99px;background:#e6f4ea;color:#1e7d32;",
      }, "活动中"));
    }
    if (c.official && !c.available) {
      head.appendChild(el("span", {
        style: "font-size:11px;padding:1px 8px;border-radius:99px;background:#fdf3d7;color:#b8860b;",
      }, "未登录"));
    }
    left.appendChild(head);
    const sub = [c.baseUrl || "—", c.model];
    if (c.models && c.models.length) sub.push(c.models.length + " 模型");
    if (c.provider && c.provider !== "official") {
      const p = channels().providerOf(c.provider);
      sub.push(p ? p.name : c.provider);
    }
    sub.push(c.apiKeyMasked);
    left.appendChild(el("div", {
      style: "font-size:11.5px;color:#888;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
    }, sub.join(" · ")));
    row.appendChild(left);

    const acts = el("div", { style: "display:flex;gap:6px;flex:none;" });
    const mkBtn = (label, title) => el("button", {
      style: "padding:3px 10px;font-size:12px;white-space:nowrap;", title: title || "",
    }, label);
    if (!isActive) {
      const b = mkBtn("切换", "设为活动通道（全部 AI 功能经此通道）");
      b.addEventListener("click", () => onSwitch(c.id));
      acts.appendChild(b);
    }
    const bTest = mkBtn("实测", "小负荷真实调用一次，返回模型/延迟/应答");
    bTest.addEventListener("click", () => onTest(c.id, bTest));
    acts.appendChild(bTest);
    const bEdit = mkBtn("参数", c.official ? "官方通道说明" : "编辑通道参数");
    bEdit.addEventListener("click", () => onEdit(c));
    acts.appendChild(bEdit);
    if (!c.official) {
      const bDel = mkBtn("删除");
      bDel.addEventListener("click", () => onDelete(c.id));
      acts.appendChild(bDel);
    }
    row.appendChild(acts);
    return row;
  }

  async function onSwitch(id) {
    const r = channels().setActive(id);
    if (!r.ok) {
      const result = $("pp-ch-test-result");
      result.textContent = "✗ " + r.error;
      result.style.color = "#c0392b";
      return;
    }
    renderAll();
  }

  async function onTest(id, btn) {
    const result = $("pp-ch-test-result");
    btn.disabled = true;
    btn.textContent = "…";
    result.textContent = "实测中（真实调用一次）…";
    result.style.color = "#888";
    try {
      const j = await channels().testChannel(id);
      if (j.ok) {
        result.textContent = "";
        result.appendChild(el("span", { style: "color:#1e7d32;" },
          "✓ " + id + " 通道正常：模型 " + j.model + "，延迟 " + j.latencyMs + "ms，应答「" + (j.reply || "") + "」"));
      } else {
        result.textContent = "";
        result.appendChild(el("span", { style: "color:#c0392b;" },
          "✗ " + id + " 调用失败：" + (j.error || "未知错误")));
      }
    } catch (e) {
      result.textContent = "✗ " + (e && e.message || "实测异常");
      result.style.color = "#c0392b";
    } finally {
      btn.disabled = false;
      btn.textContent = "实测";
    }
  }

  function onEdit(c) {
    if (c.official) {
      const result = $("pp-ch-test-result");
      result.textContent = "";
      result.appendChild(el("span", { style: "color:#888;" },
        "官方通道由账号系统管理：模型在上方账号卡片选择（登录后免费）；如需自定义接口请「＋ 新增通道」。"));
      return;
    }
    openForm(c);
  }

  function onDelete(id) {
    const win = Zotero.getMainWindow();
    const ok = Services_promptConfirm(win,
      "PaperPilot",
      "删除通道 " + id + "？（该通道的配置与密钥将被移除，不影响其他通道）");
    if (!ok) return;
    channels().remove(id);
    renderChannels();
  }

  /** Services.prompt.confirm 的安全包装（面板作用域没有 Services） */
  function Services_promptConfirm(win, title, msg) {
    try {
      // Zotero 7+ 面板窗口可以经 Zotero 导出的 Prompter 走主窗口确认框
      const ps = Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
        .getService(Components.interfaces.nsIPromptService);
      return ps.confirm(win, title, msg);
    } catch (e) {
      return window.confirm(msg);
    }
  }

  /* ---------- 通道编辑表单（原项目 mf-* 逻辑移植） ---------- */

  let mfEditing = null;   // 编辑中的通道 id；null = 新增
  let mfModels = [];      // 模型列表工作副本

  function fillProviderSelect() {
    const sel = $("pp-mf-provider");
    if (!sel || sel.options.length) return;
    for (const p of channels().PROVIDERS) {
      sel.appendChild(el("option", { value: p.id }, p.name));
    }
  }

  function providerPreset(id) {
    return channels().PROVIDERS.find((p) => p.id === id) || null;
  }

  function syncProviderNote() {
    const p = providerPreset($("pp-mf-provider").value);
    $("pp-mf-provider-note").textContent = p ? (p.note || "") : "";
  }

  function onProviderChange() {
    const p = providerPreset(this.value);
    syncProviderNote();
    if (!p) return;
    if (p.baseUrl) $("pp-mf-baseUrl").value = p.baseUrl;
    const cur = $("pp-mf-model").value.trim();
    if (!cur || cur === "auto") $("pp-mf-model").value = (p.models && p.models[0]) || cur;
    const extra = $("pp-mf-extraBody").value.trim();
    if (!extra && p.extraBody && Object.keys(p.extraBody).length) {
      $("pp-mf-extraBody").value = JSON.stringify(p.extraBody);
    }
    if (!mfModels.length && p.models) {
      mfModels = p.models.slice();
      renderModelChips();
    }
  }

  function renderModelChips() {
    const box = $("pp-mf-models");
    box.innerHTML = "";
    if (!mfModels.length) {
      box.appendChild(el("span", { style: "font-size:11.5px;color:#888;" }, "暂无模型，可拉取上游或手动添加"));
      return;
    }
    mfModels.forEach((m, i) => {
      const chip = el("span", {
        style: "font-size:12px;padding:2px 8px;border:1px solid #bbb;border-radius:6px;background:#f5f5f5;",
      });
      chip.appendChild(document.createTextNode(m + " "));
      const x = el("span", { style: "cursor:pointer;color:#c0392b;font-weight:700;", title: "移除" }, "×");
      x.addEventListener("click", () => { mfModels.splice(i, 1); renderModelChips(); });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  function onModelAdd() {
    const v = $("pp-mf-model-add").value.trim();
    if (!v) return;
    if (!mfModels.includes(v)) mfModels.push(v);
    $("pp-mf-model-add").value = "";
    renderModelChips();
  }

  async function onModelsFetch() {
    const btn = $("pp-mf-models-fetch");
    const C = channels();
    const baseUrl = $("pp-mf-baseUrl").value.trim();
    let apiKey = $("pp-mf-apiKey").value.trim();
    if (!apiKey && mfEditing) {
      apiKey = (C.getChannel(mfEditing) || {}).apiKey || ""; // 编辑时留空 = 用原密钥
    }
    if (!baseUrl) {
      setDetectResult("请先填写接口地址", "#c0392b");
      return;
    }
    btn.disabled = true;
    btn.textContent = "拉取中";
    try {
      const j = await C.fetchModels({ baseUrl, apiKey, timeoutMs: 8000 });
      if (j.ok) {
        mfModels = j.models || [];
        renderModelChips();
        setDetectResult("✓ 拉到 " + mfModels.length + " 个模型", "#1e7d32");
      } else {
        setDetectResult("✗ 拉取失败：" + j.error, "#c0392b");
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "📡 拉取";
    }
  }

  async function onDetect() {
    const btn = $("pp-mf-detect");
    const C = channels();
    const key = $("pp-mf-apiKey").value.trim();
    const baseUrl = $("pp-mf-baseUrl").value.trim();
    if (!key && !baseUrl) {
      setDetectResult("请先填写 API Key 或接口地址", "#c0392b");
      return;
    }
    let apiKey = key;
    if (!apiKey && mfEditing) apiKey = (C.getChannel(mfEditing) || {}).apiKey || "";
    btn.disabled = true;
    btn.textContent = "检测中";
    setDetectResult("探测中（识别厂商并拉取模型）…", "#888");
    try {
      const j = await C.detectChannel({ apiKey, baseUrl });
      if (j.ok) {
        const p = providerPreset(j.provider);
        if (p) { $("pp-mf-provider").value = j.provider; syncProviderNote(); }
        if (j.baseUrl) $("pp-mf-baseUrl").value = j.baseUrl;
        mfModels = j.models || [];
        renderModelChips();
        const cur = $("pp-mf-model").value.trim();
        if (mfModels.length && (!cur || !mfModels.includes(cur))) $("pp-mf-model").value = mfModels[0];
        if (!$("pp-mf-name").value.trim() && j.providerName) $("pp-mf-name").value = j.providerName + " 通道";
        setDetectResult("✓ 识别为 " + (j.providerName || j.provider) + "：" + mfModels.length + " 个模型" +
          (j.latencyMs ? "，" + j.latencyMs + "ms" : ""), "#1e7d32");
      } else {
        if (j.provider && providerPreset(j.provider)) {
          $("pp-mf-provider").value = j.provider;
          syncProviderNote();
        }
        setDetectResult("✗ " + (j.error || "检测失败"), "#c0392b");
      }
    } catch (e) {
      setDetectResult("✗ " + (e && e.message || "检测异常"), "#c0392b");
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍 检测";
    }
  }

  function setDetectResult(msg, color) {
    const r = $("pp-mf-detect-result");
    r.textContent = msg;
    r.style.color = color || "#888";
  }

  function openForm(c) {
    fillProviderSelect();
    mfEditing = c ? c.id : null;
    $("pp-mf-id").value = c ? c.id : "";
    $("pp-mf-id").disabled = !!c;
    $("pp-mf-name").value = c ? c.name : "";
    $("pp-mf-baseUrl").value = c ? c.baseUrl : "";
    $("pp-mf-apiKey").value = "";
    $("pp-mf-apiKey").placeholder = c ? "留空保持不变（当前 " + c.apiKeyMasked + "）" : "sk-...";
    $("pp-mf-model").value = c ? c.model : "auto";
    $("pp-mf-model-add").value = "";
    $("pp-mf-extraBody").value = c && c.extraBody && Object.keys(c.extraBody).length
      ? JSON.stringify(c.extraBody) : "";
    $("pp-mf-timeoutMs").value = c ? c.timeoutMs : 12000;
    mfModels = c && Array.isArray(c.models) ? c.models.slice() : [];
    const pv = c ? (c.provider || "") : "";
    $("pp-mf-provider").value = providerPreset(pv) ? pv : (pv || "custom");
    syncProviderNote();
    renderModelChips();
    setDetectResult("", "#888");
    $("pp-mf-err").textContent = "";
    $("pp-ch-form").style.display = "";
    try { $("pp-mf-id").focus(); } catch (e) { /* ignore */ }
  }

  function onSave() {
    const C = channels();
    const errEl = $("pp-mf-err");
    let extra = {};
    const raw = $("pp-mf-extraBody").value.trim();
    if (raw) {
      try { extra = JSON.parse(raw); } catch (e) {
        errEl.textContent = "附加参数不是合法 JSON";
        return;
      }
    }
    const providerId = $("pp-mf-provider").value;
    const preset = providerPreset(providerId);
    const d = {
      id: mfEditing || $("pp-mf-id").value.trim(),
      name: $("pp-mf-name").value.trim(),
      provider: providerId,
      baseUrl: $("pp-mf-baseUrl").value.trim(),
      apiKey: $("pp-mf-apiKey").value.trim(),
      model: $("pp-mf-model").value.trim() || "auto",
      models: mfModels,
      extraBody: extra,
      timeoutMs: Number($("pp-mf-timeoutMs").value) || 12000,
    };
    if (!d.id || !/^[a-z0-9-]+$/.test(d.id)) { errEl.textContent = "通道 id 必填（小写字母/数字/连字符）"; return; }
    if (!d.baseUrl && !(mfEditing && C.getChannel(mfEditing))) { errEl.textContent = "接口地址必填"; return; }
    const noKeyOk = preset && (preset.noKey || /127\.0\.0\.1|localhost/.test(d.baseUrl));
    if (!d.apiKey && !mfEditing && !noKeyOk) { errEl.textContent = "API Key 必填（本地免密接口除外）"; return; }
    const r = C.upsert(d);
    if (!r.ok) { errEl.textContent = r.error || "保存失败"; return; }
    $("pp-ch-form").style.display = "none";
    renderChannels();
  }

  /* ==================== 装配 ==================== */

  function renderAll() {
    try { renderAccount(); } catch (e) { /* ignore */ }
    try { renderChannels(); } catch (e) { /* ignore */ }
  }

  let _offSession = null; // 会话变化回调句柄（窗口关闭必须注销）

  function init() {
    if (typeof Zotero === "undefined" || !Zotero.PaperPilot || !account() || !channels()) {
      window.setTimeout(init, 400);
      return;
    }
    if (!$("pp-login-btn") || !$("pp-ch-add")) {
      window.setTimeout(init, 300);
      return;
    }
    if (init._done) return;
    init._done = true;

    const bind = (id, ev, fn) => { const node = $(id); if (node) node.addEventListener(ev, fn); };
    // 账号
    bind("pp-login-btn", "click", onLogin);
    bind("pp-login-password", "keydown", (e) => { if (e.key === "Enter") onLogin(); });
    bind("pp-register-link", "click", onRegisterLink);
    bind("pp-logout-btn", "click", onLogout);
    bind("pp-account-refresh", "click", onRefreshAccount);
    bind("pp-account-official-model", "change", onOfficialModelChange);
    // 通道
    bind("pp-ch-add", "click", () => openForm(null));
    bind("pp-mf-provider", "change", onProviderChange);
    bind("pp-mf-models-add", "click", onModelAdd);
    bind("pp-mf-model-add", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onModelAdd(); } });
    bind("pp-mf-models-fetch", "click", onModelsFetch);
    bind("pp-mf-detect", "click", onDetect);
    bind("pp-mf-save", "click", onSave);
    bind("pp-mf-cancel", "click", () => { $("pp-ch-form").style.display = "none"; });

    renderAll();

    // 账号会话在别处变化（后台 401 失效/启动恢复完成）→ 面板即时对齐
    _offSession = account().onSessionChanged(renderAll);
    window.addEventListener("unload", () => {
      if (_offSession) { try { _offSession(); } catch (e) { /* ignore */ } _offSession = null; }
    });
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
