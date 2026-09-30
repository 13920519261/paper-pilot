/* PaperPilot 笔记模板系统（0.11.0，Better Notes 品类的轻量路线）
 * 模板 = 带占位符的 Markdown 骨架，对选中条目一键生成结构化笔记。
 * 占位符：{{title}} {{creators}} {{year}} {{pub}} {{doi}} {{abstract}}
 *         {{annotations}}（批注列表，无批注则占位文字）
 *         {{aiSummary}}（调 AI 生成 300 字总结，失败降级为摘要字段）
 * 内置 3 套模板 + 用户自定义（pref noteTemplatesCustom，
 * 每行：名称=模板正文，正文里用 \n 表示换行）。
 */
/* global Zotero, Services, Prefs, AIChat, AIClient, Annotations, Notes, I18n, ItemSel */

var NoteTemplates = {
  builtin: [
    {
      id: "reading",
      name: "文献阅读笔记",
      body: "## {{title}}\n\n**作者**：{{creators}}　**期刊**：{{pub}}　**年份**：{{year}}\n\n" +
        "### 研究问题\n\n### 研究方法\n\n### 主要结果\n\n### 结论与启示\n\n### 批注摘录\n\n{{annotations}}\n\n### 我的评价\n",
    },
    {
      id: "card",
      name: "精读卡片",
      body: "# {{title}}\n\n> 一句话总结：\n\n**核心概念**：\n\n**金句**：\n\n{{annotations}}\n\n**可借鉴**：\n\n**待追问**：\n",
    },
    {
      id: "quick",
      name: "速读记录（AI 摘要）",
      body: "## {{title}}（{{year}}）\n\n{{aiSummary}}\n\n---\n\n### 我的备注\n",
    },
  ],

  all() {
    const custom = [];
    const raw = Prefs.get("noteTemplatesCustom", "") || "";
    for (const line of String(raw).split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim();
      const body = line.slice(idx + 1).trim().replace(/\\n/g, "\n");
      if (name && body) custom.push({ id: "custom-" + custom.length, name, body });
    }
    return this.builtin.concat(custom);
  },

  _annotationsMd(item) {
    try {
      const groups = Annotations.collect(item);
      if (!groups) return I18n.isZh ? "（暂无批注）" : "(no annotations)";
      const lines = [];
      for (const g of groups) {
        for (const a of g.list) {
          const page = a.page ? `（p.${a.page}）` : "";
          if (a.text) lines.push(`- ${a.text.replace(/\n+/g, " ")} ${page}`.trim());
          if (a.comment) lines.push(`  - ${a.comment}`);
        }
      }
      return lines.length ? lines.join("\n") : (I18n.isZh ? "（暂无批注）" : "(no annotations)");
    } catch (e) {
      return I18n.isZh ? "（批注读取失败）" : "(annotations unavailable)";
    }
  },

  /**
   * 渲染模板：占位符替换。
   * @param tpl {name, body}
   * @param item Zotero 常规条目
   * @param hooks {aiSummary?: () => Promise<string>} 测试时可注入
   */
  async render(tpl, item, hooks = {}) {
    const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
    let creators = "";
    try {
      creators = (item.getCreators() || [])
        .map((c) => c.fieldMode === 1 ? c.lastName : [c.firstName, c.lastName].filter(Boolean).join(" "))
        .join(", ");
    } catch (e) { /* ignore */ }

    const map = {
      title: get("title"),
      creators,
      year: String(get("date")).slice(0, 4),
      pub: get("publicationTitle"),
      doi: get("DOI"),
      abstract: get("abstractNote"),
      annotations: () => this._annotationsMd(item),
      aiSummary: async () => {
        if (hooks.aiSummary) return hooks.aiSummary();
        try {
          return await AIChat.summarize(item);
        } catch (e) {
          return get("abstractNote") || (I18n.isZh ? "（AI 摘要不可用）" : "(AI summary unavailable)");
        }
      },
    };

    let out = tpl.body;
    for (const key of Object.keys(map)) {
      const re = new RegExp("\\{\\{" + key + "\\}\\}", "g");
      if (!re.test(out)) continue;
      const val = typeof map[key] === "function" ? await map[key]() : map[key];
      out = out.replace(re, val || "");
    }
    return out;
  },

  /** 菜单入口：选模板 → 生成笔记 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const tpls = this.all();
    const names = tpls.map((t) => t.name);
    const win = Zotero.getMainWindow();
    const out = { value: 0 };
    if (!Services.prompt.select(win, "PaperPilot · " + I18n.t("menuNoteTemplate"),
      I18n.isZh ? "选择笔记模板：" : "Pick a template:", names.length, names, out)) return;
    const tpl = tpls[out.value];
    if (!tpl) return;

    // 含 AI 占位符时检查 key
    if (/\{\{aiSummary\}\}/.test(tpl.body) && !AIClient.hasKey()) {
      Services.prompt.alert(win, "PaperPilot", I18n.t("chatNoKey"));
      return;
    }

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + tpl.name);
    pw.show();
    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(40);
        const md = await this.render(tpl, item);
        await Notes.createFromMarkdown(item, `${tpl.name}｜${title}`, md);
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        Zotero.logError(e);
      }
    }
    pw.startCloseTimer(2500);
  },
};
