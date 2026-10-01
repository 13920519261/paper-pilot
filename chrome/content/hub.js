/* PaperPilot 功能中心逻辑（0.12.0）
 * 只负责导航与调用分发：所有功能动作都经 Zotero.PaperPilot 暴露的
 * 模块引用调起现有 runForSelected()/run() 入口，核心逻辑零改动。
 * 数据通道与 workbench 相同：Zotero/Services 经 window.arguments 传入。
 */
/* global window, document, setInterval, clearInterval */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";

  /** 功能模型（纯数据，动作闭包在调用时才触碰 PP，便于测试与维护） */
  function buildCats(PP, zh) {
    return [
      {
        id: "reader", icon: "📖",
        title: zh ? "阅读助手" : "Reading",
        desc: zh ? "阅读单篇文献时的 AI 精读工具（作用于当前选中的文献）" : "AI tools for the current paper",
        features: [
          { t: zh ? "AI 工作台" : "Workbench", d: zh ? "独立窗口对话，跟随主窗口选中条目" : "Standalone chat window", run: () => PP.openWorkbench() },
          { t: zh ? "AI 总结（生成笔记）" : "Summarize", d: zh ? "300-500 字总结研究问题、方法、结果与结论" : "300-500 word summary note", run: () => PP.menus.aiTaskForSelected((it) => PP.aiChat.summarize(it), "noteSummaryTitle") },
          { t: zh ? "AI 翻译标题与摘要" : "Translate title/abstract", d: zh ? "学术语气翻译，术语保留英文括号标注" : "Academic translation note", run: () => PP.menus.aiTaskForSelected((it) => PP.aiChat.translateTitleAbstract(it), "noteTranslateTitle") },
          { t: zh ? "AI 深度解读" : "Deep interpret", d: zh ? "五段式结构化解读：问题/方法/实验/创新/局限" : "Structured interpretation note", run: () => PP.menus.aiTaskForSelected((it) => PP.aiChat.interpret(it), "noteTitle") },
          { t: zh ? "全文对照翻译" : "Bilingual translation", d: zh ? "逐段原文+译文对照的双语笔记（一次一篇）" : "Paragraph-by-paragraph bilingual note", run: () => PP.bilingual.runForSelected() },
          { t: zh ? "AI 思维导图" : "Mind map", d: zh ? "生成层级大纲笔记，可导出 markmap .md" : "Outline note + .md export", run: () => PP.mindmap.runForSelected() },
          { t: zh ? "AI 问答侧栏" : "Chat sidebar", d: zh ? "选中条目后在右侧栏「AI 问答」直接提问" : "Auto: ask in the sidebar", info: true },
          { t: zh ? "划词浮窗" : "Selection popup", d: zh ? "阅读器内划词即翻译/解读/追问（设置中可配置）" : "Auto: translate/explain/ask in reader", info: true },
          { t: zh ? "PDF 速览" : "PDF glance", d: zh ? "侧栏显示摘要与全文开篇，无需打开 PDF" : "Auto: abstract + opening in sidebar", info: true },
        ],
      },
      {
        id: "notes", icon: "🗒",
        title: zh ? "笔记与卡片" : "Notes & Cards",
        desc: zh ? "读完后的知识沉淀：笔记、模板、记忆卡片" : "Knowledge capture after reading",
        features: [
          { t: zh ? "收集批注为笔记" : "Collect annotations", d: zh ? "聚合全部高亮与批注为一篇笔记" : "Gather highlights into a note", run: () => PP.menus.annotationTask(false) },
          { t: zh ? "AI 解读批注" : "Interpret annotations", d: zh ? "解读划出的重点反映了什么主线与关注点" : "AI insights on your highlights", run: () => PP.menus.annotationTask(true) },
          { t: zh ? "按模板新建笔记" : "Note from template", d: zh ? "阅读笔记/精读卡片/速读记录等模板一键生成" : "Structured note from templates", run: () => PP.noteTemplates.runForSelected() },
          { t: zh ? "AI 制卡导出 Anki" : "Cards to Anki", d: zh ? "基于全文生成问答卡，导出 Anki 导入格式" : "Q/A cards export (.txt)", run: () => PP.ankiExport.runForSelected() },
        ],
      },
      {
        id: "batch", icon: "📊",
        title: zh ? "批量分析" : "Batch Analysis",
        desc: zh ? "多篇文献横向对比与汇总（需选中 2 篇以上或一个分类）" : "Compare and synthesize multiple papers",
        features: [
          { t: zh ? "AI 文献矩阵" : "Literature matrix", d: zh ? "按维度抽取生成对比表格笔记" : "Dimension comparison table", run: () => PP.matrix.forSelected() },
          { t: zh ? "AI 文献综述" : "Literature review", d: zh ? "多篇生成带引用编号的综述段落" : "Review with citation numbers", run: () => PP.reviewGen.forSelected() },
          { t: zh ? "引文追溯" : "Citation trace", d: zh ? "参考文献/施引文献分析笔记" : "References & citing papers note", run: () => PP.citationTrace.runForSelected() },
          { t: zh ? "参考文献一键入库" : "Import references", d: zh ? "把当前文献的参考文献批量添加进库" : "Batch import references", run: () => PP.citationTrace.importForSelected() },
          { t: zh ? "分类条目统计" : "Collection stats", d: zh ? "当前分类的条目/附件/标签统计" : "Stats for current collection", run: () => PP.collectionStats.showForSelectedCollection() },
          { t: zh ? "文献统计图谱" : "Library report", d: zh ? "年份/期刊/作者/标签分布 HTML 报告" : "HTML report with charts", run: () => PP.libGraph.run() },
        ],
      },
      {
        id: "health", icon: "🩺",
        title: zh ? "库健康" : "Library Health",
        desc: zh ? "元数据与附件的检查、修复与补全" : "Metadata & attachment maintenance",
        features: [
          { t: zh ? "中文文件名识别元数据" : "CN filename metadata", d: zh ? "解析知网/万方文件名回填标题作者期刊" : "Parse CNKI-style filenames", run: () => PP.cnMeta.runForSelected() },
          { t: zh ? "抓取中文元数据" : "Fetch CN metadata", d: zh ? "网络搜索（公益学术平台/知网）回填完整题录，保留原附件" : "Search & fill full metadata, keep attachments", run: () => PP.cnFetch.runForSelected() },
          { t: zh ? "更新中文转换器" : "Update CN translators", d: zh ? "拉取最新知网/万方转换器，修复中文抓取与 PDF 下载" : "Fix CNKI scraping & PDF download", run: () => PP.cnTranslators.update(true) },
          { t: zh ? "下载文件夹查找附件" : "Match attachments", d: zh ? "把下载目录里已下载的 PDF/CAJ 按标题匹配到条目" : "Match downloaded PDFs to items", run: () => PP.cnFetch.matchAttachmentsFromDownloads() },
          { t: zh ? "元数据补全" : "Enrich metadata", d: zh ? "S2 查询回写空缺字段（不覆盖已有值）" : "Fill missing fields via S2", run: () => PP.metaEnrich.runForSelected() },
          { t: zh ? "元数据规范清洗" : "Metadata lint", d: zh ? "DOI/日期/标题/URL 格式规范化" : "Normalize DOI/date/title/URL", run: () => PP.metaLint.runForSelected() },
          { t: zh ? "智能清理" : "Smart cleanup", d: zh ? "扫描重复/无附件/缺元数据条目" : "Scan duplicates & gaps", run: () => PP.smartCleanup.run() },
          { t: zh ? "真假文献识别" : "Fake check", d: zh ? "AI 幻觉检测：题录是否真实存在" : "Detect hallucinated references", run: () => PP.fakeCheck.runForSelected() },
          { t: zh ? "粘贴文献列表核验" : "Verify pasted list", d: zh ? "粘贴一段参考文献列表逐条核验真伪" : "Verify a pasted reference list", run: () => PP.fakeCheck.openPasteDialog() },
          { t: zh ? "开放获取补全文" : "Find OA full text", d: zh ? "Unpaywall 合法渠道为有 DOI 条目补 PDF" : "Attach OA PDFs via Unpaywall", run: () => PP.oaFetch.runForSelected() },
          { t: zh ? "附件按规则重命名" : "Rename attachments", d: zh ? "按 作者-年份-标题 模板统一附件文件名" : "Rename PDFs by pattern", run: () => PP.attachManager.runForSelected() },
        ],
      },
      {
        id: "tags", icon: "🏷",
        title: zh ? "标签与状态" : "Tags & State",
        desc: zh ? "组织与筛选：标签体系与阅读状态管理" : "Tagging and reading states",
        features: [
          { t: zh ? "AI 自动打标签" : "AI auto tag", d: zh ? "LLM 按内容建议标签" : "LLM-suggested tags", run: () => PP.autoTag.runForSelected() },
          { t: zh ? "规则打标" : "Rule tag", d: zh ? "按自定义条件规则批量打标签" : "Conditional rule tagging", run: () => PP.ruleTag.runForSelected() },
          { t: zh ? "标记为「未读」" : "Mark unread", d: zh ? "阅读状态三态互斥（未读/在读/已读）" : "Mutually exclusive states", run: () => PP.readingState.markForSelected("未读") },
          { t: zh ? "标记为「在读」" : "Mark reading", d: zh ? "打开 PDF 也会自动从「未读」转为「在读」" : "Auto-updated when opening PDF", run: () => PP.readingState.markForSelected("在读") },
          { t: zh ? "标记为「已读」" : "Mark done", d: zh ? "读完后归档状态" : "Finished state", run: () => PP.readingState.markForSelected("已读") },
        ],
      },
      {
        id: "config", icon: "⚙",
        title: zh ? "数据列与配置" : "Data & Settings",
        desc: zh ? "自动展示的数据列与全局配置入口" : "Columns and global settings",
        features: [
          { t: zh ? "重新抓取被引量" : "Refresh citations", d: zh ? "Semantic Scholar 被引量手动刷新" : "Refresh citation counts", run: () => PP.citationColumn.refreshForSelected() },
          { t: zh ? "接口连通性测试" : "Connection test", d: zh ? "测试当前 AI 服务商与模型是否可用" : "Test AI endpoint", run: () => PP.menus.testConnection() },
          { t: zh ? "打开设置" : "Open settings", d: zh ? "服务商/模型/快照/浮窗/模板等全部配置" : "All preferences", run: () => PP.menus.openSettings() },
          { t: zh ? "期刊分区列" : "Journal rank column", d: zh ? "easyScholar 在线 + 离线数据，列表自动显示" : "Auto column", info: true },
          { t: zh ? "被引量列" : "Citation column", d: zh ? "Semantic Scholar 被引数，右键表头勾选显示" : "Auto column", info: true },
          { t: zh ? "AI 配置快照" : "AI profiles", d: zh ? "工具菜单中一键切换多套 AI 配置" : "Switch profiles in Tools menu", info: true },
        ],
      },
    ];
  }

  function boot() {
    let Services, opener, Zotero, PP, zh;
    try {
      const args = window.arguments && window.arguments[0];
      Services = (args && args.Services) || window.Services;
      Zotero = (args && args.Zotero) || (window.opener && window.opener.Zotero);
      opener = window.opener;
      if (!Services || !Zotero || !Zotero.PaperPilot) return;
      PP = Zotero.PaperPilot;
      zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
    } catch (e) { return; }

    const $ = (id) => document.getElementById(id);
    const nav = $("pp-hub-nav");
    const cards = $("pp-hub-cards");
    const status = $("pp-hub-status");
    const cats = buildCats(PP, zh);
    let activeId = cats[0].id;
    let filterText = "";

    function h(tag, css, text) {
      const el = document.createElementNS(XHTML, tag);
      if (css) el.style.cssText = css;
      if (text != null) el.textContent = text;
      return el;
    }

    function setStatus(t, color) {
      status.textContent = t || "";
      status.style.color = color || "#888";
    }

    function renderNav() {
      nav.textContent = "";
      for (const c of cats) {
        const active = c.id === activeId;
        const btn = h("div",
          "padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px;" +
          (active ? "background:#2563eb;color:#fff;font-weight:600;" : "color:#333;"),
          `${c.icon} ${c.title}`);
        if (!active) {
          btn.addEventListener("mouseenter", () => { btn.style.background = "#e2e2e6"; });
          btn.addEventListener("mouseleave", () => { btn.style.background = ""; });
        }
        btn.addEventListener("click", () => { activeId = c.id; renderAll(); });
        nav.appendChild(btn);
      }
    }

    function renderCards() {
      cards.textContent = "";
      const cat = cats.find((c) => c.id === activeId);
      $("pp-hub-cat-title").textContent = `${cat.icon} ${cat.title}`;
      $("pp-hub-cat-desc").textContent = cat.desc;
      const kw = filterText.trim().toLowerCase();
      const feats = cat.features.filter((f) =>
        !kw || (f.t + " " + f.d).toLowerCase().includes(kw));
      if (!feats.length) {
        cards.appendChild(h("div", "color:#999;padding:12px;",
          zh ? "没有匹配的功能" : "No matching features"));
        return;
      }
      for (const f of feats) {
        const card = h("div",
          "display:flex;align-items:center;gap:10px;border:1px solid #ddd;border-radius:8px;" +
          "padding:10px 12px;background:#fafafa;");
        const left = h("div", "flex:1;min-width:0;");
        left.appendChild(h("div", "font-weight:600;font-size:13px;", f.t));
        left.appendChild(h("div", "color:#666;font-size:12px;margin-top:2px;", f.d));
        card.appendChild(left);
        if (f.info) {
          card.appendChild(h("span",
            "color:#2563eb;font-size:11px;border:1px solid #2563eb55;border-radius:10px;" +
            "padding:1px 8px;white-space:nowrap;",
            zh ? "自动" : "auto"));
        } else {
          const btn = h("button", "padding:4px 14px;font-size:12px;cursor:pointer;white-space:nowrap;",
            zh ? "运行" : "Run");
          btn.addEventListener("click", () => {
            setStatus("");
            try {
              const r = f.run();
              if (r && r.catch) r.catch((e) => setStatus((zh ? "出错：" : "Error: ") + (e && e.message || e), "#c0392b"));
            } catch (e) {
              setStatus((zh ? "出错：" : "Error: ") + (e && e.message || e), "#c0392b");
            }
          });
          card.appendChild(btn);
        }
        cards.appendChild(card);
      }
    }

    function renderAll() { renderNav(); renderCards(); }

    // 主窗口选中计数（批量类功能的可用性提示）
    function pollSelection() {
      try {
        if (!opener || opener.closed) { window.close(); return; }
        const zp = Zotero.getActiveZoteroPane();
        const n = zp ? (zp.getSelectedItems() || []).length : 0;
        $("pp-hub-selcount").textContent = (zh ? "主窗口选中：" : "Selected: ") + n + (zh ? " 篇" : "");
      } catch (e) { /* 主窗口切换瞬间忽略 */ }
    }

    $("pp-hub-filter").addEventListener("input", (ev) => {
      filterText = ev.target.value || "";
      renderCards();
    });

    renderAll();
    pollSelection();
    const timer = setInterval(pollSelection, 1500);
    try { opener.addEventListener("unload", () => window.close(), { once: true }); } catch (e) { /* ignore */ }
    window.addEventListener("unload", () => clearInterval(timer));
  }

  // 暴露模型给测试与调试
  if (typeof window !== "undefined") window.PPHub = { buildCats };

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("load", boot, { once: true });
  }
})();
