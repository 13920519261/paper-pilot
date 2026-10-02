/* PaperPilot 期刊分区列（0.18.0 重构：多分区完整显示 + 精准行刷新 + 可调配色系）
 * 数据来源（按优先级）：
 *  1. 内置示例数据 + 用户自定义 JSON（离线兜底，设置中可指定）
 *  2. easyScholar 开放接口 getPublicationRank（在线主源），结果本地缓存
 *     （DataDirectory/paperpilot-easyscholar.json），查询队列限速 ~3 req/s，
 *     失败 30 分钟负缓存
 *
 * 0.18.0 修复与增强：
 *  - 修复「列表不显示、点击文章才显示」：异步结果到达后仅 refreshColumns()
 *    只重置列配置、不重取行数据（Zotero itemTree.jsx 的 itemtree/refresh 走
 *    _resetColumns + refreshAndMaintainSelection，行数据缓存不动；选中行
 *    invalidate 才会重调 dataProvider——用户所见即此）。现按插件圈标准解法
 *    双通道刷新：refreshColumns + Notifier.trigger("redraw","item",ids)
 *    （zotero-AI-Butler 同款），ids 精确到等待中的条目，避免全树闪烁。
 *  - 多分区完整显示：改用 officialRank.all 全量数据集（原 select||all 只取
 *    一个，大类命中即丢小类）；JCR/SSCI/中科院大区/小类/TOP/CCF/IF/预警等
 *    全部 badge 化展示，数量与数据集可在设置中配置。
 *  - 配色：分区等级色阶（Q1 红/Q2 橙/Q3 蓝/Q4 灰、CCF 绿青灰、TOP 金描边），
 *    彩色/单色（跟随主题 accent）两种风格；降级：查询失败负缓存 30 分钟、
 *    空结果不写入条目级缓存（负缓存过期后可自动重查）、tooltip 显示失败原因。
 */
/* global Zotero, IOUtils, PathUtils, Prefs, I18n */

var RankColumn = {
  COLUMN_KEY: "paperpilot-journalRank",
  _data: {},
  _lookupCache: new Map(), // itemID -> {text, badges, detail}（空结果不缓存，见 lookup）
  _registered: false,
  _pendingRefresh: new Set(), // 等待数据的 itemID（数据到达后精准 redraw）

  /* easyScholar 状态 */
  ES_ENDPOINT: "https://www.easyscholar.cc/open/getPublicationRank",

  /* 内置官方默认 SecretKey（0.15.0）：前期用户开箱即用。
   * - 用户在设置中填了自定义 Key 时优先使用用户值（走用户自有额度）。
   * - 此值随插件公开分发（用户主动决策共享），2026-10-02 实测有效（code:200）。
   */
  ES_OFFICIAL_KEY: "0ad3dcb704e74f6780c6f66d868d8a23",

  _esCache: new Map(),     // 规范化刊名 -> {text, badges, detail, neg, t, retryAfter}
  _esQueue: [],
  _esQueued: new Set(),
  _esWorking: false,
  _esRefreshTimer: null,
  _esSaveTimer: null,
  _esCacheLoaded: false,

  /* ================= 显示配置（pref 驱动） ================= */

  /** 数据集元信息：kind -> { label, defaultOn, 色阶 }（顺序即显示优先级） */
  DATASETS: [
    { kind: "warning", label: "中科院预警", on: true },
    { kind: "jcr", label: "JCR 分区（SCI）", on: true },
    { kind: "ssci", label: "SSCI 分区", on: true },
    { kind: "cas", label: "中科院分区（大类）", on: true },
    { kind: "casSmall", label: "中科院分区（小类）", on: true },
    { kind: "ccf", label: "CCF 评级", on: true },
    { kind: "if", label: "影响因子", on: true },
    { kind: "if5", label: "5 年影响因子", on: false },
    { kind: "casBase", label: "中科院基础版", on: false },
    { kind: "esi", label: "ESI 学科", on: false },
    { kind: "ajg", label: "AJG/ABS 评级", on: false },
    { kind: "abdc", label: "ABDC 评级", on: false },
    { kind: "jci", label: "JCI 指数", on: false },
  ],

  /** 启用的数据集 kind 集合（pref rankDataSets，逗号分隔；空 = 默认 on 的集合） */
  enabledKinds() {
    const raw = String(Prefs.get("rankDataSets", "") || "").trim();
    const def = this.DATASETS.filter((d) => d.on).map((d) => d.kind);
    if (!raw) return new Set(def);
    const set = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
    // 保证 kind 合法
    const valid = new Set(this.DATASETS.map((d) => d.kind));
    for (const k of [...set]) if (!valid.has(k)) set.delete(k);
    return set.size ? set : new Set(def);
  },

  maxBadges() {
    const n = Number(Prefs.get("rankMaxBadges", 6));
    return isFinite(n) ? Math.min(12, Math.max(1, Math.round(n))) : 6;
  },

  badgeStyleMode() {
    return String(Prefs.get("rankBadgeStyle", "color") || "color"); // color | mono
  },

  /* ================= easyScholar 在线源 ================= */

  esKey() {
    const custom = String(Prefs.get("easyScholarKey", "") || "").trim();
    return custom || String(this.ES_OFFICIAL_KEY || "").trim();
  },

  _esEnabled() {
    return !!Prefs.get("easyScholarEnabled", true) && !!this.esKey();
  },

  _esCacheFile() {
    return PathUtils.join(Zotero.DataDirectory.dir, "paperpilot-easyscholar.json");
  },

  async _esLoadCache() {
    if (this._esCacheLoaded) return;
    this._esCacheLoaded = true;
    try {
      const obj = JSON.parse(await IOUtils.readUTF8(this._esCacheFile()));
      for (const k of Object.keys(obj || {})) this._esCache.set(k, obj[k]);
      Zotero.debug(`PaperPilot: easyScholar 缓存 ${this._esCache.size} 条`);
    } catch (e) { /* 无缓存文件属正常 */ }
  },

  _esSaveCacheSoon() {
    if (this._esSaveTimer) return;
    this._esSaveTimer = setTimeout(async () => {
      this._esSaveTimer = null;
      try {
        const obj = {};
        for (const [k, v] of this._esCache) obj[k] = v;
        await IOUtils.writeUTF8(this._esCacheFile(), JSON.stringify(obj));
      } catch (e) {
        Zotero.debug("PaperPilot: easyScholar 缓存写入失败 " + e);
      }
    }, 3000);
  },

  async esClearCache() {
    this._esCache.clear();
    this._esQueued.clear();
    this._esQueue.length = 0;
    this._lookupCache.clear();
    this._pendingRefresh.clear();
    try { await IOUtils.remove(this._esCacheFile()); } catch (e) { /* ignore */ }
    this._esRefreshColumns();
  },

  esCacheSize() {
    return this._esCache.size;
  },

  /* ================= 分区数据结构化（0.18.0 核心） ================= */

  /** 从 easyScholar 响应提取结构化分区（badges 全量 + text 紧凑串 + detail 详情）
   *  改用 officialRank.all（全量数据集）；officialRank.select 为扩展端用户自选
   *  子集，only 当 all 缺失时兜底。 */
  _esFormat(resp) {
    const d = resp && resp.data;
    if (!d) return null;
    const off = (d.officialRank && (d.officialRank.all || d.officialRank.select)) || {};
    const badges = [];
    const detail = [];
    const push = (kind, text, level, extra) => {
      if (!text) return;
      badges.push(Object.assign({ kind, text, level: level || 0 }, extra || {}));
    };

    // 预警（最高优先级提示）
    if (off.sciwarning) {
      const w = String(off.sciwarning);
      if (!/无|否|none/i.test(w)) {
        push("warning", "⚠预警", 1);
        detail.push("中科院预警: " + w);
      }
    }
    // JCR SCI 分区（Q1-Q4）
    if (off.sci) {
      const q = String(off.sci).match(/Q?([1-4])/i);
      push("jcr", String(off.sci).toUpperCase().startsWith("Q") ? String(off.sci).toUpperCase() : "Q" + (q ? q[1] : off.sci), q ? parseInt(q[1], 10) : 0);
      detail.push("JCR 分区: " + off.sci);
    }
    // SSCI 分区
    if (off.ssci) {
      const q = String(off.ssci).match(/Q?([1-4])/i);
      push("ssci", "SSCI " + String(off.ssci).toUpperCase(), q ? parseInt(q[1], 10) : 0);
      detail.push("SSCI 分区: " + off.ssci);
    }
    // 中科院升级版（大类）
    const casUp = off.sciUp || "";
    if (casUp) {
      const m = String(casUp).match(/(\d)\s*区/);
      const lv = m ? parseInt(m[1], 10) : 0;
      const top = !!(off.sciUpTop && /TOP/i.test(String(off.sciUpTop)));
      push("cas", "中科院" + (m ? m[1] + "区" : casUp), lv, top ? { top: true } : null);
      detail.push("中科院升级版(大类): " + casUp + (top ? " [TOP]" : ""));
    }
    // 中科院升级版小类（可能与大类不同，全部展示）
    const casSmall = off.sciUpSmall || off.sciUpSmallClass || "";
    if (casSmall && casSmall !== casUp) {
      const m = String(casSmall).match(/(\d)\s*区/);
      const lv = m ? parseInt(m[1], 10) : 0;
      const top = !!(off.sciUpSmallTop && /TOP/i.test(String(off.sciUpSmallTop)));
      push("casSmall", "小类" + (m ? m[1] + "区" : casSmall), lv, top ? { top: true } : null);
      detail.push("中科院升级版(小类): " + casSmall + (top ? " [TOP]" : ""));
    }
    // CCF（customRank 自定义评级集，含 CCF/各机构）
    const ccfInfo = this._esCustomRank(d, detail);
    if (ccfInfo) {
      const lv = /^A/i.test(ccfInfo) ? 1 : /^B/i.test(ccfInfo) ? 2 : /^C/i.test(ccfInfo) ? 3 : 0;
      push("ccf", "CCF-" + ccfInfo, lv);
    }
    // 影响因子
    if (off.sciif) {
      push("if", "IF " + off.sciif, 0);
      detail.push("影响因子: " + off.sciif);
    }
    if (off.sciif5) { push("if5", "IF5 " + off.sciif5, 0); detail.push("5年影响因子: " + off.sciif5); }
    // 中科院基础版
    if (off.sciBase && off.sciBase !== casUp) {
      const m = String(off.sciBase).match(/(\d)\s*区/);
      push("casBase", "基础版" + (m ? m[1] + "区" : off.sciBase), m ? parseInt(m[1], 10) : 0);
      detail.push("中科院基础版: " + off.sciBase);
    }
    // 其他评级
    if (off.esi) { push("esi", "ESI " + off.esi, 0); detail.push("ESI 学科: " + off.esi); }
    if (off.ajg) { push("ajg", "AJG " + off.ajg, 0); detail.push("AJG/ABS: " + off.ajg); }
    if (off.abdc) { push("abdc", "ABDC " + off.abdc, 0); detail.push("ABDC: " + off.abdc); }
    if (off.jci) { push("jci", "JCI " + off.jci, 0); detail.push("JCI: " + off.jci); }
    if (off.cpu) detail.push("评价: " + off.cpu);

    if (!badges.length && !detail.length) return null;
    return {
      badges: badges,
      text: badges.map((b) => b.text).join(" · "),
      detail: detail.join("\n"),
    };
  },

  /** customRank 提取（CCF 等）；其余机构评级写入 detail */
  _esCustomRank(d, detail) {
    let ccf = null;
    try {
      const cr = d.customRank;
      if (cr && Array.isArray(cr.rank) && Array.isArray(cr.rankInfo)) {
        for (const r of cr.rank) {
          const [uuid, idx] = String(r).split("&&&");
          const info = cr.rankInfo.find((x) => x.uuid === uuid);
          if (!info || !info.abbName) continue;
          const val = info[["oneRankText", "twoRankText", "threeRankText", "fourRankText"][idx - 1]];
          if (!val || !String(val).trim()) continue;
          const v = String(val).trim();
          if (/^CCF$/i.test(info.abbName)) ccf = ccf || v;
          else detail.push(info.abbName + ": " + v);
        }
      }
    } catch (e) { /* ignore */ }
    if (ccf) detail.push("CCF: " + ccf);
    return ccf;
  },

  async _esFetch(pubName) {
    const key = this.esKey();
    if (!key) throw new Error("未配置 easyScholar SecretKey");
    const url = this.ES_ENDPOINT + "?secretKey=" + encodeURIComponent(key)
      + "&publicationName=" + encodeURIComponent(pubName);
    const req = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 15000 });
    const resp = req.response;
    if (!resp || resp.code !== 200) {
      throw new Error("easyScholar 返回异常: " + (resp && (resp.msg || resp.code)));
    }
    return resp;
  },

  _esEnqueue(pubName) {
    const norm = this.normalize(pubName);
    if (!norm || this._esCache.has(norm) || this._esQueued.has(norm)) return;
    this._esQueued.add(norm);
    this._esQueue.push(pubName.trim());
    if (!this._esWorking) this._esWork();
  },

  async _esWork() {
    if (this._esWorking) return;
    this._esWorking = true;
    while (this._esQueue.length) {
      const name = this._esQueue.shift();
      const norm = this.normalize(name);
      this._esQueued.delete(norm);
      if (this._esCache.has(norm)) continue;
      try {
        const fmt = this._esFormat(await this._esFetch(name));
        this._esCache.set(norm, fmt
          ? { text: fmt.text, badges: fmt.badges, detail: fmt.detail, t: Date.now() }
          : { neg: 1, t: Date.now(), failReason: "easyScholar 无此期刊分区数据" });
      } catch (e) {
        Zotero.debug(`PaperPilot: easyScholar 查询失败 '${name}': ${e && e.message || e}`);
        this._esCache.set(norm, {
          neg: 1, t: Date.now(), retryAfter: Date.now() + 30 * 60 * 1000,
          failReason: "查询失败: " + (e && e.message || e),
        });
      }
      this._esSaveCacheSoon();
      this._esRefreshSoon();
      await new Promise((r) => setTimeout(r, 350)); // 限速 ~3 req/s
    }
    this._esWorking = false;
  },

  _esRefreshSoon() {
    if (this._esRefreshTimer) return;
    this._esRefreshTimer = setTimeout(() => {
      this._esRefreshTimer = null;
      this._esRefreshColumns();
    }, 800);
  },

  /** 双通道刷新（0.18.0 修复核心）：
   *  ① refreshColumns 重置列配置（Zotero 官方通道）
   *  ② Notifier.trigger("redraw","item",ids) 让等待中的条目行 invalidate、
   *     重调 dataProvider——仅此通道能让新数据显示出来（refreshColumns 的
   *     itemtree/refresh 只 _resetColumns + refreshAndMaintainSelection，
   *     不清行数据缓存；这就是"点击文章才显示"的根因——点击触发选中行
   *     invalidate 才会重取数据）。zotero-AI-Butler 等列插件同款解法。 */
  _esRefreshColumns() {
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    const ids = [...this._pendingRefresh];
    this._pendingRefresh.clear();
    if (ids.length) {
      try {
        Zotero.Notifier.trigger("redraw", "item", ids, {}, true);
      } catch (e) {
        // 老版本无 trigger：退化为全量 redraw（ids 空 = 全树 invalidate）
        try { Zotero.Notifier.trigger("redraw", "item", []); } catch (e2) { /* ignore */ }
      }
    }
  },

  /** 同步查询 easyScholar 缓存；未命中则入队并返回加载占位 */
  _esLookup(pubName) {
    const norm = this.normalize(pubName);
    const hit = this._esCache.get(norm);
    if (!hit) {
      this._esEnqueue(pubName);
      return { pending: true, text: "…", detail: "查询中：" + pubName };
    }
    if (hit.neg) {
      if (hit.retryAfter && Date.now() > hit.retryAfter) {
        this._esCache.delete(norm);
        this._esEnqueue(pubName);
        return { pending: true, text: "…", detail: "重试中：" + pubName };
      }
      return { text: "", detail: hit.failReason || "" };
    }
    // 旧版缓存（无 badges 字段）兼容：包装单色 badge 显示
    if (!hit.badges) {
      return { text: hit.text, badges: hit.text ? [{ kind: "legacy", text: hit.text, level: 0 }] : [], detail: hit.detail };
    }
    return hit;
  },

  /* ================= 离线数据 ================= */

  normalize(name) {
    return (name || "").toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  },

  async _readBundledJSON(url) {
    try {
      const text = await Zotero.File.getContentsFromURLAsync(url);
      return JSON.parse(text);
    } catch (e) {
      const resp = await Zotero.HTTP.request("GET", url, { responseType: "json" });
      return resp.response || {};
    }
  },

  async load(rootURI) {
    this._rootURI = rootURI;
    try {
      this._data = await this._readBundledJSON(rootURI + "chrome/content/data/journal-rank.json") || {};
    } catch (e) {
      Zotero.logError(e);
      this._data = {};
    }
    const customPath = Prefs.get("rankDataPath", "");
    if (customPath) {
      try {
        const custom = await IOUtils.readJSON(customPath);
        Object.assign(this._data, custom);
        Zotero.debug(`PaperPilot: 已加载自定义分区数据 ${customPath}`);
      } catch (e) {
        Zotero.logError(new Error("PaperPilot: 自定义分区数据加载失败 " + customPath));
        Zotero.logError(e);
      }
    }
    delete this._data._comment;
    this._lookupCache.clear();
    await this._esLoadCache();
  },

  async reload() {
    if (!this._rootURI) return;
    await this.load(this._rootURI);
    this._esRefreshColumns();
  },

  _match(name) {
    const key = this.normalize(name);
    if (!key) return "";
    if (this._data[key] != null) return String(this._data[key]);
    for (const k in this._data) {
      if (k.length >= 6 && key.includes(k)) return String(this._data[k]);
    }
    return "";
  },

  /* ================= 配色（0.18.0：色阶 + 主题自适应 + 可切换风格） ================= */

  /** kind+level → 颜色（彩色模式）；TOP 金色描边。
   *  色块底 + 白字在浅/深主题下对比均达标（0.17.1 仿真验证原则）。 */
  _badgeColor(badge) {
    const L = badge.level;
    switch (badge.kind) {
      case "warning": return "#b03060";
      case "jcr":
      case "ssci":
        return L === 1 ? "#c0392b" : L === 2 ? "#e67e22" : L === 3 ? "#2980b9" : "#7f8c8d";
      case "cas":
      case "casSmall":
      case "casBase":
        return L === 1 ? "#a8324a" : L === 2 ? "#d35400" : L === 3 ? "#2471a3" : "#707b7c";
      case "ccf":
        return L === 1 ? "#0e8a6d" : L === 2 ? "#17a2a8" : L === 3 ? "#707b7c" : "#707b7c";
      case "if":
      case "if5":
        return "#6c5ce7";
      case "esi":
        return "#2980b9";
      case "ajg":
      case "abdc":
        return "#d35400";
      case "jci":
        return "#5b8fd4";
      default:
        return "#7f8c8d"; // legacy/未知
    }
  },

  _badgeCss(badge) {
    const mono = this.badgeStyleMode() === "mono";
    const bg = mono ? "var(--color-accent, #7f8c8d)" : this._badgeColor(badge);
    let css = "background:" + bg + ";color:#fff;border-radius:4px;" +
      "padding:0 5px;font-size:11px;line-height:16px;margin-inline-end:4px;" +
      "white-space:nowrap;display:inline-block;";
    if (badge.top) css += "box-shadow:inset 0 0 0 1.5px #ffd76a;"; // TOP 金描边
    return css;
  },

  /* ================= 条目查询（dataProvider） ================= */

  /** 返回 {text, badges, detail, pending} 或 null（无数据）。
   *  空结果不写入 _lookupCache——负缓存条目在 easyScholar 负缓存过期后
   *  可自动重查（此前缓存 "" 导致失败后永久空白）。 */
  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return null;
    if (this._lookupCache.has(item.id)) return this._lookupCache.get(item.id);
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    const pub = get("publicationTitle") || get("journalAbbreviation");
    // 1. 离线数据（内置 + 自定义 JSON）优先
    let hit = this._match(pub) || this._match(get("journalAbbreviation"));
    let out = null;
    if (hit) {
      out = { text: hit, badges: [{ kind: "legacy", text: hit, level: 0 }], detail: "离线数据: " + hit };
    } else if (pub && this._esEnabled()) {
      // 2. easyScholar 在线源
      const r = this._esLookup(pub);
      if (r.pending) {
        this._pendingRefresh.add(item.id); // 数据到达后精准 redraw 此行
        out = { text: r.text, badges: [], detail: r.detail, pending: true };
      } else if (r.text) {
        out = { text: r.text, badges: r.badges || [], detail: r.detail };
      } else {
        out = r.detail ? { text: "", badges: [], detail: r.detail } : null;
      }
    }
    // "…" 占位与空结果都不缓存（占位待刷新重查；空结果待负缓存过期重查）
    if (out && !out.pending && out.text) {
      this._lookupCache.set(item.id, out);
    }
    return out;
  },

  /** 单元格悬停详情（tooltip 用完整信息） */
  lookupDetail(item) {
    const r = this.lookup(item);
    return (r && r.detail) || "";
  },

  /* ================= 列注册与渲染 ================= */

  async register(pluginID) {
    if (this._registered) return;
    const self = this;
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("rankColumnLabel"),
      dataProvider: (item) => this.lookup(item),
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const span = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = `cell ${column.className}`;
        if (!data) return span;
        // 加载占位（"…"）
        if (data.pending) {
          span.textContent = data.text;
          span.style.cssText = "color:var(--fill-tertiary,#888);font-size:11px;";
          return span;
        }
        // badge 渲染（按启用数据集过滤 + 数量上限）
        const kinds = self.enabledKinds();
        const all = (data.badges || []).filter((b) => b.kind === "legacy" || kinds.has(b.kind));
        const max = self.maxBadges();
        const shown = all.slice(0, max);
        for (const b of shown) {
          const el = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
          el.textContent = b.text;
          el.style.cssText = self._badgeCss(b);
          span.appendChild(el);
        }
        if (all.length > shown.length) {
          const more = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
          more.textContent = "+" + (all.length - shown.length);
          more.style.cssText = "color:var(--fill-tertiary,#888);font-size:10.5px;";
          span.appendChild(more);
        }
        if (data.detail) span.title = data.detail;
        return span;
      },
    });
    this._registered = true;
  },

  unregister() {
    if (this._registered) {
      Zotero.ItemTreeManager.unregisterColumns(this.COLUMN_KEY);
      this._registered = false;
    }
    this._lookupCache.clear();
    this._pendingRefresh.clear();
  },
};
