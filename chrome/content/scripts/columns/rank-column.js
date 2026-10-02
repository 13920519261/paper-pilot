/* PaperPilot 期刊分区列（0.5.0 升级；0.15.0 内置官方 SecretKey）
 * 数据来源（按优先级）：
 *  1. 内置示例数据 + 用户自定义 JSON（离线兜底，设置中可指定）
 *  2. easyScholar 开放接口 getPublicationRank（在线主源：JCR 分区 / 影响因子 /
 *     中科院分区 / CCF 等），结果本地缓存（DataDirectory/paperpilot-easyscholar.json），
 *     查询队列限速 ~3 req/s，未命中 30 分钟负缓存
 * JSON 格式：{"规范化期刊名": "分区"}，规范化 = 小写、仅保留字母数字与中日韩字符
 *
 * SecretKey 优先级（0.15.0）：设置中自定义 easyScholarKey > 内置官方 Key（开箱即用）
 */
/* global Zotero, IOUtils, PathUtils, Prefs, I18n */

var RankColumn = {
  COLUMN_KEY: "paperpilot-journalRank",
  _data: {},
  _lookupCache: new Map(), // itemID -> rank 字符串
  _registered: false,

  /* easyScholar 状态 */
  ES_ENDPOINT: "https://www.easyscholar.cc/open/getPublicationRank",

  /* ⚠️ 内置官方默认 SecretKey（0.15.0）：前期用户开箱即用。
   * ┌─ 发版前必改：把下方空字符串填入官方 SecretKey（easyscholar.cc 控制台获取）。
   * ├─ 用户在设置中填了自定义 Key 时优先使用用户值（走用户自有额度）。
   * └─ 注意：此值会随插件分发公开，请使用可公开共享的官方 Key，勿填私人高额 Key。
   */
  ES_OFFICIAL_KEY: "",

  _esCache: new Map(),     // 规范化刊名 -> {text, detail, neg, t, retryAfter}
  _esQueue: [],
  _esQueued: new Set(),
  _esWorking: false,
  _esRefreshTimer: null,
  _esSaveTimer: null,
  _esCacheLoaded: false,

  /* ================= easyScholar 在线源 ================= */

  /** 生效的 SecretKey：用户自定义 pref 优先，留空回退内置官方 Key（0.15.0） */
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
    try { await IOUtils.remove(this._esCacheFile()); } catch (e) { /* ignore */ }
    this._esRefreshColumns();
  },

  esCacheSize() {
    return this._esCache.size;
  },

  /** 从 easyScholar 响应提取紧凑显示文本与完整详情 */
  _esFormat(resp) {
    const d = resp && resp.data;
    if (!d) return null;
    const off = (d.officialRank && (d.officialRank.select || d.officialRank.all)) || {};
    const parts = [];
    const detail = [];
    if (off.sci) { parts.push(off.sci); detail.push("JCR: " + off.sci); }
    if (off.sciif) { parts.push("IF " + off.sciif); detail.push("影响因子: " + off.sciif); }
    let cas = off.sciUp || "";
    if (cas) {
      const m = cas.match(/(\d区)/);
      let short = m ? m[1] : cas;
      if (off.sciUpTop && /TOP/i.test(off.sciUpTop)) short += "TOP";
      parts.push("中科院" + short);
      detail.push("中科院升级版: " + cas + (off.sciUpTop ? " (" + off.sciUpTop + ")" : ""));
    }
    if (off.sciBase && off.sciBase !== cas) detail.push("中科院基础版: " + off.sciBase);
    if (off.sciif5) detail.push("5年IF: " + off.sciif5);
    if (off.esi) detail.push("ESI: " + off.esi);
    if (off.cpu) detail.push("评价: " + off.cpu);
    try {
      const cr = d.customRank;
      if (cr && Array.isArray(cr.rank) && Array.isArray(cr.rankInfo)) {
        for (const r of cr.rank) {
          const [uuid, idx] = String(r).split("&&&");
          const info = cr.rankInfo.find((x) => x.uuid === uuid);
          if (!info || !info.abbName) continue;
          const val = info[["oneRankText", "twoRankText", "threeRankText", "fourRankText"][idx - 1]];
          if (val && val.trim()) {
            detail.push(info.abbName + " " + val.trim());
            if (/^CCF$/i.test(info.abbName)) parts.push("CCF-" + val.trim());
          }
        }
      }
    } catch (e) { /* ignore */ }
    if (!parts.length && !detail.length) return null;
    return { text: parts.join(" · "), detail: detail.join("\n") };
  },

  async _esFetch(pubName) {
    const key = this.esKey();
    if (!key) throw new Error("未配置 easyScholar SecretKey（内置官方 Key 未填入，且设置中未自定义）");
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
          ? { text: fmt.text, detail: fmt.detail, t: Date.now() }
          : { neg: 1, t: Date.now() });
      } catch (e) {
        Zotero.debug(`PaperPilot: easyScholar 查询失败 '${name}': ${e && e.message || e}`);
        this._esCache.set(norm, { neg: 1, t: Date.now(), retryAfter: Date.now() + 30 * 60 * 1000 });
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

  _esRefreshColumns() {
    try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
  },

  /** 同步查询 easyScholar 缓存；未命中则入队并返回加载占位 */
  _esLookup(pubName) {
    const norm = this.normalize(pubName);
    const hit = this._esCache.get(norm);
    if (!hit) {
      this._esEnqueue(pubName);
      return { text: "…", detail: "查询中：" + pubName };
    }
    if (hit.neg) {
      if (hit.retryAfter && Date.now() > hit.retryAfter) {
        this._esCache.delete(norm);
        this._esEnqueue(pubName);
        return { text: "…", detail: "重试中：" + pubName };
      }
      return { text: "", detail: "" };
    }
    return hit;
  },

  /* ================= 离线数据 ================= */

  normalize(name) {
    return (name || "").toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  },

  /** 从插件包内 URL 读 JSON（jar: 协议下 XHR 不稳，优先走 Zotero.File） */
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
    // 1. 内置示例数据
    try {
      this._data = await this._readBundledJSON(rootURI + "chrome/content/data/journal-rank.json") || {};
    } catch (e) {
      Zotero.logError(e);
      this._data = {};
    }
    // 2. 用户自定义数据（覆盖内置）
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
    // 3. easyScholar 在线缓存
    await this._esLoadCache();
  },

  /** 重新加载数据并刷新列表（pref 变更时调用） */
  async reload() {
    if (!this._rootURI) return;
    await this.load(this._rootURI);
    try {
      Zotero.ItemTreeManager.refreshColumns();
    } catch (e) {
      Zotero.debug("PaperPilot: refreshColumns 不可用，列表将随滚动刷新 " + e);
    }
  },

  _match(name) {
    const key = this.normalize(name);
    if (!key) return "";
    if (this._data[key] != null) return String(this._data[key]);
    // 简单子串兜底：数据键被期刊名包含（处理 "The Lancet" / "Lancet" 这类）
    for (const k in this._data) {
      if (k.length >= 6 && key.includes(k)) return String(this._data[k]);
    }
    return "";
  },

  lookup(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    if (this._lookupCache.has(item.id)) return this._lookupCache.get(item.id);
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    const pub = get("publicationTitle") || get("journalAbbreviation");
    // 1. 离线数据（内置 + 自定义 JSON）优先
    let rank = this._match(pub) || this._match(get("journalAbbreviation"));
    // 2. easyScholar 在线源兜底
    if (!rank && pub && this._esEnabled()) {
      rank = this._esLookup(pub).text;
    }
    if (this._lookupCache.size > 5000) this._lookupCache.clear();
    // "…" 占位不入缓存，让重绘时重新查
    if (rank !== "…") this._lookupCache.set(item.id, rank);
    return rank;
  },

  /** 单元格悬停详情（easyScholar 命中时有完整榜单信息） */
  lookupDetail(item) {
    if (!item || !item.isRegularItem || !item.isRegularItem()) return "";
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    const pub = get("publicationTitle") || get("journalAbbreviation");
    if (!pub) return "";
    const hit = this._esCache.get(this.normalize(pub));
    return hit && !hit.neg ? (hit.detail || "") : "";
  },

  badgeColor(rank) {
    const r = String(rank || "");
    if (r.includes("1")) return "#c0392b";   // 1区 红
    if (r.includes("2")) return "#e67e22";   // 2区 橙
    if (r.includes("3")) return "#2980b9";   // 3区 蓝
    return "#7f8c8d";                         // 4区/其他 灰
  },

  async register(pluginID) {
    if (this._registered) return;
    await Zotero.ItemTreeManager.registerColumns({
      pluginID,
      dataKey: this.COLUMN_KEY,
      label: I18n.t("rankColumnLabel"),
      dataProvider: (item) => this.lookup(item),
      renderCell: (index, data, column, isFirstColumn, doc) => {
        const span = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        span.className = `cell ${column.className}`;
        if (data) {
          span.textContent = data;
          span.style.cssText =
            `background:${this.badgeColor(data)};color:#fff;border-radius:4px;` +
            "padding:0 6px;font-size:11px;line-height:16px;";
        }
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
  },
};
