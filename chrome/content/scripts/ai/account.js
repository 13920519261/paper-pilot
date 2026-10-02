/* PaperPilot 账号系统（0.14.0 新增，0.15.0 收口服务器入口）
 * - 邮箱密码登录 PaperPilot 官方账号服务器（地址内置固定，设置界面不再提供
 *   服务器入口——官方服务统一由 https://pp.xinglintools.top 提供，不开放自建后台）
 * - 会话持久化：Zotero 数据目录 paperpilot-account.json（IOUtils 原子写 + 0600，
 *   不进 prefs——prefs.js 明文且易被配置同步工具带走；密码永不落盘）
 * - 登录过期：本地 expiresAt 判断 + 服务端 401 双保险；任何官方模型调用
 *   遇 401 自动失效会话并弹窗提醒重新登录
 * - 网络异常翻译：超时/拒连/5xx 均给出可操作的中文提示
 * - UI 刷新：onSessionChanged 回调（设置面板登录态切换用，窗口关闭须注销）
 *
 * 服务端契约（OpenAI 兼容网关 + 三个鉴权端点）：
 *   POST {server}/api/auth/login  {email,password}
 *     → 200 {ok:true, token, expiresAt(ISO), user:{email,name,plan,dailyUsed,dailyLimit}}
 *     → 401 {ok:false, error:"邮箱或密码错误"}
 *   POST {server}/api/auth/logout  Authorization: Bearer <token> → 200 {ok:true}
 *   GET  {server}/api/auth/me     Authorization: Bearer <token>
 *     → 200 {ok:true, user:{...}, expiresAt?}   ← 返回 expiresAt 即滑动续期
 *     → 401 {ok:false, error:"登录已过期"}
 *   GET  {server}/v1/models | POST {server}/v1/chat/completions  Bearer <token>
 */
/* global Zotero, Services, IOUtils, PathUtils, Prefs */

var Account = {
  _session: null,       // {token, expiresAt(ms), user:{}}，仅存内存；落盘走 _save
  _listeners: [],
  _restoring: false,

  // 官方账号服务器（0.15.0 起内置固定，设置界面不提供服务器入口，不开放自建后台）
  SERVER_DEFAULT: "https://pp.xinglintools.top",

  // 本地会话有效期（0.15.1）：与服务端 TOKEN_TTL 对齐（30 天滑动）。
  // 登录/刷新以服务端 expiresAt 为准；官方网关调用成功后由 AIClient 调
  // touchSession() 同步滑动，避免「服务端已续期、本地仍判过期」的错位登出。
  SESSION_TTL_MS: 30 * 86400e3,

  /** 账号服务器根地址（无末尾斜杠）。网关 = server + /v1 */
  serverUrl() {
    return String(Prefs.get("accountServerUrl", this.SERVER_DEFAULT) || this.SERVER_DEFAULT)
      .replace(/\/+$/, "");
  },

  /** 官方网关 Base URL（OpenAI 兼容 /v1），供通道管理引用 */
  gatewayUrl() {
    return this.serverUrl() + "/v1";
  },

  isLoggedIn() {
    return !!this._session && !this._expired();
  },

  token() {
    return this.isLoggedIn() ? this._session.token : "";
  },

  /** 当前用户信息（未登录返回 null；过期视为未登录） */
  user() {
    return this.isLoggedIn() ? this._session.user || {} : null;
  },

  expiresAt() {
    return this._session ? this._session.expiresAt || 0 : 0;
  },

  _expired() {
    return !!(this._session && this._session.expiresAt && Date.now() > this._session.expiresAt);
  },

  /* ---------- 会话文件（数据目录 + profile 双写，0600，原子写） ---------- */

  /**
   * 会话文件候选路径（0.20.0 双写）。
   * 只认数据目录一个落点时，该路径一旦写失败（权限/被同步工具搬走/目录变更）
   * 用户就表现为「更新后掉登录」且无从恢复；profile 目录作第二落点互为兜底。
   */
  _sessionFiles() {
    const out = [];
    try {
      const d = Zotero.DataDirectory && Zotero.DataDirectory.dir;
      if (d) out.push(PathUtils.join(d, "paperpilot-account.json"));
    } catch (e) { /* 数据目录未就绪：仅用 profile 落点 */ }
    try {
      const prof = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile);
      const p = PathUtils.join(prof.path, "paperpilot-account.json");
      if (out.indexOf(p) < 0) out.push(p);
    } catch (e) { /* ignore */ }
    return out;
  },

  /** 账号生命周期诊断：Zotero.debug + 落盘 account.log（下次掉登录可回溯） */
  _diag(msg) {
    try { Zotero.debug("PaperPilot account: " + msg); } catch (e) { /* ignore */ }
    try {
      const files = this._sessionFiles();
      if (!files.length) return;
      const logPath = files[0].replace(/paperpilot-account\.json$/, "paperpilot-account.log");
      const line = new Date().toISOString() + " " + msg + "\n";
      IOUtils.readUTF8(logPath)
        .then((old) => IOUtils.writeUTF8(logPath, String(old || "") + line))
        .catch(() => IOUtils.writeUTF8(logPath, line))
        .catch(() => { /* 诊断失败不影响主流程 */ });
    } catch (e) { /* ignore */ }
  },

  async _save() {
    if (!this._session) return;
    const files = this._sessionFiles();
    if (!files.length) {
      this._diag("save SKIPPED: no writable path resolved");
      return;
    }
    const body = JSON.stringify({
      token: this._session.token,
      expiresAt: this._session.expiresAt || 0,
      savedAt: Date.now(),
      user: this._session.user || {},
    });
    let ok = 0;
    for (const file of files) {
      try {
        // tmpPath 原子替换：写一半崩溃/断电不会留下半截会话文件
        await IOUtils.writeUTF8(file, body, { mode: 0o600, tmpPath: file + ".tmp" });
        ok++;
      } catch (e) {
        this._diag("save FAILED @ " + file + " :: " + (e && e.message));
      }
    }
    this._diag("session saved to " + ok + "/" + files.length + " path(s)");
  },

  async _clearFile() {
    for (const file of this._sessionFiles()) {
      try { await IOUtils.remove(file, { ignoreAbsent: true }); } catch (e) { /* ignore */ }
    }
    this._diag("session files cleared");
  },

  /* ---------- 启动恢复：读盘（多落点）→ 过期交服务端定论 → 尽力刷新 ---------- */

  async restore() {
    if (this._restoring) return;
    this._restoring = true;
    try {
      let doc = null;
      let from = "";
      for (const file of this._sessionFiles()) {
        try {
          const parsed = JSON.parse(await IOUtils.readUTF8(file));
          if (parsed && parsed.token) { doc = parsed; from = file; break; }
        } catch (e) { /* 该落点无文件/损坏：试下一个 */ }
      }
      if (!doc) {
        this._diag("restore: no session file at any path");
        return;
      }
      if (doc.expiresAt && Date.now() > doc.expiresAt) {
        // 0.20.0：本地判过期不再删文件。服务端可能已滑动续期而本地落盘落后一步
        // （时钟偏差/上次未落盘），直接删就是"莫名其妙的掉登录"——交 refreshUser 的
        // 401 定论；若真失效，下一轮 401 会走 handleAuthFailure 正常清理。
        this._diag("restore: local expiry passed, file kept for server verdict");
        return;
      }
      this._session = {
        token: String(doc.token),
        expiresAt: Number(doc.expiresAt) || 0,
        user: doc.user || {},
      };
      this._diag("restore: loaded from " + from);
      // 尽力校验 + 刷新（服务端可能已吊销 token）：失败不阻塞启动
      await this.refreshUser({ silent: true });
    } catch (e) {
      this._diag("restore failed: " + (e && e.message));
    } finally {
      this._restoring = false;
      this._notify(); // 恢复结束（无论刷新成败）通知 UI 对齐登录态
    }
  },

  /* ---------- 登录 / 登出 ---------- */

  /**
   * 邮箱密码登录。成功返回 user 对象；失败抛可读中文错误。
   * 密码只进请求体，不落盘不进日志。
   */
  async login(email, password) {
    email = String(email || "").trim();
    password = String(password || "");
    if (!email || !password) throw new Error("请填写邮箱和密码");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确");

    let resp;
    try {
      resp = await this._request("POST", "/api/auth/login", { email, password }, null, 15000);
    } catch (e) {
      throw e; // _request 已翻译为可读错误
    }
    const j = resp.json || {};
    if (!j.ok || !j.token) throw new Error(j.error || "登录失败：服务端应答异常");
    if (j.expiresAt && Date.now() > Date.parse(j.expiresAt)) {
      throw new Error("登录失败：服务端返回的会话已过期");
    }
    this._session = {
      token: String(j.token),
      expiresAt: j.expiresAt ? Date.parse(j.expiresAt) || 0 : 0,
      user: j.user || { email },
    };
    await this._save();
    this._notify();
    try { Zotero.debug("PaperPilot: account login ok (" + this._mask(j.token) + ")"); } catch (_) { /* ignore */ }
    return this._session.user;
  },

  /**
   * 自助注册（0.20.0 内置注册界面）：成功后按服务端返回决定是否需邮箱验证。
   * 返回 {user, notice}；失败抛可读中文错误。密码只进请求体，不落盘不进日志。
   */
  async register(email, password, nickname) {
    email = String(email || "").trim();
    password = String(password || "");
    nickname = String(nickname || "").trim();
    if (!email || !password) throw new Error("请填写邮箱和密码");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("邮箱格式不正确");
    if (password.length < 8) throw new Error("密码至少 8 位");
    const resp = await this._request("POST", "/api/auth/register",
      { email, password, nickname: nickname || undefined }, null, 25000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "注册失败：服务端应答异常");
    const status = (j.user && j.user.status) || "active";
    this._diag("register ok: " + email + " status=" + status);
    return { user: j.user || {}, notice: j.notice || "", needVerify: status === "pending" };
  },

  /** 重发验证邮件（内置注册界面用） */
  async resendVerify(email) {
    const resp = await this._request("POST", "/api/auth/resend",
      { email: String(email || "").trim() }, null, 20000);
    const j = resp.json || {};
    if (!j.ok) throw new Error(j.error || "发送失败");
    return j.message || "验证邮件已重新发送，请查收（含垃圾邮件箱）";
  },

  /** 登出：通知服务端（尽力而为，2s 超时不阻塞）+ 清本地会话 */
  async logout({ silent } = {}) {
    const token = this._session && this._session.token;
    this._session = null;
    await this._clearFile();
    this._notify();
    if (token) {
      try {
        await this._request("POST", "/api/auth/logout", null, token, 2000);
      } catch (e) { /* 服务端登出失败不影响本地登出 */ }
    }
    if (!silent) {
      try { Zotero.debug("PaperPilot: account logout"); } catch (_) { /* ignore */ }
    }
  },

  /**
   * 刷新用户信息（用量/套餐/续期）。401 → 会话失效；其余失败静默保留旧数据。
   * silent: 不弹 401 提醒（启动恢复路径用——不惊扰，UI 自然显示未登录）
   */
  async refreshUser({ silent } = {}) {
    if (!this._session) return null;
    let resp = null;
    let fail = null;
    try {
      resp = await this._request("GET", "/api/auth/me", null, this._session.token, 10000);
    } catch (e) {
      fail = e;
      if (e && e.auth) {
        // 0.20.0：401 先复核一次再定论。服务端重启/落盘延迟/边缘节点瞬时误判
        // 都可能让首答是 401，直接清会话正是用户看到的「更新后掉登录」。
        try {
          await new Promise((r) => setTimeout(r, 900));
          resp = await this._request("GET", "/api/auth/me", null, this._session.token, 10000);
          fail = null;
          this._diag("refreshUser: first 401, retry OK — session kept");
        } catch (e2) {
          if (!(e2 && e2.auth)) {
            // 复核遇到网络层错误（非 401）：无法判定令牌失效，保留会话
            this._diag("refreshUser: 401 then network error — session kept");
            return this._session.user;
          }
          fail = e2;
        }
      }
    }
    if (fail) {
      if (fail.auth) {
        this._diag("refreshUser: 401 confirmed twice — clearing session");
        await this.handleAuthFailure(fail.message, { silent });
      }
      throw fail;
    }
    const j = (resp && resp.json) || {};
    if (!j.ok || !j.user) throw new Error(j.error || "刷新失败：服务端应答异常");
    this._session.user = j.user;
    if (j.expiresAt) {
      const exp = Date.parse(j.expiresAt);
      if (exp && exp > (this._session.expiresAt || 0)) this._session.expiresAt = exp; // 滑动续期
    }
    await this._save();
    this._notify();
    return this._session.user;
  },

  /**
   * 会话失效统一出口（AIClient 官方通道 401 / refreshUser 401 都走这里）：
   * 清会话 + 弹窗提醒 + 通知 UI。silent 时只清不弹（启动恢复阶段）。
   * 0.15.1：仅 401 触发；403（Cloudflare/WAF 拦截等）不再视为会话失效——
   * 令牌仍有效时被 403 误清曾导致"网络层拦一道就掉登录"。
   */
  async handleAuthFailure(reason, { silent } = {}) {
    if (!this._session) return;
    this._session = null;
    await this._clearFile();
    this._notify();
    if (!silent) {
      try {
        Services.prompt.alert(
          Zotero.getMainWindow(),
          "PaperPilot 账号",
          "登录已过期或已失效：" + (reason || "请重新登录") + "\n\n请到 设置 → PaperPilot 重新登录后继续使用官方模型。"
        );
      } catch (e) { /* ignore */ }
    }
  },

  /**
   * 本地会话滑动续期（0.15.1）：官方网关调用成功后由 AIClient 调用，
   * 与服务端 touchTokenSoon 对齐（now + 30 天），并异步落盘。
   * 防御：未登录 / 新有效期不比现存值更晚时不动。
   */
  touchSession() {
    if (!this._session) return;
    const exp = Date.now() + this.SESSION_TTL_MS;
    if (exp <= (this._session.expiresAt || 0)) return;
    this._session.expiresAt = exp;
    this._save();
  },

  /* ---------- UI 刷新回调（设置面板注册；窗口关闭必须注销） ---------- */

  onSessionChanged(cb) {
    this._listeners.push(cb);
    return () => this.offSessionChanged(cb);
  },

  offSessionChanged(cb) {
    this._listeners = this._listeners.filter((f) => f !== cb);
  },

  _notify() {
    for (const cb of this._listeners) {
      try { cb(); } catch (e) { /* 单个回调失败不拖累其他 */ }
    }
  },

  /* ---------- HTTP（带超时与错误翻译；Token 只出现在 Authorization 头） ---------- */

  async _request(method, path, body, token, timeoutMs) {
    const url = this.serverUrl() + path;
    const headers = {};
    if (body !== null && body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = "Bearer " + token;
    let req;
    try {
      req = await Zotero.HTTP.request(method, url, {
        headers,
        body: body === null || body === undefined ? undefined : JSON.stringify(body),
        responseType: "json",
        timeout: timeoutMs || 10000,
      });
    } catch (e) {
      throw this._translateError(e);
    }
    let json = req.response;
    if (!json && req.responseText) {
      try { json = JSON.parse(req.responseText); } catch (e) { /* 非_json 应答按无 body 处理 */ }
    }
    if (req.status >= 400) {
      // 0.20.0 关键修复：仅 401 视为会话失效。
      // 此前这里是 `401 || 403`，而 Zotero.HTTP 对 4xx 不抛异常、实际都会走本分支
      // （_translateError 那条路只兜网络异常）——0.15.1 只改了 _translateError，
      // 漏了这里。于是 Cloudflare/WAF 拦一次 403 就被当成"令牌失效"清掉本地会话，
      // 表现就是用户反馈的「动不动就要重新登录」。
      const msg = (json && json.error) || (req.status === 403
        ? "请求被拦截（HTTP 403）——可能是网络策略/防火墙，令牌未必失效"
        : "HTTP " + req.status);
      const err = new Error(msg);
      if (req.status === 401) err.auth = true;
      if (req.status === 403) err.blocked = true; // 供上层区分，不触发会话清理
      throw err;
    }
    return { status: req.status, json: json || {} };
  },

  /** 网络层错误 → 可读中文（登录/刷新/网关排障都靠它给线索） */
  _translateError(e) {
    const msg = (e && e.message) || String(e);
    const status = e && e.xmlhttp && e.xmlhttp.status;
    const server = this.serverUrl();
    if (/timed?\s*out|timeout/i.test(msg)) {
      const err = new Error("连接账号服务器超时（" + server + "）——网络不通或服务未响应");
      err.network = true;
      return err;
    }
    if (/CONNECTION_REFUSED|connection refused/i.test(msg)) {
      const err = new Error("无法连接官方账号服务器（" + server + "）——请检查网络连接后重试");
      err.network = true;
      return err;
    }
    if (status === 401 || status === 403) {
      // 优先透传服务端文案（邮箱未验证 / 登录已过期等），无 body 再用本地兜底。
      // 0.15.1：仅 401 标记 auth（触发会话清理）；403 多来自 WAF/反代拦截，
      // 令牌未必失效，清会话会造成"被网络层误伤就掉登录"
      let serverMsg = "";
      try {
        const xhr = e.xmlhttp;
        const rj = xhr && (xhr.response || (xhr.responseText && JSON.parse(xhr.responseText)));
        if (rj && rj.error) serverMsg = rj.error;
      } catch (_) { /* ignore */ }
      const err = new Error(serverMsg || (status === 401 ? "邮箱或密码错误" : "无权限（HTTP 403）"));
      err.auth = (status === 401);
      return err;
    }
    if (status === 429) {
      const err = new Error("尝试过于频繁，请稍后再试（HTTP 429）");
      return err;
    }
    if (status >= 500) {
      const err = new Error("账号服务器内部错误（HTTP " + status + "），请稍后再试");
      return err;
    }
    const err = new Error("网络异常：" + msg);
    err.network = true;
    return err;
  },

  /** 调试日志里的 token 一律脱敏 */
  _mask(token) {
    const t = String(token || "");
    return t.length <= 8 ? "****" : t.slice(0, 4) + "****" + t.slice(-4);
  },
};
