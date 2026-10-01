/* PaperPilot 中文元数据网络抓取（0.14.5，茉莉花「抓取期刊元数据」同等能力）
 * 适用场景：拖入 Zotero 的知网/万方中文 PDF 只有文件名、没有元数据。
 * 流程：文件名/标题 → 搜索链 → 选中匹配 → 回填完整元数据（保留原附件）。
 *
 * 搜索链（早期命中即停）：
 *   1. PubScholar 中科院公益学术平台——开放 JSON API、无验证码、覆盖知网/万方/维普，
 *      含摘要/DOI/关键词，为首选源（移植自 jasminum pubscholar.ts，签名算法同源）
 *   2. CNKI 知网直接搜索——命中率高但会触发风控：403 滑块 或 200 no-content 软拦；
 *      被拦时由 CNVerify 引导用户在内置标签页过验证（0.14.8 起验证通过自动续抓）
 *
 * 保护策略：仅在条目元数据不完整（标题=文件名 或 缺作者/期刊）时回填；
 * 字段级保护——已有值的字段（除标题=文件名场景）一律不覆盖。
 */
/* global Zotero, Services, Components, IOUtils, PathUtils, Prefs, I18n, ItemSel, CNMeta, _ppDiag */

var CNFetch = {
  _diag(msg) {
    try { _ppDiag("cn-fetch: " + msg); } catch (e) { /* ignore */ }
  },

  // ================= 文本处理 =================

  _normalizeTitle(t) {
    return String(t || "")
      .replace(/\.{2,}|…+/g, " ")
      .replace(/[_＿]+/g, " ")
      .replace(/[《》“”"':：,，.。;；()[\]（）【】<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  _compact(t) {
    return this._normalizeTitle(t).replace(/\s+/g, "");
  },

  /** 标题匹配：忽略空白/标点后相等或互相包含 */
  _isTitleMatch(a, b) {
    const ca = this._compact(String(a || "").replace(/<[^>]+>/g, ""));
    const cb = this._compact(b);
    if (!ca || !cb) return false;
    return ca === cb || ca.includes(cb) || cb.includes(ca);
  },

  _escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  },

  /** 构建候选查询（从精确到宽泛，去重最多 4 条） */
  _buildQueries(title, author) {
    let t = this._normalizeTitle(title);
    if (author) t = this._normalizeTitle(t.replace(new RegExp(this._escapeRe(author), "g"), " "));
    const tokens = t.replace(/的/g, " ").split(/\s+/).filter(Boolean);
    const qs = [];
    if (t) qs.push(t);
    if (tokens.length >= 2) {
      qs.push(tokens.join(" "));
      qs.push([tokens[0], tokens[tokens.length - 1]].join(" "));
    }
    return [...new Set(qs)].slice(0, 4);
  },

  // ================= PubScholar 源 =================

  _PS_URL: "https://pubscholar.cn/hky/open/resources/api/v1/articles",
  _PS_SECRET: "6m6pingbinwaktg227gngifoocrfbo95", // jasminum 逆向签名密钥（同源轮换会整体失效）

  _randToken(n) {
    let v = "";
    while (v.length < n) v += Math.random().toString(36).slice(2).toUpperCase();
    return v.slice(0, n);
  },

  _randHex(n) {
    let v = "";
    while (v.length < n) v += Math.floor(Math.random() * 16).toString(16);
    return v;
  },

  _rotl(v, b) { return (v << b) | (v >>> (32 - b)); },

  // 手写 SHA-1（FIPS 180-1）：Zotero 插件环境 crypto.subtle 受限，与 jasminum 同实现
  _sha1(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    for (let i = 3; i >= 0; i--) bytes.push((hi >>> (i * 8)) & 0xff);
    for (let i = 3; i >= 0; i--) bytes.push((lo >>> (i * 8)) & 0xff);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    for (let i = 0; i < bytes.length; i += 64) {
      const w = new Array(80);
      for (let j = 0; j < 16; j++) {
        w[j] = (bytes[i + j * 4] << 24) | (bytes[i + j * 4 + 1] << 16) |
               (bytes[i + j * 4 + 2] << 8) | bytes[i + j * 4 + 3];
      }
      for (let j = 16; j < 80; j++) w[j] = this._rotl(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let j = 0; j < 80; j++) {
        let f, k;
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const tmp = (this._rotl(a, 5) + f + e + k + w[j]) | 0;
        e = d; d = c; c = this._rotl(b, 30); b = a; a = tmp;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, "0")).join("");
  },

  _psHeaders() {
    const nonce = this._randToken(6);
    const ts = String(Date.now());
    const xsrf = this._randHex(32);
    const finger = this._randHex(32);
    const sig = this._sha1([this._PS_SECRET, ts, nonce].sort().join(""));
    return {
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Content-Type": "application/json;charset=UTF-8",
      "Cookie": "XSRF-TOKEN=" + xsrf,
      "Origin": "https://pubscholar.cn",
      "Referer": "https://pubscholar.cn/explore",
      "nonce": nonce, "signature": sig, "timestamp": ts,
      "x-finger": finger, "x-xsrf-token": xsrf,
      _finger: finger,
    };
  },

  _stripHTML(t) {
    return String(t || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  },

  /**
   * PubScholar 搜索 → [{source, articleTitle, author, journal, year, volume, issue,
   * pages, doi, abstract, keywords, url, articleID}]（无结果返回 []）
   */
  async _searchPubScholar(title, author) {
    const queries = this._buildQueries(title, author);
    const target = author
      ? this._normalizeTitle(this._normalizeTitle(title).replace(new RegExp(this._escapeRe(author), "g"), " "))
      : this._normalizeTitle(title);
    const seen = new Set();
    const out = [];
    for (const q of queries) {
      for (const orderField of ["default", "year"]) {
        const headers = this._psHeaders();
        const body = JSON.stringify({
          page: 1, size: 20, order_field: orderField, order_direction: "desc",
          user_id: headers._finger, lang: "zh", query: q,
        });
        delete headers._finger;
        let data;
        try {
          const resp = await Zotero.HTTP.request("POST", this._PS_URL, {
            body, headers, timeout: 10000,
          });
          data = JSON.parse(resp.responseText);
        } catch (e) {
          this._diag("pubscholar request failed: " + (e && e.message));
          continue;
        }
        if (data.error || !data.content) continue;
        for (const a of data.content) {
          const articleTitle = this._stripHTML(a.title);
          if (!articleTitle) continue;
          const key = a.id || (articleTitle + "|" + (a.author || []).join(","));
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            source: "PubScholar",
            articleTitle,
            author: (a.author || []).join(","),
            creators: a.author || [],
            journal: String(a.source || "").trim(),
            year: String(a.year || a.date || ""),
            volume: String(a.volume || "").trim(),
            issue: String(a.issue || "").trim(),
            pages: [a.first_page, a.last_page].filter((x) => x && String(x).trim()).map((x) => String(x).trim()).join("-"),
            doi: String(a.doi || "").trim(),
            abstract: this._stripHTML(a.abstracts),
            keywords: a.keywords || [],
            url: (a.links || []).find((l) => l && l.url)?.url || "",
            articleID: String(a.id || ""),
            itemType: a.article_type === "学位论文" ? "thesis"
              : a.article_type === "会议论文" ? "conferencePaper"
              : a.article_type === "图书" ? "book"
              : a.article_type === "报纸文章" ? "newspaperArticle" : "journalArticle",
          });
        }
        // 早期命中：已找到目标标题则提前返回，避免打满 4 查询 × 2 排序
        if (target && out.some((r) => this._isTitleMatch(r.articleTitle, target))) return out;
      }
    }
    return out;
  },

  // ================= CNKI 源 =================

  /** 表单编码：嵌套对象 JSON.stringify（与 jasminum jsonToFormUrlEncoded 同行为） */
  _formEncode(obj) {
    return Object.keys(obj).map((k) => {
      let v = obj[k];
      if (v && typeof v === "object") v = JSON.stringify(v);
      return encodeURIComponent(k) + "=" + encodeURIComponent(String(v));
    }).join("&");
  },

  /**
   * CNKI 搜索 → {results:[...]} 正常 / {captcha:url}（403 滑块）/
   * {maybeBlocked:true}（200 但 no-content 软拦或真空结果，需探测区分）
   * 结果字段：articleTitle/author/journal/date/citation/url/exportID/dbname/filename
   */
  async _searchCNKI(title, author) {
    const searchExp = "TI %= '" + String(title).replace(/'/g, "") + "'" +
      (author ? " AND AU='" + String(author).replace(/'/g, "") + "'" : "");
    const aside = searchExp.replace(/'/g, "&#39;");
    const post = {
      boolSearch: "true",
      QueryJson: {
        Platform: "", Resource: "CROSSDB", Classid: "WD0FTY92", Products: "",
        QNode: { QGroup: [
          { Key: "Subject", Title: "", Logic: 0,
            Items: [{ Key: "Expert", Title: "", Logic: 0, Field: "EXPERT",
                      Operator: 0, Value: searchExp, Value2: "" }], ChildItems: [] },
          { Key: "ControlGroup", Title: "", Logic: 0, Items: [], ChildItems: [] },
        ] },
        ExScope: "1", SearchType: 4, Rlang: "CHINESE",
        KuaKuCode: "YSTT4HG0,LSTPFY1C,JUP3MUPD,MPMFIG1A,WQ0UVIAA,BLZOG7CK,PWFIRAGL,EMRPGLPA,NLBO1Z6R,NN3FJMUV",
        SearchFrom: 1,
      },
      pageNum: "1", pageSize: "20", sortField: "", sortType: "", dstyle: "listmode",
      productStr: "YSTT4HG0,LSTPFY1C,RMJLXHZ3,JQIRZIYA,JUP3MUPD,1UR4K4HZ,BPBAFJ5S,R79MZMCB,MPMFIG1A,WQ0UVIAA,NB3BWEHK,XVLO76FD,HR1YT1Z9,BLZOG7CK,PWFIRAGL,EMRPGLPA,J708GVCE,ML4DRIDX,NLBO1Z6R,NN3FJMUV,",
      aside: "(" + aside + ")",
      searchFrom: "资源范围：总库;++中英文扩展;++时间范围：更新时间：不限;++",
      CurPage: "1",
    };
    const headers = {
      "Accept": "*/*",
      "Accept-Language": "zh-CN,en-US;q=0.9,en;q=0.8",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Origin": "https://kns.cnki.net",
      "Referer": "https://kns.cnki.net/kns8s/defaultresult/index?kw=",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
    };
    let resp;
    try {
      resp = await Zotero.HTTP.request("POST", "https://kns.cnki.net/kns8s/brief/grid", {
        body: this._formEncode(post), headers, timeout: 10000, successCodes: [200, 403],
      });
    } catch (e) {
      this._diag("cnki request failed: " + (e && e.message));
      return { results: [] };
    }
    if (resp.status === 403) {
      let captcha = "";
      try { captcha = JSON.parse(resp.responseText).message || ""; } catch (e) { /* ignore */ }
      this._diag("cnki captcha: " + captcha);
      return { results: [], captcha };
    }
    const doc = new DOMParser().parseFromString(resp.responseText, "text/html");
    const rows = doc.querySelectorAll("table.result-table-list > tbody > tr");
    // 软拦截特征：200 但 briefBox 里只有 no-content（"抱歉，暂无数据"）。
    // 与真空结果同构，调用方需用 CNVerify.probe() 热词探测区分。
    if (!rows.length && resp.responseText.includes("no-content")) {
      this._diag("cnki no-content (soft block or genuine empty)");
      return { results: [], maybeBlocked: true };
    }
    const results = [];
    for (const r of rows) {
      const txt = (sel) => { const el = r.querySelector(sel); return el ? el.textContent.trim() : ""; };
      const attr = (sel, name) => { const el = r.querySelector(sel); return el ? (el.getAttribute(name) || "") : ""; };
      let url = attr("a.fz14", "href");
      if (url && !url.startsWith("http")) url = "https://chn.oversea.cnki.net" + url;
      const articleTitle = txt("td.name a");
      if (!articleTitle) continue;
      results.push({
        source: "CNKI",
        articleTitle,
        author: txt("td.author").replace(/\s+/g, ",").replace(/^,|,$/g, ""),
        creators: txt("td.author").split(/[,;；\s]+/).filter(Boolean),
        journal: txt("td.source"),
        year: (txt("td.date").match(/\d{4}/) || [""])[0],
        date: txt("td.date"),
        citation: txt("td.quote"),
        url,
        exportID: attr("td.seq input", "value"),
        dbname: attr("td.operat > [data-dbname]", "data-dbname"),
        filename: attr("td.operat > [data-dbname]", "data-filename"),
        itemType: "journalArticle",
      });
    }
    return { results };
  },

  // ================= 选择器 =================

  /** 从结果集中挑一条：完全命中自动选；否则弹列表让用户选（返回 null=取消） */
  _pickResult(results, targetTitle) {
    const exact = results.filter((r) => this._isTitleMatch(r.articleTitle, targetTitle));
    if (exact.length === 1) return exact[0];
    if (!results.length) return null;
    const win = Zotero.getMainWindow();
    if (!win) return null;
    // 候选排序：精确命中优先，其次按标题长度接近度
    const cand = (exact.length ? exact : results).slice(0, 10);
    const io = { dataIn: null, dataOut: null };
    const items = cand.map((r) =>
      "【" + r.source + "】" + r.articleTitle +
      (r.author ? " — " + String(r.author).split(",")[0] : "") +
      (r.journal ? " · " + r.journal : "") + (r.year ? " " + r.year : ""));
    const ps = Services.prompt;
    const sel = {};
    const ok = ps.select(win, "PaperPilot · " + (I18n.isZh ? "选择匹配的文献" : "Select match"),
      I18n.isZh
        ? "找到 " + results.length + " 条候选，请选择最匹配的一条（取消则跳过该条目）："
        : "Found " + results.length + " candidates, pick the best match (Cancel skips this item):",
      items.length, items, sel);
    if (!ok || sel.value == null || sel.value < 0) return null;
    return cand[sel.value];
  },

  // ================= 回填 =================

  /** 仅当字段对该条目类型有效时写入，避免 thesis 等类型缺字段抛错 */
  _setField(item, name, value) {
    if (!value) return false;
    try {
      if (Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, name)) {
        item.setField(name, value);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  },

  /** 条目元数据是否不完整（标题=文件名 或 缺作者/期刊） */
  _isIncomplete(item) {
    let title = "";
    try { title = (item.getField("title") || "").trim(); } catch (e) { return false; }
    if (/\.(pdf|caj|kdh|nh|teb)$/i.test(title)) return true;
    try { if (!item.getCreators().length) return true; } catch (e) { /* ignore */ }
    try {
      if (item.itemType === "journalArticle" && !item.getField("publicationTitle")) return true;
    } catch (e) { /* ignore */ }
    return false;
  },

  /**
   * 用抓取结果回填条目。upgradeTitle=true 时（标题仍是文件名）允许覆盖标题。
   * 返回填充的字段名列表。
   */
  _enrichItem(item, r, upgradeTitle) {
    const filled = [];
    const fill = (name, value, force) => {
      let cur = "";
      try { cur = String(item.getField(name) || "").trim(); } catch (e) { cur = ""; }
      if (!force && cur) return;
      if (this._setField(item, name, value)) filled.push(name);
    };
    if (upgradeTitle) fill("title", r.articleTitle, true);
    // 作者：当前无作者才写
    try {
      if (!item.getCreators().length && r.creators && r.creators.length) {
        item.setCreators(r.creators.map((n) => ({
          lastName: n, fieldMode: 1, creatorType: "author",
        })));
        filled.push("creators");
      }
    } catch (e) { /* ignore */ }
    fill("publicationTitle", r.journal);
    fill("volume", r.volume);
    fill("issue", r.issue);
    fill("pages", r.pages);
    fill("date", r.year || r.date || "");
    fill("DOI", r.doi);
    fill("abstractNote", r.abstract);
    fill("url", r.url);
    // 关键词 → 标签（不删已有标签）
    try {
      if (r.keywords && r.keywords.length) {
        const existing = new Set(item.getTags().map((t) => t.tag));
        let added = 0;
        for (const kw of r.keywords) {
          if (kw && !existing.has(kw)) { item.addTag(kw, 1); added++; }
        }
        if (added) filled.push("tags");
      }
    } catch (e) { /* ignore */ }
    return filled;
  },

  /** 取条目的搜索标题：标题=文件名时用 CNMeta 解析文件名，否则用标题 */
  _searchTitleFor(item) {
    let title = "";
    try { title = (item.getField("title") || "").trim(); } catch (e) { /* ignore */ }
    if (/\.(pdf|caj|kdh|nh|teb)$/i.test(title)) {
      const parsed = CNMeta.parseFilename(title);
      if (parsed.title) return { title: parsed.title, author: (parsed.creators || [])[0] || "" };
    }
    // 附件文件名兜底（标题已是正常标题但可能仍是文件名主体）
    return { title: title.replace(/\.(pdf|caj|kdh|nh|teb)$/i, ""), author: "" };
  },

  /** CNKI 会话预热：GET 首页拿 SID cookie（Zotero.HTTP 与标签页共享 profile cookie 罐） */
  async _seedCNKI() {
    if (this._cnkiSeeded) return;
    this._cnkiSeeded = true;
    try {
      await Zotero.HTTP.request("GET", "https://kns.cnki.net/kns8s/", { timeout: 8000 });
      this._diag("cnki session seeded");
    } catch (e) {
      this._diag("cnki seed failed: " + (e && e.message));
    }
  },

  /** 单条目抓取流程；返回 {status, detail} */
  async _fetchForItem(item, opts) {
    // 附件上溯父条目
    if (item.isAttachment && item.isAttachment()) {
      const p = item.parentItemID ? Zotero.Items.get(item.parentItemID) : null;
      if (p) item = p;
    }
    if (item.isNote && item.isNote()) return { status: "skip", detail: "note" };
    if (!this._isIncomplete(item) && !opts.force) return { status: "skip", detail: "complete" };

    const { title, author } = this._searchTitleFor(item);
    if (!title || title.length < 4) return { status: "skip", detail: "no-title" };

    // 搜索链：PubScholar → CNKI（可关；被风控时整批短路，避免反复触发）
    let results = [];
    try { results = await this._searchPubScholar(title, author); } catch (e) {
      this._diag("pubscholar chain error: " + (e && e.message));
    }
    let captcha = "";
    const exactHit = results.some((r) => this._isTitleMatch(r.articleTitle, title));
    if (!exactHit && Prefs.get("cnFetchUseCNKI", true) && !this._batchBlocked) {
      await this._seedCNKI();
      const r2 = await this._searchCNKI(title, author);
      if (r2.captcha) {
        captcha = r2.captcha;
        this._batchBlocked = true;
      } else if (r2.maybeBlocked) {
        // no-content 软拦 vs 真空结果：热词探测一次定真伪（每批至多一次）
        const ok = await CNVerify.probe();
        if (!ok) {
          captcha = "soft-block";
          this._batchBlocked = true;
          this._diag("cnki soft-blocked confirmed by probe");
        }
      }
      if (!this._batchBlocked && r2.results.length) {
        const seen = new Set(results.map((r) => this._compact(r.articleTitle)));
        for (const r of r2.results) {
          if (!seen.has(this._compact(r.articleTitle))) results.push(r);
        }
      }
    }
    if (!results.length) {
      return { status: "empty", detail: captcha ? "captcha" : "no-result", captcha };
    }

    const upgradeTitle = /\.(pdf|caj|kdh|nh|teb)$/i.test((item.getField("title") || "").trim());
    let pick = this._pickResult(results, title);
    if (!pick) return { status: "skip", detail: "user-cancel" };

    // 类型不一致（如 thesis vs journalArticle）且字段差异大时，先尽量字段级回填
    const filled = this._enrichItem(item, pick, upgradeTitle);
    if (!filled.length) return { status: "skip", detail: "nothing-new" };
    await item.saveTx();
    return { status: "ok", detail: filled.join(","), source: pick.source, captcha };
  },

  /** 菜单入口：抓取所选条目 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const raw = zp.getSelectedItems() || [];
    const items = ItemSel.regularOnly(raw);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const zh = I18n.isZh;
    this._batchBlocked = false; // 批次级风控状态（软拦/滑块确认后整批短路 CNKI）
    this._cnkiSeeded = false;
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + (zh ? "抓取中文元数据" : "Fetch CN metadata"));
    pw.show();
    let nOk = 0, nSkip = 0, nEmpty = 0;
    let blockedHit = false;
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const r = await this._fetchForItem(item, { force: false });
        progress.setProgress(100);
        if (r.status === "ok") {
          nOk++;
          progress.setText((zh ? "已回填（" : "Filled (") + (r.source || "") + "）");
        } else if (r.status === "empty") {
          nEmpty++;
          if (r.captcha) blockedHit = true;
          progress.setText(r.captcha
            ? (zh ? "知网触发安全验证" : "CNKI verification required")
            : (zh ? "未找到匹配" : "No match found"));
        } else {
          nSkip++;
          const map = { complete: zh ? "跳过（元数据已完整）" : "Skipped (complete)",
            "user-cancel": zh ? "已取消" : "Cancelled",
            "nothing-new": zh ? "无新字段可补" : "Nothing new",
            "no-title": zh ? "无可用标题" : "No usable title" };
          progress.setText(map[r.detail] || (zh ? "跳过" : "Skipped"));
        }
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    const summary = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (zh ? "合计：回填 " : "Done: filled ") + nOk +
      (zh ? "，未找到 " : ", not found ") + nEmpty +
      (zh ? "，跳过 " : ", skipped ") + nSkip);
    summary.setProgress(100);
    pw.startCloseTimer(5000);

    // 知网被风控（滑块/软拦）→ 引导在内置标签页过验证，通过后自动续抓本批
    if (blockedHit) {
      const win = Zotero.getMainWindow();
      const go = Services.prompt.confirm(win,
        "PaperPilot · " + (zh ? "知网验证" : "CNKI verification"),
        zh
          ? "知网触发了安全验证（滑块/风控拦截）。\n是否现在打开知网页面完成验证？验证通过后会自动继续本次抓取。"
          : "CNKI is blocking requests (slider/risk control). Open the CNKI page to verify? Fetching will resume automatically afterwards.");
      if (go) {
        CNVerify.openAndWait(() => this.runForSelected());
      }
    }
  },

  // ================= 下载文件夹附件匹配 =================

  /** 系统下载目录（可被 pref cnDownloadDir 覆盖） */
  _downloadsDir() {
    const custom = Prefs.get("cnDownloadDir", "");
    if (custom) return custom;
    try {
      const d = Services.dirsvc.get("DfltDwnld", Components.interfaces.nsIFile);
      return d.path;
    } catch (e) {
      return PathUtils.join(PathUtils.homeDir, "Downloads");
    }
  },

  /** 文件名与标题的匹配度（0-1）：标题压缩串被文件名包含 → 高匹配 */
  _matchScore(title, filename) {
    const t = this._compact(title);
    const f = this._compact(String(filename).replace(/\.(pdf|caj|kdh|nh|teb)$/i, ""));
    if (!t || !f) return 0;
    if (f === t) return 1;
    if (f.includes(t)) return 0.95;
    if (t.includes(f) && f.length >= 8) return 0.9;
    // 部分匹配：文件名是标题前缀/包含标题前 12 字
    if (t.length >= 12 && f.includes(t.slice(0, 12))) return 0.75;
    return 0;
  },

  /** 菜单入口：为无 PDF 的所选条目在下载文件夹中查找附件 */
  async matchAttachmentsFromDownloads() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    const zh = I18n.isZh;
    const dir = this._downloadsDir();

    let files = [];
    try {
      const children = await IOUtils.getChildren(dir);
      for (const p of children) {
        const name = PathUtils.filename(p);
        if (/\.(pdf|caj|kdh|nh)$/i.test(name) && /[一-龥]/.test(name)) files.push(p);
      }
    } catch (e) {
      Zotero.alert(null, "PaperPilot", (zh ? "无法读取下载目录：" : "Cannot read downloads dir: ") + dir);
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + (zh ? "下载文件夹匹配附件" : "Match attachments"));
    pw.show();
    let nOk = 0, nNone = 0, nHas = 0;
    for (const item of items) {
      const title = (item.getDisplayTitle() || "").slice(0, 30);
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        // 已有 PDF 附件 → 跳过
        let hasPDF = false;
        for (const id of item.getAttachments()) {
          const a = Zotero.Items.get(id);
          if (a && a.isPDFAttachment && a.isPDFAttachment()) { hasPDF = true; break; }
        }
        if (hasPDF) { nHas++; progress.setText(zh ? "已有 PDF 附件" : "Already has PDF"); progress.setProgress(100); continue; }
        const itemTitle = item.getField("title") || "";
        let best = null, bestScore = 0;
        for (const p of files) {
          const s = this._matchScore(itemTitle, PathUtils.filename(p));
          if (s > bestScore) { bestScore = s; best = p; }
        }
        if (best && bestScore >= 0.75) {
          await Zotero.Attachments.importFromFile({ file: best, parentItemID: item.id, libraryID: item.libraryID });
          nOk++;
          progress.setText((zh ? "已关联：" : "Attached: ") + PathUtils.filename(best));
        } else {
          nNone++;
          progress.setText(zh ? "下载文件夹中无匹配" : "No match in downloads");
        }
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    const summary = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (zh ? "合计：关联 " : "Attached ") + nOk +
      (zh ? "，无匹配 " : ", none ") + nNone +
      (zh ? "，已有附件 " : ", had PDF ") + nHas);
    summary.setProgress(100);
    pw.startCloseTimer(4000);
  },

  // ================= 中文姓名小工具 =================

  /** 合并中文姓名（two-field → 单字段）；茉莉花「小工具」同款 */
  mergeNames() { this._nameMode("merge"); },

  /** 拆分中文姓名（单字段 → 姓+名 two-field） */
  splitNames() { this._nameMode("split"); },

  _nameMode(mode) {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    const zh = I18n.isZh;
    let n = 0;
    for (const item of items) {
      try {
        const creators = item.getCreators();
        let changed = false;
        const next = creators.map((c, i) => {
          if (mode === "merge") {
            // 中文名（无空格）且分了两栏 → 合并
            if (c.fieldMode !== 1 && c.lastName && /^[一-龥]+$/.test(String(c.firstName || ""))) {
              changed = true;
              return { creatorType: c.creatorType || "author", fieldMode: 1,
                lastName: String(c.lastName) + String(c.firstName || "") };
            }
          } else {
            // 单字段中文名 ≥2 字 → 姓 1 字（复姓 2 字）+ 名
            if (c.fieldMode === 1 && /^[一-龥·]{2,4}$/.test(c.lastName)) {
              const name = String(c.lastName);
              const compound = ["欧阳", "太史", "端木", "上官", "司马", "东方", "独孤", "南宫", "万俟", "闻人", "夏侯", "诸葛", "尉迟", "公羊", "赫连", "澹台", "皇甫", "宗政", "濮阳", "公冶", "太叔", "申屠", "公孙", "慕容", "仲孙", "钟离", "长孙", "宇文", "司徒", "鲜于", "司空", "闾丘", "子车", "亓官", "司寇", "巫马", "公西", "颛孙", "壤驷", "公良", "漆雕", "乐正", "宰父", "谷梁", "拓跋", "夹谷", "轩辕", "令狐", "段干", "百里", "呼延", "东郭", "南门", "羊舌", "微生", "公户", "公玉", "公仪", "梁丘", "公仲", "公上", "公门", "公山", "公坚", "左丘", "公伯", "西门", "公祖", "第五", "公乘", "贯丘", "公皙", "南荣", "东里", "东宫", "仲长", "子书", "子桑", "即墨", "达奚", "褚师"];
              const sur2 = name.slice(0, 2);
              const isCompound = compound.includes(sur2);
              changed = true;
              return { creatorType: c.creatorType || "author", fieldMode: 0,
                lastName: isCompound ? sur2 : name.slice(0, 1),
                firstName: isCompound ? name.slice(2) : name.slice(1) };
            }
          }
          return c;
        });
        if (changed) {
          // getCreators 返回含 id 的对象，直接 setCreators 全量替换
          item.setCreators(next.map((c) => ({
            creatorType: c.creatorType || "author",
            fieldMode: c.fieldMode === 1 ? 1 : 0,
            lastName: c.lastName || "",
            firstName: c.firstName || "",
          })));
          item.saveTx();
          n++;
        }
      } catch (e) { Zotero.logError(e); }
    }
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot");
    pw.show();
    const line = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (mode === "merge" ? (zh ? "已合并姓名：" : "Merged: ") : (zh ? "已拆分姓名：" : "Split: ")) +
      n + (zh ? " 条" : " item(s)"));
    line.setProgress(100);
    pw.startCloseTimer(2500);
  },
};

/* ==================== 知网验证（0.14.8，茉莉花 passCaptchaToCookieBox 同等能力） ====================
 * 知网风控两种形态：403 滑块 JSON；200 但 no-content 软拦（"抱歉，暂无数据"）。
 * 解除唯一途径：在真实浏览器里过一次安全验证——Zotero 标签页与 Zotero.HTTP 共享
 * profile cookie 罐，标签页里过验证后 XHR 即恢复。
 * 本模块：热词探测（区分软拦/真空结果）→ 开验证页 → 轮询等待 → 通过回调（自动续抓）。
 */
var CNVerify = {
  VERIFY_URL: "https://kns.cnki.net/",
  _waiting: false,

  _diag(msg) {
    try { _ppDiag("cn-verify: " + msg); } catch (e) { /* ignore */ }
  },

  /** 探测知网当前是否可用：固定热词搜索，能出结果 = 未被风控 */
  async probe() {
    try {
      const r = await CNFetch._searchCNKI("高血压", "");
      const ok = !r.maybeBlocked && !r.captcha && r.results.length > 0;
      this._diag("probe: " + (ok ? "ok" : "blocked"));
      return ok;
    } catch (e) {
      this._diag("probe error: " + (e && e.message));
      return false;
    }
  },

  /**
   * 打开知网验证页并轮询等待通过（最长 5 分钟）。
   * onPass 在通过后回调（如自动续抓）；onGiveup 超时/异常时回调。
   */
  async openAndWait(onPass, onGiveup) {
    if (this._waiting) return;
    this._waiting = true;
    const zh = I18n.isZh;
    try {
      try { Zotero.getActiveZoteroPane().loadURI(this.VERIFY_URL); }
      catch (e) { try { Zotero.launchURL(this.VERIFY_URL); } catch (e2) { /* ignore */ } }
      const pw = new Zotero.ProgressWindow({ closeOnClick: false });
      pw.changeHeadline("PaperPilot · " + (zh ? "知网验证" : "CNKI verification"));
      const line = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
        zh ? "已打开知网页面：请在页面中完成滑块/安全验证，通过后自动继续（最长等 5 分钟）…"
           : "CNKI page opened — complete the slider verification there (wait up to 5 min)…");
      pw.show();
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((ok) => setTimeout(ok, 3000));
        if (await this.probe()) {
          line.setText(zh ? "✓ 验证已通过，知网恢复访问" : "✓ Verification passed");
          line.setProgress(100);
          pw.startCloseTimer(2500);
          this._waiting = false;
          if (onPass) {
            try { onPass(); } catch (e) { Zotero.logError(e); }
          }
          return;
        }
      }
      line.setError();
      line.setText(zh ? "等待超时——可稍后从工具菜单重新发起「知网验证」"
                      : "Timed out — retry from the Tools menu later");
      pw.startCloseTimer(4000);
    } catch (e) {
      Zotero.logError(e);
    }
    this._waiting = false;
    if (onGiveup) {
      try { onGiveup(); } catch (e) { Zotero.logError(e); }
    }
  },

  /** 菜单入口：主动发起验证（先探测，未被拦则提示无需验证） */
  async interactive() {
    const zh = I18n.isZh;
    if (await this.probe()) {
      Zotero.alert(null, "PaperPilot",
        zh ? "知网访问正常，无需验证。" : "CNKI is accessible — no verification needed.");
      return;
    }
    await this.openAndWait(() => {
      try {
        Zotero.alert(null, "PaperPilot",
          zh ? "✓ 知网验证已通过，可以重新抓取了。" : "✓ CNKI verification passed — fetch again now.");
      } catch (e) { /* ignore */ }
    });
  },
};
