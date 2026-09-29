/* PaperPilot 引文追溯（0.7.0 新增）
 * 基于 Semantic Scholar references/citations 端点：
 * 选中条目 → 解析 S2 paper（DOI 优先，标题检索兜底）→ 拉参考文献与施引文献
 * → 按被引量降序生成 Markdown 笔记（标注哪些参考文献已在本地文库）。
 * 数据字段：title/year/venue/citationCount/externalIds（复用 S2Client.FIELDS）
 */
/* global Zotero, Services, Prefs, I18n, S2Client, CitationColumn, Notes, ItemSel */

var CitationTrace = {
  _doiSet: null,
  _doiSetT: 0,

  _get(item, f) {
    try { return item.getField(f) || ""; } catch (e) { return ""; }
  },

  /** 解析选中条目到 S2 paper 对象；失败抛错。
   *  DOI 命中的记录会做标题一致性校验——库中 DOI 错配（如数字错位）时
   *  自动回退标题检索，避免给错论文拉引文。 */
  async resolvePaper(item) {
    const zh = I18n.isZh;
    const title = this._get(item, "title");
    const want = CitationColumn.normalizeTitle(title);
    const doi = CitationColumn.normalizeDOI(this._get(item, "DOI"));
    let doiPaper = null;
    if (doi) {
      try { doiPaper = await S2Client.paperById("DOI:" + doi); } catch (e) { /* 落标题检索 */ }
      if (doiPaper && want && CitationColumn.normalizeTitle(doiPaper.title) === want) return doiPaper;
    }
    if (title) {
      // DOI 查无或标题不符 → 标题检索兜底
      const cands = await S2Client.searchByTitle(title);
      const hit = cands.find((p) => CitationColumn.normalizeTitle(p.title) === want);
      if (hit) {
        if (doiPaper) {
          Zotero.debug(`PaperPilot: 引文追溯检测到 DOI 错配（${doi}），已按标题匹配到正确记录`);
        }
        return hit;
      }
      if (doiPaper) return doiPaper; // 标题检索也无果，退回 DOI 记录（聊胜于无）
    } else if (doiPaper) {
      return doiPaper;
    }
    throw new Error(zh ? "Semantic Scholar 查无此文" : "Not found on Semantic Scholar");
  },

  /** 本地文库 DOI 集合（1 分钟缓存），用于标注「在库」 */
  async _libraryDOIs() {
    if (this._doiSet && Date.now() - this._doiSetT < 60000) return this._doiSet;
    const s = new Zotero.Search();
    s.libraryID = Zotero.Libraries.userLibraryID;
    s.addCondition("itemType", "isNot", "attachment");
    const ids = await s.search();
    const set = new Set();
    for (const id of ids) {
      const it = await Zotero.Items.getAsync(id);
      if (!it || !it.isRegularItem || !it.isRegularItem()) continue;
      const d = CitationColumn.normalizeDOI(it.getField("DOI") || "");
      if (d) set.add(d);
    }
    this._doiSet = set;
    this._doiSetT = Date.now();
    return set;
  },

  _fmt(p, doiSet) {
    const doi = CitationColumn.normalizeDOI((p.externalIds && p.externalIds.DOI) || "");
    const inLib = doi && doiSet.has(doi);
    const bits = [];
    if (p.year) bits.push(p.year);
    if (p.venue) bits.push(p.venue);
    if (typeof p.citationCount === "number") bits.push((I18n.isZh ? "被引 " : "cites ") + p.citationCount);
    let line = "- " + (inLib ? "**[" + (I18n.isZh ? "在库" : "in lib") + "]** " : "") + (p.title || "(no title)");
    if (bits.length) line += "（" + bits.join("，") + "）";
    if (doi) line += " — https://doi.org/" + doi;
    return line;
  },

  /** 核心：返回 {paper, refs, cites, md}；topN 限制每段条数 */
  async trace(item, topN) {
    const zh = I18n.isZh;
    const paper = await this.resolvePaper(item);
    if (!paper || !paper.paperId) throw new Error(zh ? "S2 记录缺少 paperId" : "No paperId");
    const pid = paper.paperId;
    const [refsRaw, citesRaw] = await Promise.all([
      S2Client.references(pid).catch(() => []),
      S2Client.citations(pid).catch(() => []),
    ]);
    const refs = refsRaw.map((r) => r.citedPaper).filter(Boolean);
    const cites = citesRaw.map((r) => r.citingPaper).filter(Boolean);
    const byCount = (a, b) => (b.citationCount || 0) - (a.citationCount || 0);
    refs.sort(byCount);
    cites.sort(byCount);
    const doiSet = await this._libraryDOIs();
    const n = topN || 50;
    const date = new Date().toISOString().slice(0, 10);
    const title = this._get(item, "title") || paper.title || "";
    const md =
      (zh ? "数据：Semantic Scholar，" : "Source: Semantic Scholar, ") + date +
      (zh ? "。S2 被引 " : ". S2 citations ") + (paper.citationCount != null ? paper.citationCount : "?") +
      (zh ? "，参考文献 " : ", references ") + refs.length +
      (zh ? " 篇，施引文献 " : ", citing papers ") + cites.length +
      (zh ? " 篇。**加粗[在库]** = 已在本地文库。" : ". **[in lib]** = already in local library.") +
      "\n\n## " + (zh ? "施引文献（谁引用了本文，按被引量降序 Top " : "Citing papers (top ") + n + "）\n" +
      (cites.slice(0, n).map((p) => this._fmt(p, doiSet)).join("\n") || (zh ? "（无）" : "(none)")) +
      "\n\n## " + (zh ? "参考文献（本文引用的，按被引量降序 Top " : "References (top ") + n + "）\n" +
      (refs.slice(0, n).map((p) => this._fmt(p, doiSet)).join("\n") || (zh ? "（无）" : "(none)"));
    return { paper, refs, cites, md, title };
  },

  /** 菜单入口：为选中条目逐篇生成引文追溯笔记 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) {
      ItemSel.alertEmpty();
      return;
    }
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot");
    pw.show();
    let first = true;
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const r = await this.trace(item);
        await Notes.createFromMarkdown(item, (I18n.isZh ? "引文追溯｜" : "Citation Trace | ") + r.title, r.md);
        progress.setText((I18n.isZh ? "参考文献 " : "refs ") + r.refs.length + " · " +
          (I18n.isZh ? "施引 " : "cited by ") + r.cites.length);
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        progress.setText(String(e && e.message || e).slice(0, 80));
        Zotero.logError(e);
      }
      if (!first) await new Promise((r2) => setTimeout(r2, 1100)); // S2 限速
      first = false;
    }
    pw.startCloseTimer(3000);
  },

  /** 拆分 "First M. Last" → Zotero creator */
  _splitName(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return null;
    if (parts.length === 1) return { lastName: parts[0], firstName: "", creatorType: "author" };
    return { lastName: parts[parts.length - 1], firstName: parts.slice(0, -1).join(" "), creatorType: "author" };
  },

  /** 菜单入口（0.8.0）：拉参考文献 → 勾选 → 批量入库（进当前选中分类） */
  async importForSelected() {
    const zh = I18n.isZh;
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const item = ItemSel.regularOnly(zp.getSelectedItems() || [])[0];
    if (!item) {
      ItemSel.alertEmpty();
      return;
    }
    const win = Zotero.getMainWindow();
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot");
    pw.show();
    const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      zh ? "正在拉取参考文献…" : "Fetching references…");
    progress.setProgress(30);

    // 1. 解析 + 拉参考文献（富字段，含作者/摘要供入库）
    let paper, refs;
    try {
      const title = this._get(item, "title");
      const want = CitationColumn.normalizeTitle(title);
      const doi = CitationColumn.normalizeDOI(this._get(item, "DOI"));
      if (doi) {
        try { paper = await S2Client.paperById("DOI:" + doi, "title,year,venue,externalIds,citationCount"); } catch (e) { /* 落标题检索 */ }
        if (paper && want && CitationColumn.normalizeTitle(paper.title) !== want) paper = null; // 错配回退
      }
      if (!paper && title) {
        const cands = await S2Client.searchByTitle(title, 5, "title,year,venue,externalIds,citationCount");
        paper = cands.find((p) => CitationColumn.normalizeTitle(p.title) === want);
      }
      if (!paper || !paper.paperId) throw new Error(zh ? "Semantic Scholar 查无此文" : "Not found on S2");
      refs = (await S2Client.references(paper.paperId,
        "title,year,venue,abstract,externalIds,authors,citationCount", 200))
        .map((r) => r.citedPaper).filter(Boolean);
    } catch (e) {
      progress.setError();
      progress.setText(String(e && e.message || e).slice(0, 80));
      pw.startCloseTimer(3000);
      return;
    }

    // 2. 过滤已在库，按被引量降序
    const doiSet = await this._libraryDOIs();
    const fresh = refs.filter((p) => {
      const d = CitationColumn.normalizeDOI((p.externalIds && p.externalIds.DOI) || "");
      return d && !doiSet.has(d);
    }).sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0)).slice(0, 100);
    progress.setProgress(100);
    pw.startCloseTimer(100);
    if (!fresh.length) {
      Services.prompt.alert(win, "PaperPilot",
        zh ? "参考文献均已在本地文库（或缺 DOI 无法可靠入库）。" : "All references already in library (or lack DOI).");
      return;
    }

    // 3. 勾选对话框
    const io = {
      refs: fresh.map((p) => ({
        title: p.title, year: p.year, venue: p.venue, citationCount: p.citationCount,
        doi: CitationColumn.normalizeDOI((p.externalIds && p.externalIds.DOI) || ""),
      })),
      paperTitle: this._get(item, "title") || paper.title || "",
      total: refs.length,
      selected: null,
    };
    win.openDialog(
      "chrome://paperpilot/content/refs-picker.xhtml",
      "paperpilot-refs-picker",
      "chrome,modal,centerscreen,resizable",
      io
    );
    if (!io.selected || !io.selected.length) return;

    // 4. 批量创建条目（进当前选中分类）
    let col = null;
    try { col = zp.getSelectedCollections && zp.getSelectedCollections()[0]; } catch (e) { /* Z10 */ }
    const pw2 = new Zotero.ProgressWindow({ closeOnClick: true });
    pw2.changeHeadline("PaperPilot");
    pw2.show();
    let ok = 0, fail = 0;
    for (const idx of io.selected) {
      const p = fresh[idx];
      const prog = new pw2.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
        (p.title || "").slice(0, 60));
      try {
        const ni = new Zotero.Item("journalArticle");
        ni.libraryID = item.libraryID;
        ni.setField("title", p.title || "");
        const d = CitationColumn.normalizeDOI((p.externalIds && p.externalIds.DOI) || "");
        if (d) ni.setField("DOI", d);
        if (p.year) ni.setField("date", String(p.year));
        if (p.venue) ni.setField("publicationTitle", p.venue);
        if (p.abstract) ni.setField("abstractNote", p.abstract);
        if (Array.isArray(p.authors) && p.authors.length) {
          const creators = p.authors.map((a) => this._splitName(a && a.name)).filter(Boolean);
          if (creators.length) ni.setCreators(creators);
        }
        if (col) ni.addToCollection(col.id);
        await ni.saveTx();
        ok++;
        prog.setProgress(100);
      } catch (e) {
        fail++;
        prog.setError();
        Zotero.logError(e);
      }
    }
    const sum = new pw2.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (zh ? "已入库 " : "Imported ") + ok + (zh ? " 篇" : "") +
      (fail ? (zh ? "，失败 " : ", failed ") + fail : "") +
      (col ? (zh ? " → 分类「" : " → \"") + col.name + "」" : ""));
    sum.setProgress(100);
    pw2.startCloseTimer(3000);
  },
};
