/* PaperPilot 核心工具：pref 读写 + 简易 i18n + Markdown→笔记 HTML + 笔记助手 + 选中归一化 */
/* global Zotero, Services */

var Prefs = {
  PREFIX: "extensions.zotero.paperpilot.",

  get(key, fallback) {
    try {
      const v = Zotero.Prefs.get(this.PREFIX + key, true);
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  },

  set(key, value) {
    Zotero.Prefs.set(this.PREFIX + key, value, true);
  },
};

// 轻量 i18n：按 Zotero 界面语言选择文案（菜单等无法走 ftl 的地方用）
var I18n = (() => {
  const zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
  const table = {
    menuSettings: zh ? "PaperPilot 设置" : "PaperPilot Settings",
    menuConnTest: zh ? "PaperPilot 接口连通性测试" : "PaperPilot Connection Test",
    menuAiNote: zh ? "AI 深度解读所选文献（生成笔记）" : "AI Deep Interpretation (note)",
    menuAiSummary: zh ? "AI 总结（生成笔记）" : "AI Summary (note)",
    menuAiTranslate: zh ? "AI 翻译标题与摘要（生成笔记）" : "AI Translate Title & Abstract (note)",
    connOk: zh ? "✅ 接口连通正常" : "✅ Connection OK",
    connFail: zh ? "❌ 接口测试失败" : "❌ Connection failed",
    quickSummary: zh ? "总结本篇" : "Summarize",
    quickTranslate: zh ? "翻译摘要" : "Translate abstract",
    noteSummaryTitle: zh ? "AI 文献总结" : "AI Summary",
    noteTranslateTitle: zh ? "AI 翻译（标题与摘要）" : "AI Translation (Title & Abstract)",
    menuAiTag: zh ? "AI 自动打标签…" : "AI Auto Tag…",
    menuMatrix: zh ? "AI 文献矩阵（对比表格笔记）" : "AI Literature Matrix (note)",
    menuCollectAnnot: zh ? "收集批注为笔记" : "Collect Annotations to Note",
    menuAiAnnot: zh ? "AI 解读我的批注（生成笔记）" : "AI Interpret My Annotations (note)",
    menuCollStat: zh ? "PaperPilot 分类条目统计" : "PaperPilot Collection Stats",
    noteAnnotTitle: zh ? "批注收集" : "Annotations",
    noteAnnotAiTitle: zh ? "AI 批注解读" : "AI Annotation Insights",
    noteMatrixTitle: zh ? "AI 文献矩阵" : "AI Literature Matrix",
    annotEmpty: zh ? "该条目没有高亮或批注" : "No annotations on this item",
    matrixBusy: zh ? "正在逐篇抽取维度…" : "Extracting dimensions…",
    popupTranslate: zh ? "翻译" : "Translate",
    popupExplain: zh ? "解读" : "Explain",
    popupAsk: zh ? "追问…" : "Ask…",
    popupAskPlaceholder: zh ? "就这段文字继续提问…" : "Ask about this excerpt…",
    popupSend: zh ? "发送" : "Send",
    popupCopy: zh ? "复制" : "Copy",
    popupCopied: zh ? "✓ 已复制" : "✓ Copied",
    popupRetry: zh ? "重试" : "Retry",
    popupWriteBack: zh ? "写入批注" : "Add to annotation",
    popupWriteBackDone: zh ? "✓ 已写入批注" : "✓ Added to annotation",
    popupWriteBackFail: zh ? "写入批注失败：" : "Failed to add to annotation: ",
    popupContinuePane: zh ? "在侧栏继续" : "Continue in sidebar",
    popupPaneUnavailable: zh
      ? "请先在右侧栏打开「AI 问答」面板"
      : "Open the AI Chat section in the sidebar first",
    popupDailyNotice: zh
      ? "提示：今日 AI 请求已达 500 次，请注意额度"
      : "Note: 500 AI requests today — watch your quota",
    promptRun: zh ? "执行" : "Run",
    tagApplyDone: zh ? "已写入标签" : "Tags applied",
    chatPlaceholder: zh ? "针对这篇文献提问…" : "Ask about this paper…",
    chatSend: zh ? "发送" : "Send",
    chatClear: zh ? "清空" : "Clear",
    chatSave: zh ? "存为笔记" : "Save as note",
    chatSaved: zh ? "已保存为笔记" : "Saved as note",
    chatEmptyHistory: zh ? "还没有可保存的对话" : "Nothing to save yet",
    chatNoKey: zh
      ? "请先在 编辑 → 设置 → PaperPilot 中登录账号（官方模型免费），或在「AI 模型通道」中配置自己的接口"
      : "Log in under Edit → Settings → PaperPilot (official model is free), or configure your own channel",
    chatNoPdf: zh
      ? "该条目没有可读取的 PDF 全文（扫描件请先 OCR）"
      : "No readable PDF full text (OCR scanned PDFs first)",
    chatReading: zh ? "正在读取 PDF 全文…" : "Reading PDF full text…",
    chatThinking: zh ? "AI 思考中…" : "AI is thinking…",
    chatEmpty: zh ? "选中一篇带 PDF 的文献，然后开始提问。" : "Select an item with a PDF and ask away.",
    chatNoItem: zh ? "当前没有选中文献" : "No item selected",
    noteTitle: zh ? "AI 文献解读" : "AI Interpretation",
    noteChatTitle: zh ? "AI 问答记录" : "AI Q&A",
    noteDone: zh ? "已生成解读笔记" : "Note created",
    rankColumnLabel: zh ? "期刊分区" : "Journal Rank",
    citationColumnLabel: zh ? "被引量" : "Citations",
    menuS2Refresh: zh ? "重新抓取被引量（Semantic Scholar）" : "Refresh Citations (Semantic Scholar)",
    menuRuleTag: zh ? "规则打标（按自定义规则）" : "Rule-based Tagging",
    menuCiteTrace: zh ? "引文追溯（参考文献/施引文献笔记）" : "Citation Trace (note)",
    menuFakeCheck: zh ? "真假文献识别（AI 幻觉检测）" : "Fake Reference Check",
    menuSmartCleanup: zh ? "智能清理（重复/无附件/缺元数据扫描）" : "Smart Cleanup Scan",
    menuMetaEnrich: zh ? "元数据补全（S2/Crossref 回写缺失字段）" : "Fill Missing Metadata (S2)",
    menuRefImport: zh ? "参考文献一键入库…" : "Import References…",
    menuPasteCheck: zh ? "粘贴文献列表核验（AI 幻觉检测）…" : "Verify Pasted References…",
    menuWorkbench: zh ? "PaperPilot 工作台（独立窗口）" : "PaperPilot Workbench (standalone window)",
    menuChannels: zh ? "PaperPilot AI 模型通道" : "PaperPilot AI Channels",
    menuChannelsEmpty: zh ? "（暂无通道，在设置中新增）" : "(No channels — add in Settings)",
    channelSwitched: zh ? "已切换 AI 通道" : "AI channel switched",
    channelSwitchBlocked: zh ? "无法切换" : "Cannot switch",
    errPrefix: zh ? "出错：" : "Error: ",
    // ---- 0.11.0 新增 ----
    menuHub: zh ? "PaperPilot 功能中心" : "PaperPilot Feature Hub",
    menuBilingual: zh ? "全文对照翻译（AI 双语笔记）" : "Bilingual Full-text Translation (note)",
    noteBilingualTitle: zh ? "全文对照翻译" : "Bilingual Translation",
    menuCnMeta: zh ? "中文文件名识别元数据（知网/万方）" : "Parse Chinese Filename Metadata",
    menuCnFetch: zh ? "抓取中文元数据（网络搜索知网等）" : "Fetch CN Metadata (PubScholar/CNKI)",
    menuCnTranslators: zh ? "更新中文转换器（修复知网抓取）" : "Update CN Translators (fix CNKI)",
    menuCnMatchAtt: zh ? "在下载文件夹中查找附件" : "Find Attachments in Downloads",
    menuCnNameMerge: zh ? "合并中文姓名（两栏→单栏）" : "Merge CN Names (to single field)",
    menuCnNameSplit: zh ? "拆分中文姓名（单栏→姓+名）" : "Split CN Names (to two fields)",
    menuReadingState: zh ? "阅读状态" : "Reading State",
    menuStateUnread: zh ? "标记为「未读」" : "Mark as Unread",
    menuStateReading: zh ? "标记为「在读」" : "Mark as Reading",
    menuStateDone: zh ? "标记为「已读」" : "Mark as Done",
    menuNoteTemplate: zh ? "按模板新建笔记…" : "New Note from Template…",
    menuAttachRename: zh ? "附件按规则重命名" : "Rename Attachments by Pattern",
    menuMindmap: zh ? "AI 思维导图（大纲笔记）" : "AI Mind Map (outline note)",
    noteMindmapTitle: zh ? "思维导图" : "Mind Map",
    menuReview: zh ? "AI 文献综述（多篇，带引用）" : "AI Literature Review (multi)",
    noteReviewTitle: zh ? "AI 文献综述" : "AI Literature Review",
    menuMetaLint: zh ? "元数据规范清洗（DOI/日期/标题/URL）" : "Metadata Lint",
    menuOaFetch: zh ? "开放获取补全文（Unpaywall）" : "Find OA Full Text (Unpaywall)",
    menuAnki: zh ? "AI 制卡导出 Anki…" : "AI Cards to Anki…",
    menuLibGraph: zh ? "PaperPilot 文献统计图谱（HTML 报告）" : "PaperPilot Library Report (HTML)",
  };
  return {
    t(key) { return table[key] || key; },
    isZh: zh,
  };
})();

// Markdown 子集 → Zotero 笔记 HTML（标题/加粗/行内代码/无序与有序列表/段落）
var MdLite = {
  escape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  // 行内元素（输入为未转义文本）
  inline(s) {
    return this.escape(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  },

  /** Markdown 子集 → 富文本 HTML 正文（0.10.0 抽出：侧栏气泡渲染与笔记共用，
   *  语义标签不加硬编码颜色，深浅主题都安全） */
  toHtml(md) {
    const lines = String(md || "").split(/\r?\n/);
    let html = "";
    let inList = false;
    let para = [];
    let table = [];
    const flushPara = () => {
      if (para.length) { html += "<p>" + para.join("<br/>") + "</p>"; para = []; }
    };
    const closeList = () => {
      if (inList) { html += "</ul>"; inList = false; }
    };
    const flushTable = () => {
      if (!table.length) return;
      const rows = table.filter(l => !/^\s*\|[\s:|-]+\|\s*$/.test(l)); // 去掉分隔行
      if (rows.length) {
        html += '<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;">';
        rows.forEach((l, idx) => {
          const cells = l.trim().replace(/^\||\|$/g, "").split("|");
          const tag = idx === 0 ? "th" : "td";
          html += "<tr>" + cells.map(c => `<${tag}>${this.inline(c.trim())}</${tag}>`).join("") + "</tr>";
        });
        html += "</table>";
      }
      table = [];
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const isTable = /^\s*\|.+\|\s*$/.test(line);
      if (isTable) { flushPara(); closeList(); table.push(line); continue; }
      flushTable();
      const h = line.match(/^\s*#{1,4}\s+(.+)$/);
      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (h) {
        flushPara(); closeList();
        html += "<h3>" + this.inline(h[1]) + "</h3>";
      } else if (li) {
        flushPara();
        if (!inList) { html += "<ul>"; inList = true; }
        html += "<li>" + this.inline(li[1]) + "</li>";
      } else if (!line.trim()) {
        flushPara(); closeList();
      } else if (/^\s*>/.test(line)) {
        flushPara(); closeList();
        html += "<blockquote>" + this.inline(line.replace(/^\s*>\s?/, "")) + "</blockquote>";
      } else if (/^\s*---+\s*$/.test(line)) {
        flushPara(); closeList();
        html += "<hr/>";
      } else {
        closeList();
        para.push(this.inline(line));
      }
    }
    flushTable();
    flushPara(); closeList();
    return html;
  },

  toNoteHtml(title, md) {
    return "<h2>" + this.escape(title) + "</h2>" + this.toHtml(md);
  },
};

// 笔记助手：常规条目挂到条目下，附件挂到其父条目下
var Notes = {
  async createFromMarkdown(item, title, md) {
    const note = new Zotero.Item("note");
    note.libraryID = item.libraryID;
    if (item.isRegularItem && item.isRegularItem()) {
      note.parentID = item.id;
    } else if (item.parentID) {
      note.parentID = item.parentID;
    }
    note.setNote(MdLite.toNoteHtml(title, md));
    await note.saveTx();
    return note;
  },
};

// 选中条目归一化（0.8.1）：PDF/附件自动上溯到父条目，去重。
// 背景：用户选中 PDF 附件再点 AI 功能时，旧代码 isRegularItem 过滤后列表为空，
// 静默无反应，看起来就像"功能坏了"。
var ItemSel = {
  regularOnly(items) {
    const out = [];
    for (const i of items || []) {
      try {
        if (i.isRegularItem && i.isRegularItem()) { out.push(i); continue; }
        if (i.isAttachment && i.isAttachment() && i.parentID) {
          const p = Zotero.Items.get(i.parentID);
          if (p && p.isRegularItem && p.isRegularItem()) out.push(p);
        }
      } catch (e) { /* ignore */ }
    }
    return [...new Set(out)];
  },

  /** 空选择时给用户明确反馈（各 runForSelected 统一调用） */
  alertEmpty() {
    try {
      Services.prompt.alert(
        Zotero.getMainWindow(),
        "PaperPilot",
        I18n.isZh
          ? "没有可处理的条目。\n请先在条目列表中选中至少一篇文献（选 PDF 附件也可以，会自动定位到其父条目）。"
          : "No processable items. Select at least one item first (selecting a PDF attachment works too — its parent item is used)."
      );
    } catch (e) { /* ignore */ }
  },
};
