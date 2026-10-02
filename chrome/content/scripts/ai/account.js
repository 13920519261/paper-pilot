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

  /* ---------- 会话文件（数据目录，0600，原子写） ---------- */

  _sessionFile() {
    const dir = Zotero.DataDirectory && Zotero.DataDirectory.dir;
    if (!dir) return null;
    try { return PathUtils.join(dir, "paperpilot-account.json"); } catch (e) { return null; }
  },

  async _save() {
    const file = this._sessionFile();
    if (!file) return;
    try {
      const body = JSON.stringify({
        token: this._session.token,
        expiresAt: this._session.expiresAt || 0,
        savedAt: Date.now(),
        user: this._session.user || {},
      });
      // tmpPath 原子替换：写一半崩溃/断电不会留下半截会话文件
      await IOUtils.writeUTF8(file, body, { mode: 0o600, tmpPath: file + ".tmp" });
    } catch (e) {
      try { Zotero.debug("PaperPilot: account session save failed: " + (e && e.message)); } catch (_) { /* ignore */ }
    }
  },

  async _clearFile() {
    const file = this._sessionFile();
    if (!file) return;
    try { await IOUtils.remove(file, { ignoreAbsent: true }); } catch (e) { /* ignore */ }
  },

  /* ---------- 启动恢复：读盘 → 过期即弃 → 尽力刷新用户信息 ---------- */

  async restore() {
    if (this._restoring) return;
    this._restoring = true;
    try {
      const file = this._sessionFile();
      if (!file) return;
      let doc = null;
      try {
        doc = JSON.parse(await IOUtils.readUTF8(file));
      } catch (e) { return; /* 无文件/损坏：视为未登录 */ }
      if (!doc || !doc.token) return;
      if (doc.expiresAt && Date.now() > doc.expiresAt) {
        await this._clearFile(); // 本地判过期：直接清理，不打扰
        return;
      }
      this._session = {
        token: String(doc.token),
        expiresAt: Number(doc.expiresAt) || 0,
        user: doc.user || {},
      };
      // 尽力校验 + 刷新（服务端可能已吊销 token）：失败不阻塞启动
      await this.refreshUser({ silent: true });
    } catch (e) {
      try { Zotero.debug("PaperPilot: account restore failed: " + (e && e.message)); } catch (_) { /* ignore */ }
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
    let resp;
    try {
      resp = await this._request("GET", "/api/auth/me", null, this._session.token, 10000);
    } catch (e) {
      if (e && e.auth) {
        await this.handleAuthFailure(e.message, { silent });
      }
      throw e;
    }
    const j = resp.json || {};
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
      const err = new Error((json && json.error) || ("HTTP " + req.status));
      if (req.status === 401 || req.status === 403) err.auth = true;
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
      // 优先透传服务端文案（邮箱未验证 / 登录已过期等），无 body 再用本地兜底
      let serverMsg = "";
      try {
        const xhr = e.xmlhttp;
        const rj = xhr && (xhr.response || (xhr.responseText && JSON.parse(xhr.responseText)));
        if (rj && rj.error) serverMsg = rj.error;
      } catch (_) { /* ignore */ }
      const err = new Error(serverMsg || (status === 401 ? "邮箱或密码错误" : "无权限（HTTP 403）"));
      err.auth = true;
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
