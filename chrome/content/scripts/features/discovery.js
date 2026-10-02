/* PaperPilot 文献发现 · arXiv 每日推荐（0.24.0，功能借鉴 zotero-arxiv-daily）
 *
 * 解决的问题：PaperPilot 一直是「你已经知道要读什么」的工具。科研信息流需要
 * 反向能力——**从库里已有的兴趣出发，告诉你今天 arXiv 上有什么新东西值得看**。
 *
 * 路线（不引入向量库 / 不做外部服务，全部本地可算）：
 *   1) 兴趣画像：扫描库内条目 → 标题(×3)/标签(×3)/期刊(×2)/摘要(×1) 的词元频次
 *      加权；剔除「出现在过多条目里」的泛词；取 Top-N 作为画像词元；
 *      另从 extra/url/archiveID 里抽出 arXiv 分类（cs.CL 这类）作为偏好
 *   2) 拉取：arXiv Atom API 按分类（或按画像词元）拉最近提交，max_results 可配
 *   3) 打分：条目 标题词元命中 ×3 + 摘要命中 ×1，按画像权重累加；分类命中加成；
 *      新近度小加成（越新越高，7 天衰减）
 *   4) 去重：按 arXiv id / DOI / 归一化标题排除**已在库**的；按 id 排除用户已忽略的
 *   5) 缓存：按天写入 pref（discoveryResults），对话框直接读缓存，绝不每次开窗都请求
 *
 * 依赖纪律：全部网络只在「用户点刷新」或「每日定时（开关默认关）」时发生；
 * 解析用自写 Atom 正则解析器（arXiv 输出格式稳定），可在 Node 里离线单测。
 */
/* global Zotero, Services, Prefs, I18n */

var Discovery = {
  ARXIV_API: "https://export.arxiv.org/api/query",

  /* ---------------- 分词与画像（纯函数，可离线单测） ---------------- */

  /** 分词：英文单词 + 中文 bigram（复用 LibSearch 的实现，保持单一真源） */
  tokenize(text) {
    if (typeof LibSearch !== "undefined" && LibSearch && LibSearch.tokenize) {
      return LibSearch.tokenize(text);
    }
    // 兜底（LibSearch 未加载时的最小实现，行为与之一致）
    const s = String(text || "").toLowerCase();
    const out = [];
    for (const m of s.match(/[a-z][a-z0-9\-_.]{1,}/g) || []) if (m.length >= 2) out.push(m);
    for (const run of s.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
      if (run.length <= 4) out.push(run);
      for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    }
    return [...new Set(out)];
  },

  /** 条目 → arXiv 分类 / arXiv id 抽取（扫 extra、url、archiveID、repository） */
  extractArxiv(item) {
    let blob = "";
    for (const f of ["extra", "url", "archiveID", "archiveLocation", "repository", "DOI"]) {
      try { blob += " " + String(item.getField(f) || ""); } catch (e) { /* ignore */ }
    }
    const idm = blob.match(/arxiv[:\s/]*(\d{4}\.\d{4,5})(v\d+)?/i);
    const cats = [];
    for (const m of blob.match(/\b([a-z]{2,}(?:-[a-z]{2,})?\.[A-Z]{2})\b/g) || []) cats.push(m);
    return { arxivId: idm ? idm[1] : "", categories: [...new Set(cats)] };
  },

  /**
   * 构建兴趣画像
   * @param {Array} items Zotero 条目
   * @param {{topTerms?:number, maxDocFreq?:number}} opts
   * @returns {{terms:Array<{term:string,weight:number}>, categories:Array<string>, scanned:number}}
   */
  buildProfile(items, opts) {
    const o = opts || {};
    const topTerms = o.topTerms || 40;
    const docs = [];
    const catCount = new Map();
    for (const it of items || []) {
      const g = (f) => { try { return String(it.getField(f) || ""); } catch (e) { return ""; } };
      let tags = "";
      try { tags = (it.getTags() || []).map((t) => t.tag).join(" "); } catch (e) { tags = ""; }
      const title = g("title");
      const abstract = g("abstractNote");
      const journal = g("publicationTitle") || g("bookTitle") || g("proceedingsTitle") || "";
      const bag = new Map();
      const add = (text, w) => { for (const t of this.tokenize(text)) bag.set(t, (bag.get(t) || 0) + w); };
      add(title, 3); add(tags, 3); add(journal, 2); add(abstract, 1);
      if (!bag.size) continue;
      docs.push(bag);
      const ax = this.extractArxiv(it);
      for (const c of ax.categories) catCount.set(c, (catCount.get(c) || 0) + 1);
    }
    const df = new Map();
    const total = new Map();
    for (const bag of docs) {
      for (const [t, w] of bag) {
        df.set(t, (df.get(t) || 0) + 1);
        total.set(t, (total.get(t) || 0) + w);
      }
    }
    // 泛词过滤：出现于超过 maxDocFreq 比例的文档 → 去掉（这些词无区分度）。
    // 下限取 3 而非 2：小库（新用户常见）里「出现在 2 篇」的词往往是真兴趣，
    // 用 2 当阈值会把画像清空 → 看起来功能「没效果」。
    const maxRatio = o.maxDocFreq || 0.4;
    const floor = Math.max(3, Math.ceil(docs.length * maxRatio));
    const terms = [...total.entries()]
      .filter(([t]) => (df.get(t) || 0) < floor && t.length >= 3)
      .map(([term, weight]) => ({ term, weight: Math.round(weight * 100) / 100 }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, topTerms);
    const categories = [...catCount.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]).slice(0, 8);
    return { terms, categories, scanned: docs.length };
  },

  /* ---------------- arXiv Atom 解析（纯函数） ---------------- */

  _decode(s) {
    return String(s == null ? "" : s)
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
      .replace(/&amp;/g, "&");
  },

  _clean(s) {
    return this._decode(String(s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  },

  _tag(block, name) {
    const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">", "i"));
    return m ? m[1] : "";
  },

  /** arXiv Atom XML → 结构化条目数组（纯函数） */
  parseAtom(xml) {
    const out = [];
    const src = String(xml || "");
    const blocks = src.split(/<entry[\s>]/i).slice(1);
    for (const raw of blocks) {
      const b = raw.split(/<\/entry>/i)[0];
      const idUrl = this._clean(this._tag(b, "id"));
      const idm = idUrl.match(/(\d{4}\.\d{4,5})(v\d+)?/);
      const authors = [];
      for (const m of b.match(/<author>[\s\S]*?<\/author>/gi) || []) {
        const n = this._clean(this._tag(m, "name"));
        if (n) authors.push(n);
      }
      const cats = [];
      for (const m of b.match(/<category[^>]*term="([^"]+)"/gi) || []) {
        const t = (m.match(/term="([^"]+)"/) || [])[1];
        if (t) cats.push(t);
      }
      const primary = (b.match(/<arxiv:primary_category[^>]*term="([^"]+)"/i) || [])[1] || cats[0] || "";
      const links = {};
      for (const m of b.match(/<link[^>]*\/>/gi) || []) {
        const href = (m.match(/href="([^"]+)"/) || [])[1] || "";
        const rel = (m.match(/rel="([^"]+)"/) || [])[1] || "";
        const type = (m.match(/type="([^"]+)"/) || [])[1] || "";
        const title = (m.match(/title="([^"]+)"/) || [])[1] || "";
        if (type === "application/pdf" || title === "pdf") links.pdf = href;
        if (rel === "alternate") links.abs = href;
      }
      const entry = {
        arxivId: idm ? idm[1] : "",
        version: idm && idm[2] ? idm[2] : "",
        title: this._clean(this._tag(b, "title")),
        summary: this._clean(this._tag(b, "summary")),
        authors,
        published: this._clean(this._tag(b, "published")),
        updated: this._clean(this._tag(b, "updated")),
        categories: [...new Set(cats)],
        primary,
        link: links.abs || idUrl,
        pdfLink: links.pdf || (idm ? "https://arxiv.org/pdf/" + idm[1] : ""),
        doi: this._clean(this._tag(b, "arxiv:doi")),
        journalRef: this._clean(this._tag(b, "arxiv:journal_ref")),
        comment: this._clean(this._tag(b, "arxiv:comment")),
      };
      if (entry.arxivId && entry.title) out.push(entry);
    }
    return out;
  },

  /* ---------------- 打分与去重（纯函数） ---------------- */

  /** 标题归一化（用于「是否已在库」判定） */
  normTitle(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "").slice(0, 120);
  },

  /** 已在库的标识集合：{ids:Set, dois:Set, titles:Set} */
  knownIndex(items) {
    const ids = new Set(), dois = new Set(), titles = new Set();
    for (const it of items || []) {
      const g = (f) => { try { return String(it.getField(f) || ""); } catch (e) { return ""; } };
      const ax = this.extractArxiv(it);
      if (ax.arxivId) ids.add(ax.arxivId);
      const doi = g("DOI").trim().toLowerCase();
      if (doi) dois.add(doi);
      const t = this.normTitle(g("title"));
      if (t && t.length > 12) titles.add(t);
    }
    return { ids, dois, titles };
  },

  isKnown(entry, known) {
    if (!known) return false;
    if (entry.arxivId && known.ids.has(entry.arxivId)) return true;
    if (entry.doi && known.dois.has(String(entry.doi).trim().toLowerCase())) return true;
    const t = this.normTitle(entry.title);
    return !!(t && t.length > 12 && known.titles.has(t));
  },

  /**
   * 打分：画像词元命中（标题 ×3 / 摘要 ×1）+ 分类加成 + 新近度加成
   * @returns {{score:number, reasons:string[]}}
   */
  scoreEntry(entry, profile, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const tw = new Map();
    for (const t of this.tokenize(entry.title)) tw.set(t, (tw.get(t) || 0) + 1);
    const sw = new Map();
    for (const t of this.tokenize(entry.summary)) sw.set(t, (sw.get(t) || 0) + 1);
    let score = 0;
    const reasons = [];
    for (const { term, weight } of profile.terms || []) {
      let hit = 0;
      if (tw.has(term)) hit += 3 * Math.min(2, tw.get(term));
      if (sw.has(term)) hit += 1 * Math.min(3, sw.get(term));
      if (hit) { score += weight * hit; if (reasons.length < 6) reasons.push(term); }
    }
    const prefCats = new Set(o.categories || []);
    let catHit = "";
    for (const c of entry.categories || []) {
      if (prefCats.has(c) || (profile.categories || []).includes(c)) { catHit = c; break; }
    }
    if (catHit) { score += 4; reasons.push(catHit); }
    // 新近度：7 天内线性 6→0 的加成（鼓励看新提交）
    let dayBoost = 0;
    try {
      const days = (now - new Date(entry.published).getTime()) / 86400000;
      if (isFinite(days) && days >= 0) dayBoost = Math.max(0, 6 * (1 - days / 7));
    } catch (e) { dayBoost = 0; }
    score += dayBoost;
    return { score: Math.round(score * 100) / 100, reasons: [...new Set(reasons)] };
  },

  /** 排序 + 去重 + 截断（纯函数）：输入原始条目与画像，输出推荐数组 */
  rank(entries, profile, opts) {
    const o = opts || {};
    const seen = new Set();
    const scored = [];
    for (const e of entries || []) {
      if (!e.arxivId || seen.has(e.arxivId)) continue;
      if (o.known && this.isKnown(e, o.known)) continue;
      if (o.ignored && o.ignored.has(e.arxivId)) continue;
      seen.add(e.arxivId);
      const s = this.scoreEntry(e, profile, { categories: o.categories, now: o.now });
      if (s.score <= 0 && !o.keepZero) continue;
      scored.push(Object.assign({}, e, { score: s.score, reasons: s.reasons }));
    }
    scored.sort((a, b) => b.score - a.score || String(b.published).localeCompare(String(a.published)));
    return scored.slice(0, o.max || 30);
  },

  /* ---------------- 网络与存储 ---------------- */

  /** 构建 arXiv 查询串：优先分类，无分类则用画像词元 */
  buildQuery(profile, opts) {
    const o = opts || {};
    const cats = (o.categories || []).filter(Boolean).slice(0, 4);
    if (cats.length) {
      return cats.map((c) => "cat:" + c).join("+OR+");
    }
    const terms = (profile.terms || []).slice(0, 6).map((t) => t.term.replace(/["\\]/g, ""));
    if (!terms.length) return "";
    return terms.map((t) => 'all:"' + t + '"').join("+OR+");
  },

  async fetchFeed(query, maxResults) {
    const url = this.ARXIV_API + "?search_query=" + query +
      "&start=0&max_results=" + Math.max(1, Math.min(200, maxResults || 100)) +
      "&sortBy=submittedDate&sortOrder=descending";
    // 应用层超时（与 S2Client 同理：挂起的 XHR 会占满连接池，导致后续请求永不发出）
    const resp = await Promise.race([
      Zotero.HTTP.request("GET", url, { responseType: "text", timeout: 30000 }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("arXiv 请求超时（30s）")), 31000)),
    ]);
    return String(resp.responseText || resp.response || "");
  },

  /** 读取/写入缓存 */
  loadCache() {
    try {
      const raw = Prefs.get("discoveryResults", "");
      const d = raw ? JSON.parse(raw) : null;
      if (d && Array.isArray(d.items)) return d;
    } catch (e) { /* 脏数据回落 */ }
    return { generatedAt: "", items: [], profile: { terms: [], categories: [] }, scope: "" };
  },

  saveCache(data) {
    try { Prefs.set("discoveryResults", JSON.stringify(data)); } catch (e) { /* ignore */ }
  },

  ignoredSet() {
    try {
      const raw = Prefs.get("discoveryIgnored", "");
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) { return new Set(); }
  },

  /** 忽略某条推荐（持久化，重启后仍隐藏） */
  ignore(arxivId) {
    if (!arxivId) return;
    const set = this.ignoredSet();
    set.add(arxivId);
    try { Prefs.set("discoveryIgnored", JSON.stringify([...set].slice(-500))); } catch (e) { /* ignore */ }
  },

  /** 今天（本地）的 YYYY-MM-DD */
  _today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  },

  categoriesPref() {
    return String(Prefs.get("discoveryCategories", "") || "")
      .split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  },

  /**
   * 执行一次发现：构建画像 → 拉取 → 打分 → 缓存
   * @returns {{ok:boolean, reason?:string, count?:number, ...}}
   */
  async run(opts) {
    const o = opts || {};
    const zh = I18n.isZh;
    const cats = this.categoriesPref();
    let items;
    try { items = await this.collectLibraryItems(); }
    catch (e) { return { ok: false, reason: (zh ? "读取库失败：" : "Library read failed: ") + (e && e.message || e) }; }

    const profile = this.buildProfile(items, { topTerms: Number(Prefs.get("discoveryProfileTerms", 40)) });
    const query = this.buildQuery(profile, { categories: cats });
    if (!query) {
      return { ok: false, reason: zh
        ? "库中可分析的文献太少，且未指定 arXiv 分类。请先在设置里填写分类（如 cs.CL, cs.AI），或先往库里导入一些文献。"
        : "Not enough analyzable items and no arXiv categories set." };
    }
    let xml;
    try {
      xml = await this.fetchFeed(query, Number(Prefs.get("discoveryMaxPerFeed", 100)));
    } catch (e) {
      return { ok: false, reason: (zh ? "arXiv 拉取失败：" : "arXiv fetch failed: ") + (e && e.message || e) };
    }
    const entries = this.parseAtom(xml);
    if (!entries.length) {
      return { ok: false, reason: zh
        ? "arXiv 没有返回条目（分类代码可能写错了，例如应为 cs.CL 而非 cs.cl）。"
        : "arXiv returned no entries (check category codes, e.g. cs.CL)." };
    }
    const known = this.knownIndex(items);
    const ranked = this.rank(entries, profile, {
      known,
      ignored: this.ignoredSet(),
      categories: cats,
      max: Number(Prefs.get("discoveryMaxResults", 30)) || 30,
    });
    const data = {
      generatedAt: new Date().toISOString(),
      scope: cats.length ? (zh ? "分类：" : "Categories: ") + cats.join(", ") : (zh ? "按库内兴趣词" : "By interest terms"),
      query,
      fetched: entries.length,
      profile: { terms: profile.terms.slice(0, 20), categories: profile.categories },
      items: ranked,
    };
    this.saveCache(data);
    Prefs.set("discoveryLastRun", this._today());
    return { ok: true, count: ranked.length, fetched: entries.length, data };
  },

  /** 全库常规条目（用于画像与去重） */
  async collectLibraryItems() {
    const out = [];
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    s.addCondition("itemType", "isNot", "note");
    for (const id of await s.search()) {
      const it = await Zotero.Items.getAsync(id);
      if (it && it.isRegularItem && it.isRegularItem() && !it.deleted) out.push(it);
    }
    return out;
  },

  /* ---------------- 收藏到库 ---------------- */

  /** 把一条推荐建成库内条目（preprint 类型，字段逐个 try/catch，缺字段回落 extra） */
  async createItem(entry) {
    const item = new Zotero.Item("preprint");
    item.libraryID = Zotero.Libraries.userLibraryID;
    const set = (f, v) => { if (v == null || v === "") return false; try { item.setField(f, v); return true; } catch (e) { return false; } };
    set("title", entry.title);
    set("abstractNote", entry.summary);
    if (entry.published) set("date", String(entry.published).slice(0, 10));
    set("url", entry.link);
    set("repository", "arXiv");
    if (entry.doi) set("DOI", entry.doi);
    if (entry.journalRef) set("publicationTitle", entry.journalRef);
    let placed = set("archiveID", entry.arxivId ? "arXiv:" + entry.arxivId : "");
    if (!placed && entry.arxivId) {
      try { item.setField("extra", "arXiv:" + entry.arxivId); } catch (e) { /* ignore */ }
    }
    const creators = (entry.authors || []).map((n) => {
      const parts = String(n).trim().split(/\s+/);
      if (parts.length >= 2) {
        const last = parts.pop();
        return { creatorType: "author", firstName: parts.join(" ").replace(/^\*+/, "").trim(), lastName: last };
      }
      return { creatorType: "author", name: String(n) };
    });
    if (creators.length) item.setCreators(creators);
    await item.saveTx();
    return item;
  },

  /** 收藏并加入「推荐」分类（分类不存在则创建） */
  async collect(entry) {
    const item = await this.createItem(entry);
    if (!item) return null;
    const name = String(Prefs.get("discoveryCollectionName", "arXiv 推荐") || "arXiv 推荐");
    try {
      const lib = Zotero.Libraries.userLibrary;
      let col = null;
      for (const c of (lib.getCollections() || [])) if (c.name === name) { col = c; break; }
      if (!col) { col = new Zotero.Collection(); col.libraryID = lib.libraryID; col.name = name; await col.saveTx(); }
      await col.addItem(item.id);
      return { item, collection: col };
    } catch (e) {
      return { item, collection: null };
    }
  },

  /** 推荐列表 → 笔记（纯函数） */
  listMarkdown(data) {
    const zh = I18n.isZh;
    let md = "## " + (zh ? "arXiv 每日推荐" : "arXiv Daily") + "\n" +
      "- " + (zh ? "生成时间" : "Generated") + "：" + String(data.generatedAt || "").replace("T", " ").slice(0, 16) + "\n" +
      "- " + (zh ? "范围" : "Scope") + "：" + (data.scope || "-") + "\n\n";
    (data.items || []).forEach((e, i) => {
      md += "### " + (i + 1) + ". " + e.title + "\n";
      md += "- " + (e.authors || []).slice(0, 4).join(", ") + ((e.authors || []).length > 4 ? " et al." : "") + "\n";
      md += "- " + String(e.published || "").slice(0, 10) + " ｜ " + (e.categories || []).join(", ") +
        " ｜ arXiv:" + e.arxivId + "\n";
      md += "- " + (zh ? "相关度" : "Score") + " " + e.score + (e.reasons && e.reasons.length ? "（" + (zh ? "命中：" : "matched: ") + e.reasons.join(", ") + "）" : "") + "\n";
      md += "- " + e.link + "\n";
      md += "\n" + String(e.summary || "").slice(0, 400) + "\n\n";
    });
    md += "> " + (zh ? "由 PaperPilot 文献发现生成，请自行判断相关性。" : "Generated by PaperPilot Discovery.");
    return md;
  },

  async saveListAsNote(data) {
    const zh = I18n.isZh;
    const md = this.listMarkdown(data);
    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    try {
      const M = (typeof MdLite !== "undefined") ? MdLite : null;
      note.setNote(M ? M.toNoteHtml(zh ? "arXiv 每日推荐" : "arXiv Daily", md) : "<pre>" + md + "</pre>");
    } catch (e) { note.setNote("<pre>" + String(md).replace(/</g, "&lt;") + "</pre>"); }
    await note.saveTx();
    return note;
  },

  /* ---------------- 每日定时（默认关闭） ---------------- */

  _timer: null,

  start() {
    if (this._timer) return;
    // 每 30 分钟检查一次「是否到了今天的刷新时间」；功能未开启时直接返回
    this._timer = setInterval(() => { this._maybeDaily().catch(() => {}); }, 30 * 60 * 1000);
    // 启动后 90s 首次检查（避开启动高峰）
    setTimeout(() => { this._maybeDaily().catch(() => {}); }, 90 * 1000);
  },

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  async _maybeDaily() {
    try {
      if (!Prefs.get("discoveryEnabled", false)) return;
      if (Prefs.get("discoveryLastRun", "") === this._today()) return;
      Zotero.debug("PaperPilot discovery: daily refresh starting");
      const r = await this.run();
      Zotero.debug("PaperPilot discovery daily: " + JSON.stringify({ ok: r.ok, count: r.count, reason: r.reason }));
    } catch (e) {
      try { Zotero.logError(e); } catch (_) { /* ignore */ }
    }
  },

  /** 菜单/功能中心入口：打开推荐窗口 */
  openDialog() {
    const win = Zotero.getMainWindow();
    if (!win) return null;
    try {
      const en = Services.wm.getEnumerator("paperpilot:discovery");
      if (en.hasMoreElements()) { const w = en.getNext(); w.focus(); return w; }
    } catch (e) { /* ignore */ }
    return win.openDialog(
      "chrome://paperpilot/content/discovery.xhtml",
      "paperpilot-discovery",
      "chrome,centerscreen,resizable,dialog=no",
      { Zotero, Services }
    );
  },
};
