/* PaperPilot 设置窗格脚本·账号与模型通道（0.14.0 新增；0.15.0 随设置界面重构改版）
 * 与 prefs-pane.js 同窗格运行；经 Zotero.PaperPilot.account / .channels 访问
 * bootstrap 作用域的 Account / Channels 模块。
 * 交互逻辑移植自「AI 带教中心」模型通道面板：状态卡 + 通道行（切换/实测/参数/删除）
 * + 新增/编辑表单（厂商预设自动填充、密钥检测、上游拉取模型、模型 chips、extraBody）。
 * 0.15.0：动态元素改用 prefs.xhtml 内 <html:style> 的 .pp-* 类（随系统明暗主题）；
 * 语义色经 CSS 变量引用（var(--pp-success) 等，定义于 .pp-root 作用域）。
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

  /* ---------- 敏感信息掩码（0.14.7）：接口地址默认掩码，复选框切换明文 ---------- */

  const PREF_PREFIX = "extensions.zotero.paperpilot.";

  function showFullUrl() {
    try { return !!Zotero.Prefs.get(PREF_PREFIX + "uiShowFullUrl", true); } catch (e) { return false; }
  }

  /** URL 掩码：保留协议与路径，主机名中间打码。本机地址（127.0.0.1/localhost）不打码。 */
  function maskUrl(u) {
    const s = String(u || "");
    if (!s) return "—";
    if (/^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])/.test(s)) return s;
    const m = s.match(/^(https?:\/\/)?([^/:]+)(:\d+)?(\/.*)?$/);
    if (!m) return s.length <= 10 ? "***" : s.slice(0, 6) + "***" + s.slice(-4);
    const scheme = m[1] || "", host = m[2], port = m[3] || "", path = m[4] || "";
    const masked = host.length <= 8 ? host.slice(0, 2) + "***"
      : host.slice(0, 6) + "***" + host.slice(-4);
    return scheme + masked + port + path;
  }

  /** 按当前开关返回展示用地址 */
  function displayUrl(u) {
    return showFullUrl() ? (u || "—") : maskUrl(u);
  }

  /* ==================== 账号区块 ==================== */

  function renderAccount() {
    const A = account();
    if (!A || !$("pp-login-view")) return;
    const loggedIn = A.isLoggedIn();
    $("pp-login-view").style.display = loggedIn ? "none" : "";
    // 登录成功时收起注册表单（会话变化回调也会走到这里）
    if (loggedIn) {
      const rv = $("pp-register-view");
      if (rv) rv.style.display = "none";
    }
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
    bits.push("服务器 " + displayUrl(A.serverUrl()).replace(/^https?:\/\//, ""));
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
      result.style.color = "var(--pp-danger)";
      return;
    }
    btn.disabled = true;
    result.textContent = "登录中…";
    result.style.color = "var(--pp-muted)";
    try {
      await A.login(email, password);
      result.textContent = "✓ 登录成功";
      result.style.color = "var(--pp-success)";
      $("pp-login-password").value = "";
      // 换账号 → 会员缓存与订单状态全部作废重来
      stopMbPolling();
      mbPlans = null;
      mbSel = null;
      mbOrder = null;
      const payBox = $("pp-mb-pay");
      if (payBox) payBox.style.display = "none";
      renderAll(); // 通道状态（官方通道可用性）联动刷新
    } catch (e) {
      result.textContent = "✗ " + (e && e.message || "登录失败");
      result.style.color = "var(--pp-danger)";
    } finally {
      btn.disabled = false;
    }
  }

  async function onLogout() {
    const A = account();
    if (!A) return;
    const result = $("pp-account-result");
    result.textContent = "退出中…";
    result.style.color = "var(--pp-muted)";
    try { await A.logout(); } catch (e) { /* 本地登出不失败 */ }
    // 会员区随登录态清空：停轮询、丢订单、收下面板
    stopMbPolling();
    mbOrder = null;
    mbSel = null;
    const payBox = $("pp-mb-pay");
    if (payBox) payBox.style.display = "none";
    const orderBox = $("pp-mb-order");
    if (orderBox) orderBox.style.display = "none";
    result.textContent = "";
    renderAll();
  }

  async function onRefreshAccount() {
    const A = account();
    const result = $("pp-account-result");
    if (!A) return;
    if (!A.isLoggedIn()) { renderAll(); return; }
    result.textContent = "刷新中…";
    result.style.color = "var(--pp-muted)";
    try {
      await A.refreshUser();
      result.textContent = "✓ 已刷新";
      result.style.color = "var(--pp-success)";
    } catch (e) {
      result.textContent = "✗ " + (e && e.message || "刷新失败");
      result.style.color = "var(--pp-danger)";
    }
    renderAccount();
  }

  /* ---------- 注册（0.20.0 内置界面：直接调服务端 /api/auth/register，不跳浏览器） ---------- */

  function showRegister(on) {
    const lv = $("pp-login-view");
    const rv = $("pp-register-view");
    if (!lv || !rv) return;
    lv.style.display = on ? "none" : "";
    rv.style.display = on ? "" : "none";
    if (!on) return;
    const res = $("pp-reg-result");
    if (res) res.textContent = "";
    const vr = $("pp-reg-verify-row");
    if (vr) vr.style.display = "none";
    // 已登录邮箱带过来，省一次输入
    const src = $("pp-login-email");
    const dst = $("pp-reg-email");
    if (src && dst && !dst.value) dst.value = src.value || "";
  }

  async function onRegister() {
    const A = account();
    const btn = $("pp-reg-btn");
    const result = $("pp-reg-result");
    if (!A || !btn || !result) return;
    const email = $("pp-reg-email").value.trim();
    const nickname = $("pp-reg-nickname").value.trim();
    const pw = $("pp-reg-password").value;
    const pw2 = $("pp-reg-password2").value;
    const setMsg = (t, ok) => {
      result.textContent = t;
      result.style.color = ok ? "var(--pp-success)" : "var(--pp-danger)";
    };
    if (!email || !pw) return setMsg("请填写邮箱和密码");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setMsg("邮箱格式不正确");
    if (pw.length < 8) return setMsg("密码至少 8 位");
    if (pw !== pw2) return setMsg("两次输入的密码不一致");
    btn.disabled = true;
    result.textContent = "注册中…";
    result.style.color = "var(--pp-muted)";
    try {
      const r = await A.register(email, pw, nickname);
      $("pp-reg-password").value = "";
      $("pp-reg-password2").value = "";
      const vr = $("pp-reg-verify-row");
      if (r.needVerify) {
        setMsg("✓ " + (r.notice || "验证邮件已发送，请到邮箱点链接激活"), true);
        if (vr) vr.style.display = "";
      } else {
        setMsg("✓ " + (r.notice || "注册成功，可直接登录"), true);
        if (vr) vr.style.display = "none";
        try { $("pp-login-email").value = email; } catch (e) { /* ignore */ }
      }
    } catch (e) {
      setMsg("✗ " + ((e && e.message) || "注册失败"));
    } finally {
      btn.disabled = false;
    }
  }

  async function onResendVerify() {
    const A = account();
    const btn = $("pp-reg-resend");
    const out = $("pp-reg-resend-result");
    if (!A || !btn || !out) return;
    const email = $("pp-reg-email").value.trim();
    if (!email) {
      out.textContent = "请先填邮箱";
      out.style.color = "var(--pp-danger)";
      return;
    }
    btn.disabled = true;
    out.textContent = "发送中…";
    out.style.color = "var(--pp-muted)";
    try {
      const msg = await A.resendVerify(email);
      out.textContent = "✓ " + msg;
      out.style.color = "var(--pp-success)";
    } catch (e) {
      out.textContent = "✗ " + ((e && e.message) || "发送失败");
      out.style.color = "var(--pp-danger)";
    } finally {
      btn.disabled = false;
    }
  }

  function onForgotLink() {
    const A = account();
    try { Zotero.launchURL(A.serverUrl() + "/forgot"); } catch (e) { /* ignore */ }
  }

  function onOfficialModelChange() {
    const C = channels();
    const v = $("pp-account-official-model").value;
    try { C.upsert({ id: C.OFFICIAL_ID, model: v }); } catch (e) { /* ignore */ }
  }

  /* ==================== 会员（0.23.0） ====================
   * 等级 Free / Pro，权益、价格档位、收款信息全部由服务端下发（后台可改）。
   * 两条开通路径：
   *   A 订单：生成订单 → 展示订单号/金额/收款码 → 用户付款后点「我已完成支付」
   *           → 轮询订单状态 → 管理员核销后自动开通（无需手输码）
   *   B 激活码：线下购买/赠送/补偿，直接输码激活（绑定账号 + 叠加续期）
   */

  let mbPlans = null;       // {plans, priceOptions, priceItems, upcoming, cycles, pay}（服务端下发，缓存）
  let mbSel = null;         // 当前选中的价格档位 {plan, months, text}
  let mbCoupon = null;      // 0.24.6 已应用的优惠码试算结果 {code, discountText, payableText, ...}
  let mbOrder = null;       // 当前订单
  let mbTimer = null;       // 订单轮询定时器
  let mbPollDeadline = 0;   // 轮询截止（避免永久轮询）

  const MB_STATUS = { pending: "待支付", claimed: "待核销", fulfilled: "已开通",
    cancelled: "已取消", expired: "已过期" };

  function mbSetMsg(id, text, color) {
    const n = $(id);
    if (!n) return;
    n.textContent = text;
    n.style.color = color || "var(--pp-muted)";
  }

  /** 套餐目录按需拉取（首次进入或强制刷新） */
  async function ensurePlans(force) {
    const A = account();
    if (!A || !A.isLoggedIn()) return null;
    if (mbPlans && !force) return mbPlans;
    try {
      mbPlans = await A.plans();
      if (!mbSel) mbSel = pickDefaultOption(mbOptions());
    } catch (e) {
      if (force) throw e;
      mbPlans = null;
    }
    return mbPlans;
  }

  /**
   * 价格档位（生效中）→ 统一成 {plan, months, text}。
   * 0.24.4：优先用价格表 priceItems（含中文周期名 + 折合月单价，用户才看得出买长周期划不划算）；
   * 老服务端没有 priceItems 时回落旧的 priceOptions。
   */
  function mbOptions() {
    const items = (mbPlans && mbPlans.priceItems) || [];
    if (items.length) {
      return items.map((it) => {
        const cyc = it.cycleName || it.label || (it.months + " 个月");
        const per = Number(it.months) > 1
          ? " · 折合 ¥" + (Number(it.perMonth) || Math.round((it.price / it.months) * 100) / 100) + "/月"
          : "";
        return { plan: it.plan, months: Number(it.months), cycle: it.cycle,
          perpetual: it.cycle === "perpetual" || Number(it.months) === 0,
          text: cyc + " · ¥" + it.price + per };
      });
    }
    return ((mbPlans && mbPlans.priceOptions) || []).map((o) => ({
      plan: o.plan, months: Number(o.months), cycle: "",
      perpetual: Number(o.months) === 0,
      text: (o.label || o.months + " 个月") + " · ¥" + o.price,
    }));
  }

  /** 默认档位：优先「上次购买的周期」（续费不用重新挑），否则最少月数（花钱最少） */
  function pickDefaultOption(list) {
    if (!list || !list.length) return null;
    const A = account();
    const last = A && A.lastPurchasedMonths ? A.lastPurchasedMonths() : null;
    if (last) {
      const hit = list.find((o) => Number(o.months) === Number(last));
      if (hit) return hit;
    }
    // 有月数的档位优先（按最少月数，花钱最少）；全是永久时才回落永久
    const paid = list.filter((o) => Number(o.months) > 0);
    return (paid.length ? paid : list).slice().sort((a, b) => a.months - b.months)[0];
  }

  function renderMembership() {
    const A = account();
    const block = $("pp-mb-block");
    if (!A || !block) return;
    if (!A.isLoggedIn()) { block.style.display = "none"; return; }
    block.style.display = "";

    const m = A.membership() || { plan: "Free", name: "免费版", expiresAt: 0 };
    const isPro = A.isPro();
    const badge = $("pp-mb-badge");
    badge.textContent = isPro ? "PRO" : "FREE";
    badge.className = isPro ? "pp-mb-badge pp-mb-badge-pro" : "pp-mb-badge";
    $("pp-mb-title").textContent = m.name || (isPro ? "专业版" : "免费版");

    /* 到期与剩余天数：≤7 天转警示色，已到期转危险色 */
    const exp = $("pp-mb-expiry");
    const days = A.membershipDaysLeft();
    let cls = "pp-mb-expiry";
    let txt = "长期有效";
    if (m.expiresAt) {
      if (days <= 0) { txt = "已到期（" + fmtDate(m.expiresAt) + "）"; cls += " pp-mb-expiry-expired"; }
      else if (days <= 7) { txt = "仅剩 " + days + " 天 · " + fmtDate(m.expiresAt) + " 到期"; cls += " pp-mb-expiry-warn"; }
      else { txt = "剩 " + days + " 天 · " + fmtDate(m.expiresAt) + " 到期"; }
    } else if (m.perpetual) {
      txt = "永久有效（无需续费）";
    }
    exp.textContent = txt;
    exp.className = cls;

    /* 权益清单（来自服务端套餐配置；未取到时给占位） */
    const fbox = $("pp-mb-features");
    fbox.innerHTML = "";
    const def = mbPlans && (mbPlans.plans || []).find((p) => p.id === m.plan);
    const feats = (def && def.features) || [];
    if (feats.length) {
      for (const f of feats.slice(0, 6)) fbox.appendChild(el("div", { class: "pp-mb-feat" }, "· " + f));
    } else {
      fbox.appendChild(el("div", { class: "pp-mb-feat" },
        isPro ? "专业版权益加载中…" : "免费版：官方模型每日 100 次 · 全部核心功能"));
      ensurePlans(false).catch(() => { /* 拉不到就保持占位 */ });
    }

    const up = $("pp-mb-upgrade");
    if (up) up.textContent = isPro ? "续费专业版" : "升级专业版";

    /* 0.24.4 到期提醒横幅：剩余 ≤7 天（含已到期）出现，点击直接打开续费面板 */
    const rb = $("pp-mb-renew");
    if (rb) {
      const rem = A.renewalReminder ? A.renewalReminder() : null;
      if (rem) {
        rb.style.display = "";
        rb.className = rem.expired ? "pp-mb-renew pp-mb-renew-expired" : "pp-mb-renew";
        rb.textContent = rem.expired
          ? ("⚠ 会员已于 " + fmtDate(rem.expiresAt) + " 到期，当前为免费版 —— 点此续费立即恢复")
          : ("⏳ 仅剩 " + rem.daysLeft + " 天（" + fmtDate(rem.expiresAt) + " 到期）—— 点此续费，时长可叠加");
      } else {
        rb.style.display = "none";
      }
    }

    renderMbUsage();
    renderPersistWarn();
  }

  /** 0.24.4 用量趋势：今日/额度 + 近 7 天迷你柱状图 + 近 7 天合计（纯 CSS 高度绘图，无外部依赖） */
  function renderMbUsage() {
    const box = $("pp-mb-usage");
    const A = account();
    if (!box || !A) return;
    if (!A.isLoggedIn()) { box.style.display = "none"; return; }
    const us = A.usage();
    const days = (us && us.days) || [];
    if (!days.length) { box.style.display = "none"; return; }   // 老服务端没有趋势数据 → 整块隐藏
    box.style.display = "";
    box.innerHTML = "";
    box.appendChild(el("div", { class: "pp-mb-usage-head" },
      "用量：今日 " + us.today + (us.limit > 0 ? " / " + us.limit : "")
      + " 次 · 近 7 天合计 " + us.last7 + " 次"));

    const last = days.slice(-7);
    const max = Math.max(1, last.reduce((m, d) => Math.max(m, Number(d && d.count) || 0), 0));
    const bars = el("div", { class: "pp-mb-bars" });
    for (const d of last) {
      const n = Number(d && d.count) || 0;
      const h = n ? Math.max(3, Math.round((n / max) * 26)) : 2;
      const col = el("div", { class: "pp-mb-bar-col" });
      const bar = el("div", { class: n ? "pp-mb-bar" : "pp-mb-bar pp-mb-bar-zero" });
      bar.style.height = h + "px";
      bar.setAttribute("title", String(d.date) + "：" + n + " 次");
      col.appendChild(bar);
      col.appendChild(el("div", { class: "pp-mb-bar-day" }, String(d.date).slice(8, 10)));
      bars.appendChild(col);
    }
    box.appendChild(bars);
  }

  /** 0.23.0：会话写盘失败不再静默——面板直接给出原因与后果 */
  function renderPersistWarn() {
    const A = account();
    const w = $("pp-mb-persist-warn");
    if (!A || !w) return;
    const ps = A.persistStatus || {};
    if (A.isLoggedIn() && ps.attempted && !ps.ok) {
      w.style.display = "";
      w.textContent = "⚠ 登录状态未能写入磁盘（" + ((ps.errors && ps.errors[0]) || "未知原因")
        + "）。本次运行内可用，但重启 Zotero 后需要重新登录；"
        + "请检查 Zotero 数据目录与配置目录是否可写。";
    } else {
      w.style.display = "none";
    }
  }

  /* ---------- 下单 ---------- */

  function renderMbOptions() {
    const opts = $("pp-mb-options");
    if (!opts) return;
    opts.innerHTML = "";
    const list = mbOptions();
    if (!mbSel && list.length) mbSel = pickDefaultOption(list);
    for (const o of list) {
      const on = mbSel && mbSel.plan === o.plan && Number(mbSel.months) === Number(o.months);
      const chip = el("span", { class: on ? "pp-mb-opt pp-mb-opt-on" : "pp-mb-opt" }, o.text);
      chip.addEventListener("click", () => {
        mbSel = o;
        // 换了档位：之前试算的折后价已经不对了 —— 主动作废，避免用户按旧价格转账
        if (mbCoupon) { mbCoupon = null; mbSetMsg("pp-mb-coupon-msg", "档位已变更，请重新应用优惠码", "var(--pp-warn)"); }
        renderMbOptions();
        renderMbQuote();
      });
      opts.appendChild(chip);
    }
    // 尚未生效的价格：只作预告（灰底、不可点）——让用户知道「什么时候会变价」
    for (const it of ((mbPlans && mbPlans.upcoming) || [])) {
      const d = it.effectiveFrom ? String(it.effectiveFrom).slice(0, 10) : "";
      const text = "即将生效 · " + (it.cycleName || it.label || (it.months + " 个月"))
        + " ¥" + it.price + (d ? " · " + d : "");
      const chip = el("span", { class: "pp-mb-opt pp-mb-opt-soon" }, text);
      chip.setAttribute("title", "该价格尚未生效，到时间后自动可购买");
      opts.appendChild(chip);
    }
    const note = $("pp-mb-price-note");
    if (note) {
      const pay = (mbPlans && mbPlans.pay) || {};
      note.textContent = "支持 " + (pay.channel || "收款码") + (pay.note ? "；" + pay.note : "");
    }
  }

  /* ---------- 优惠码（0.24.6） ---------- */

  /** 应用优惠码：向服务端试算折后价（**不占名额**，用户可反复试） */
  async function onMbCoupon() {
    const A = account();
    const inp = $("pp-mb-coupon");
    if (!A || !inp) return;
    const code = String(inp.value || "").trim();
    if (!code) { mbCoupon = null; renderMbQuote(); mbSetMsg("pp-mb-coupon-msg", "已清除优惠码", "var(--pp-muted)"); return; }
    if (!mbSel) { mbSetMsg("pp-mb-coupon-msg", "请先选择购买档位", "var(--pp-warn)"); return; }
    mbSetMsg("pp-mb-coupon-msg", "正在校验…", "var(--pp-muted)");
    try {
      mbCoupon = await A.validateCoupon(code, mbSel.plan, mbSel.months, mbSel.cycle);
      mbSetMsg("pp-mb-coupon-msg", "✓ " + (mbCoupon.label || "优惠码可用"), "var(--pp-success)");
      renderMbQuote();
    } catch (e) {
      mbCoupon = null;
      renderMbQuote();
      mbSetMsg("pp-mb-coupon-msg", "✗ " + ((e && e.message) || "优惠码不可用"), "var(--pp-danger)");
    }
  }

  /** 折后价明细：折前 / 减免 / 应付（应付不含对账尾数，尾数在下单后才确定） */
  function renderMbQuote() {
    const box = $("pp-mb-quote");
    if (!box) return;
    if (!mbCoupon) { box.style.display = "none"; box.textContent = ""; return; }
    const q = mbCoupon;
    box.style.display = "";
    box.textContent = "折前 " + (q.originalText || "") + "　" + (q.discountText || "")
      + "　应付 " + (q.payableText || "")
      + "（下单后另加 1~99 分的专属对账尾数，转账金额以下单页为准）";
  }

  /** 点到期横幅 = 打开续费面板（默认档位取「上次购买的周期」） */
  function onMbRenew() {
    const A = account();
    if (!A || !A.isLoggedIn()) return;
    mbSel = null;                       // 重新按上次购买周期挑默认档位
    onMbUpgrade();
    try { const b = $("pp-mb-order"); if (b && b.scrollIntoView) b.scrollIntoView(false); } catch (e) { /* ignore */ }
  }

  async function onMbUpgrade() {
    const A = account();
    const box = $("pp-mb-order");
    if (!A || !box || !A.isLoggedIn()) return;
    box.style.display = "";
    mbCoupon = null;
    renderMbQuote();
    mbSetMsg("pp-mb-coupon-msg", "", "var(--pp-muted)");
    mbSetMsg("pp-mb-order-msg", "正在获取套餐…", "var(--pp-muted)");
    try {
      await ensurePlans(true);
      mbSetMsg("pp-mb-order-msg", "", "var(--pp-muted)");
      renderMbOptions();
    } catch (e) {
      mbSetMsg("pp-mb-order-msg", "✗ " + ((e && e.message) || "获取套餐失败"), "var(--pp-danger)");
    }
  }

  async function onMbCreate() {
    const A = account();
    const btn = $("pp-mb-create");
    if (!A || !mbSel) return;
    btn.disabled = true;
    mbSetMsg("pp-mb-order-msg", "正在生成订单…", "var(--pp-muted)");
    try {
      mbOrder = await A.createOrder(mbSel.plan, mbSel.months, mbSel.cycle,
        mbCoupon ? mbCoupon.code : "");
      mbSetMsg("pp-mb-order-msg", "", "var(--pp-muted)");
      renderMbPay();
      startMbPolling();
    } catch (e) {
      mbSetMsg("pp-mb-order-msg", "✗ " + ((e && e.message) || "下单失败"), "var(--pp-danger)");
    } finally {
      btn.disabled = false;
    }
  }

  function renderMbPay() {
    const pay = $("pp-mb-pay");
    const info = $("pp-mb-pay-info");
    const qr = $("pp-mb-qr");
    if (!pay || !info) return;
    if (!mbOrder) { pay.style.display = "none"; return; }
    pay.style.display = "";
    const o = mbOrder;
    const cycleTxt = o.perpetual ? "永久" : (o.months + " 个月");
    const money = o.amountText || ("¥" + (Number(o.amount) || 0).toFixed(2));
    const lines = ["订单号：" + o.id];
    // 0.24.6：用了优惠码就把「折前 → 减免 → 实付」摆清楚，避免用户以为被多收
    if (Number(o.discountCents) > 0) {
      lines.push((o.planName || o.plan) + " · " + cycleTxt + " · 折前 " + (o.originalText || "") + "（优惠码 " + o.couponCode + "）");
      lines.push("优惠 " + o.discountText + " → 折后 ¥" + ((Number(o.baseCents) || 0) / 100).toFixed(2));
    } else {
      lines.push((o.planName || o.plan) + " · " + cycleTxt + " · " + money);
    }
    lines.push("状态：" + (MB_STATUS[o.status] || o.status));
    // 0.24.5：金额末尾的小数尾数是这笔订单的专属标识（后台据此自动对账核销）
    if (o.tailCents) {
      lines.push("⚠ 请**精确转账 " + money + "**（不能凑整）：末尾 "
        + String(o.tailCents).padStart(2, "0") + " 分是这笔订单的专属尾数，用于自动对账");
    }
    const p = o.pay || {};
    if (p.channel) lines.push("收款方式：" + p.channel);
    if (p.qrText) lines.push(p.qrText);
    if (p.note) lines.push(p.note);
    info.textContent = lines.join("\n");
    if (qr) {
      if (p.qrImage) { qr.setAttribute("src", p.qrImage); qr.style.display = ""; }
      else { qr.removeAttribute("src"); qr.style.display = "none"; }
    }
    const done = o.status === "fulfilled";
    const claim = $("pp-mb-claim");
    if (claim) {
      claim.disabled = done || o.status === "claimed" || o.status === "cancelled" || o.status === "expired";
      claim.textContent = o.status === "claimed" ? "已提交，等待核销" : "我已完成支付";
    }
    const cancel = $("pp-mb-cancel");
    if (cancel) cancel.disabled = done || o.status === "cancelled";
    if (done) mbSetMsg("pp-mb-pay-result", "✓ 已开通，会员状态已更新", "var(--pp-success)");
  }

  function startMbPolling() {
    stopMbPolling();
    mbPollDeadline = Date.now() + 10 * 60e3; // 最多轮询 10 分钟
    mbTimer = window.setInterval(() => { onMbPoll(true); }, 6000);
  }

  function stopMbPolling() {
    if (mbTimer) { try { window.clearInterval(mbTimer); } catch (e) { /* ignore */ } mbTimer = null; }
  }

  /** 轮询订单状态；核销完成即刷新会员并重绘 */
  async function onMbPoll(silent) {
    const A = account();
    if (!A || !mbOrder) return;
    if (Date.now() > mbPollDeadline) { stopMbPolling(); return; }
    try {
      const o = await A.orderStatus(mbOrder.id);
      mbOrder = o;
      if (o.status === "fulfilled") {
        stopMbPolling();
        try { await A.refreshMembership(); } catch (e) { /* 失败也有本地兜底 */ }
        renderAll();
        renderMbPay();
        return;
      }
      if (o.status === "expired" || o.status === "cancelled") stopMbPolling();
      renderMbPay();
      if (!silent) mbSetMsg("pp-mb-pay-result", "状态：" + (MB_STATUS[o.status] || o.status), "var(--pp-muted)");
    } catch (e) {
      if (!silent) mbSetMsg("pp-mb-pay-result", "✗ " + ((e && e.message) || "查询失败"), "var(--pp-danger)");
    }
  }

  async function onMbClaim() {
    const A = account();
    if (!A || !mbOrder) return;
    mbSetMsg("pp-mb-pay-result", "正在提交…", "var(--pp-muted)");
    try {
      mbOrder = await A.claimOrder(mbOrder.id);
      renderMbPay();
      mbSetMsg("pp-mb-pay-result",
        "✓ 已提交，等待管理员核销（一般几分钟内）。可点「刷新订单状态」查看。", "var(--pp-success)");
      startMbPolling();
    } catch (e) {
      mbSetMsg("pp-mb-pay-result", "✗ " + ((e && e.message) || "提交失败"), "var(--pp-danger)");
    }
  }

  async function onMbCancel() {
    const A = account();
    if (!A || !mbOrder) return;
    try {
      await A.cancelOrder(mbOrder.id);
      stopMbPolling();
      mbOrder = null;
      $("pp-mb-pay").style.display = "none";
      mbSetMsg("pp-mb-order-msg", "订单已取消，可重新生成", "var(--pp-muted)");
    } catch (e) {
      mbSetMsg("pp-mb-pay-result", "✗ " + ((e && e.message) || "取消失败"), "var(--pp-danger)");
    }
  }

  async function onMbRefresh() {
    const A = account();
    if (!A || !A.isLoggedIn()) return;
    mbSetMsg("pp-mb-result", "刷新中…", "var(--pp-muted)");
    try {
      await A.refreshMembership();
      renderAll();
      mbSetMsg("pp-mb-result", "✓ 会员状态已刷新", "var(--pp-success)");
    } catch (e) {
      mbSetMsg("pp-mb-result", "✗ " + ((e && e.message) || "刷新失败"), "var(--pp-danger)");
    }
  }

  /* ---------- 激活码 ---------- */

  function onMbCodeToggle() {
    const row = $("pp-mb-code-row");
    if (!row) return;
    const show = row.style.display === "none";
    row.style.display = show ? "" : "none";
    if (show) { try { $("pp-mb-code-input").focus(); } catch (e) { /* ignore */ } }
  }

  async function onMbRedeem() {
    const A = account();
    const input = $("pp-mb-code-input");
    const btn = $("pp-mb-code-btn");
    if (!A || !input || !A.isLoggedIn()) return;
    const code = input.value.trim();
    if (!code) return mbSetMsg("pp-mb-result", "请输入激活码", "var(--pp-danger)");
    btn.disabled = true;
    mbSetMsg("pp-mb-result", "激活中…", "var(--pp-muted)");
    try {
      const r = await A.redeem(code);
      input.value = "";
      const m = (r && r.membership) || A.membership() || {};
      const expMs = m.expiresAt ? (Number(m.expiresAt) || Date.parse(m.expiresAt) || 0) : 0;
      mbSetMsg("pp-mb-result",
        "✓ 激活成功：" + (m.name || "专业版") + (expMs ? "，到期 " + fmtDate(expMs) : ""),
        "var(--pp-success)");
      renderAll();
    } catch (e) {
      mbSetMsg("pp-mb-result", "✗ " + ((e && e.message) || "激活失败"), "var(--pp-danger)");
    } finally {
      btn.disabled = false;
    }
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
      st.appendChild(el("span", { style: "color:var(--pp-danger);" }, "⚠ 没有活动通道，AI 功能不可用——请切换或新增一个通道。"));
    } else if (act.official && !loggedIn) {
      st.appendChild(el("span", { style: "color:var(--pp-warn);" },
        "● 活动通道「" + act.name + "」需要登录——请登录账号（官方模型免费），或切换到自己的通道。"));
    } else {
      const dot = el("span", { style: "color:var(--pp-success);" }, "● ");
      const b = el("b", null, act.name);
      const rest = el("span", { style: "color:var(--pp-muted);" },
        " " + act.model + " — 活动通道 · 共 " + chans.length + " 个已注册");
      st.appendChild(dot); st.appendChild(b); st.appendChild(rest);
    }

    /* 通道行 */
    const list = $("pp-ch-list");
    list.innerHTML = "";
    if (!chans.length) {
      list.appendChild(el("div", { class: "pp-hint" },
        "暂无通道，点击下方「新增通道」接入。"));
    }
    for (const c of chans) {
      list.appendChild(buildChannelRow(c, active === c.id));
    }
    $("pp-ch-form").style.display = "none";
  }

  function buildChannelRow(c, isActive) {
    const row = el("div", { class: "pp-ch-row" });

    const left = el("div", { style: "flex:1;min-width:0;" });
    const head = el("div", { class: "pp-ch-head" });
    head.appendChild(el("span", { class: "pp-ch-name" }, c.name));
    if (isActive) {
      head.appendChild(el("span", { class: "pp-pill pp-pill-ok" }, "活动中"));
    }
    if (c.official && !c.available) {
      head.appendChild(el("span", { class: "pp-pill pp-pill-warn" }, "未登录"));
    }
    left.appendChild(head);
    const sub = [displayUrl(c.baseUrl), c.model];
    if (c.models && c.models.length) sub.push(c.models.length + " 模型");
    if (c.provider && c.provider !== "official") {
      const p = channels().providerOf(c.provider);
      sub.push(p ? p.name : c.provider);
    }
    sub.push(c.apiKeyMasked);
    left.appendChild(el("div", { class: "pp-ch-sub" }, sub.join(" · ")));
    row.appendChild(left);

    /* 当前调用模型下拉（0.14.7）：改动立即生效，无需进编辑表单 */
    const modelBox = el("div", { style: "flex:none;max-width:170px;" });
    const modelSel = el("select", {
      class: "pp-input",
      style: "width:100%;font-size:12px;padding:2px 4px;",
      title: "该通道当前调用的模型（选择后立即生效）",
    });
    const opts = Array.isArray(c.models) && c.models.length ? c.models.slice() : [];
    if (c.model && !opts.includes(c.model)) opts.unshift(c.model);
    if (!opts.length) opts.push("auto");
    for (const m of opts) modelSel.appendChild(el("option", { value: m }, m));
    modelSel.value = c.model || opts[0];
    modelSel.addEventListener("change", () => onModelPick(c, modelSel.value, modelSel));
    modelBox.appendChild(modelSel);
    modelBox.appendChild(el("div", { class: "pp-ch-modelcap" }, "当前模型"));
    row.appendChild(modelBox);

    const acts = el("div", { style: "display:flex;gap:6px;flex:none;" });
    const mkBtn = (label, title) => el("button", {
      class: "pp-btn pp-btn-sm", title: title || "",
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
      result.style.color = "var(--pp-danger)";
      return;
    }
    renderAll();
  }

  /** 通道行内模型下拉：选用该通道当前调用模型（部分更新，其余字段原样保留） */
  function onModelPick(c, model, sel) {
    const result = $("pp-ch-test-result");
    try {
      const r = channels().upsert({ id: c.id, model: model });
      if (!r || !r.ok) {
        result.textContent = "✗ 模型切换失败：" + ((r && r.error) || "未知错误");
        result.style.color = "var(--pp-danger)";
        sel.value = c.model; // 回退显示
        return;
      }
      result.textContent = "";
      result.appendChild(el("span", { style: "color:var(--pp-success);" },
        "✓ 「" + c.name + "」当前调用模型已切换为 " + model + "（立即生效）"));
      renderChannels(); // 状态卡/行内显示同步
    } catch (e) {
      result.textContent = "✗ 模型切换异常：" + (e && e.message || e);
      result.style.color = "var(--pp-danger)";
      sel.value = c.model;
    }
  }

  /** 「显示完整接口地址」开关：读初始态、变更写 pref 并重绘 */
  function initShowUrlToggle() {
    const box = $("pp-ch-show-url");
    if (!box) return;
    box.checked = showFullUrl();
    box.addEventListener("change", () => {
      try { Zotero.Prefs.set(PREF_PREFIX + "uiShowFullUrl", !!box.checked, true); } catch (e) { /* ignore */ }
      renderAll(); // 账号卡片的服务器地址也随开关联动
    });
  }

  async function onTest(id, btn) {
    const result = $("pp-ch-test-result");
    btn.disabled = true;
    btn.textContent = "…";
    result.textContent = "实测中（真实调用一次）…";
    result.style.color = "var(--pp-muted)";
    try {
      const j = await channels().testChannel(id);
      if (j.ok) {
        result.textContent = "";
        result.appendChild(el("span", { style: "color:var(--pp-success);" },
          "✓ " + id + " 通道正常：模型 " + j.model + "，延迟 " + j.latencyMs + "ms，应答「" + (j.reply || "") + "」"));
      } else {
        result.textContent = "";
        result.appendChild(el("span", { style: "color:var(--pp-danger);" },
          "✗ " + id + " 调用失败：" + (j.error || "未知错误")));
      }
    } catch (e) {
      result.textContent = "✗ " + (e && e.message || "实测异常");
      result.style.color = "var(--pp-danger)";
    } finally {
      btn.disabled = false;
      btn.textContent = "实测";
    }
  }

  function onEdit(c) {
    if (c.official) {
      const result = $("pp-ch-test-result");
      result.textContent = "";
      result.appendChild(el("span", { style: "color:var(--pp-muted);" },
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
      box.appendChild(el("span", { class: "pp-hint" },
        "暂无模型，可拉取上游或手动添加；点击模型名即设为默认模型"));
      return;
    }
    const cur = ($("pp-mf-model").value || "").trim();
    mfModels.forEach((m, i) => {
      const selected = m === cur;
      const chip = el("span", {
        class: selected ? "pp-chip pp-chip-on" : "pp-chip",
        title: "点击设为该通道默认模型",
      });
      chip.appendChild(document.createTextNode(m + " "));
      const x = el("span", { class: "pp-chip-x", title: "从列表移除" }, "×");
      x.addEventListener("click", (ev) => {
        ev.stopPropagation(); // 只移除，不触发「设为默认」
        mfModels.splice(i, 1);
        renderModelChips();
      });
      chip.appendChild(x);
      chip.addEventListener("click", () => {
        $("pp-mf-model").value = m;
        renderModelChips();
      });
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
      setDetectResult("请先填写接口地址", "var(--pp-danger)");
      return;
    }
    btn.disabled = true;
    btn.textContent = "拉取中";
    try {
      const j = await C.fetchModels({ baseUrl, apiKey, timeoutMs: 8000 });
      if (j.ok) {
        mfModels = j.models || [];
        renderModelChips();
        setDetectResult("✓ 拉到 " + mfModels.length + " 个模型", "var(--pp-success)");
      } else {
        setDetectResult("✗ 拉取失败：" + j.error, "var(--pp-danger)");
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
      setDetectResult("请先填写 API Key 或接口地址", "var(--pp-danger)");
      return;
    }
    let apiKey = key;
    if (!apiKey && mfEditing) apiKey = (C.getChannel(mfEditing) || {}).apiKey || "";
    btn.disabled = true;
    btn.textContent = "检测中";
    setDetectResult("探测中（识别厂商并拉取模型）…", "var(--pp-muted)");
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
          (j.latencyMs ? "，" + j.latencyMs + "ms" : ""), "var(--pp-success)");
      } else {
        if (j.provider && providerPreset(j.provider)) {
          $("pp-mf-provider").value = j.provider;
          syncProviderNote();
        }
        setDetectResult("✗ " + (j.error || "检测失败"), "var(--pp-danger)");
      }
    } catch (e) {
      setDetectResult("✗ " + (e && e.message || "检测异常"), "var(--pp-danger)");
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍 检测";
    }
  }

  function setDetectResult(msg, color) {
    const r = $("pp-mf-detect-result");
    r.textContent = msg;
    r.style.color = color || "var(--pp-muted)";
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
    setDetectResult("", "var(--pp-muted)");
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
    try { renderMembership(); } catch (e) { /* ignore */ }
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
    bind("pp-register-link", "click", () => showRegister(true));
    bind("pp-reg-back", "click", () => showRegister(false));
    bind("pp-reg-btn", "click", onRegister);
    bind("pp-reg-password2", "keydown", (e) => { if (e.key === "Enter") onRegister(); });
    bind("pp-reg-resend", "click", onResendVerify);
    bind("pp-forgot-link", "click", onForgotLink);
    bind("pp-logout-btn", "click", onLogout);
    bind("pp-account-refresh", "click", onRefreshAccount);
    bind("pp-account-official-model", "change", onOfficialModelChange);
    // 会员（0.23.0）
    bind("pp-mb-upgrade", "click", onMbUpgrade);
    bind("pp-mb-coupon-btn", "click", onMbCoupon);
    bind("pp-mb-renew", "click", onMbRenew);
    bind("pp-mb-create", "click", onMbCreate);
    bind("pp-mb-close-order", "click", () => { const b = $("pp-mb-order"); if (b) b.style.display = "none"; });
    bind("pp-mb-claim", "click", onMbClaim);
    bind("pp-mb-poll", "click", () => onMbPoll(false));
    bind("pp-mb-cancel", "click", onMbCancel);
    bind("pp-mb-refresh", "click", onMbRefresh);
    bind("pp-mb-code-toggle", "click", onMbCodeToggle);
    bind("pp-mb-code-btn", "click", onMbRedeem);
    bind("pp-mb-code-input", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onMbRedeem(); } });
    // 通道
    bind("pp-ch-add", "click", () => openForm(null));
    bind("pp-mf-provider", "change", onProviderChange);
    bind("pp-mf-models-add", "click", onModelAdd);
    bind("pp-mf-model-add", "keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onModelAdd(); } });
    bind("pp-mf-models-fetch", "click", onModelsFetch);
    bind("pp-mf-detect", "click", onDetect);
    bind("pp-mf-save", "click", onSave);
    bind("pp-mf-cancel", "click", () => { $("pp-ch-form").style.display = "none"; });
    initShowUrlToggle();

    renderAll();

    // 账号会话在别处变化（后台 401 失效/启动恢复完成）→ 面板即时对齐
    _offSession = account().onSessionChanged(renderAll);
    window.addEventListener("unload", () => {
      if (_offSession) { try { _offSession(); } catch (e) { /* ignore */ } _offSession = null; }
      stopMbPolling(); // 面板关闭必须停掉订单轮询，否则定时器泄漏
    });
  }

  init();
  if (typeof window !== "undefined" && window.setTimeout) {
    window.setTimeout(init, 400);
    window.setTimeout(init, 1200);
  }
})();
