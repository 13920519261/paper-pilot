/* PaperPilot 全文对照翻译（0.11.0，PDF2zh 品类的轻量路线）
 * 不做排版保留（那是 Python/Docker 方案），按段落分段送 LLM，
 * 产出「原文/译文」对照的 Zotero 笔记。复用 AIChat 全文提取与缓存。
 * 一次一篇（全文翻译属重任务），进度条按段推进。
 */
/* global Zotero, Services, Prefs, AIChat, AIClient, Notes, I18n, ItemSel */

var BilingualTranslate = {
  /**
   * 全文 → 段落块（尽量在段落边界切分，单块不超 maxChars）
   * @returns {string[]}
   */
  _chunk(text, maxChars) {
    const paras = String(text || "").split(/\n{2,}|\r?\n/);
    const chunks = [];
    let cur = "";
    for (const p of paras) {
      const para = p.trim();
      if (!para) continue;
      // 单段超长：硬切
      if (para.length > maxChars) {
        if (cur) { chunks.push(cur); cur = ""; }
        for (let i = 0; i < para.length; i += maxChars) {
          chunks.push(para.slice(i, i + maxChars));
        }
        continue;
      }
      if (cur && (cur.length + para.length + 2) > maxChars) {
        chunks.push(cur);
        cur = para;
      } else {
        cur = cur ? cur + "\n" + para : para;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  },

  async _translateChunk(chunk, lang) {
    return AIClient.chat([
      { role: "system", content: Prefs.get("aiSystemPrompt", "") || "" },
      { role: "user", content:
        `请将以下论文片段翻译成${lang}，忠实原文，专业术语保留英文并用括号标注。` +
        "纯文本输出，禁止使用任何 Markdown 标记；只输出译文，不要任何解释。\n\n" + chunk },
    ]);
  },

  /** 菜单入口：一次一篇 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }
    if (items.length > 1) {
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        I18n.isZh ? "全文对照翻译一次请只选一篇" : "Select only one item at a time");
      return;
    }
    if (!AIClient.hasKey()) {
      // 0.21.0：区分「未登录官方模型」与「通道缺 Key」，不再用同一条笼统提示
      Services.prompt.alert(Zotero.getMainWindow(), "PaperPilot",
        AIClient.guidance() || I18n.t("chatNoKey"));
      return;
    }

    const item = items[0];
    let title = "";
    try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
    const lang = Prefs.get("readerPopupTargetLang", "中文") || "中文";

    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + I18n.t("noteBilingualTitle"));
    const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
    pw.show();

    try {
      progress.setText(I18n.isZh ? "读取全文…" : "Reading full text…");
      progress.setProgress(5);
      const fullText = await AIChat.getFullText(item);
      if (!fullText) throw new Error("NO_PDF");

      const maxChars = Number(Prefs.get("bilingualChunkChars", 1200)) || 1200;
      const chunks = this._chunk(fullText, Math.max(400, maxChars));

      const parts = [];
      let done = 0;
      for (const chunk of chunks) {
        const tgt = await this._translateChunk(chunk, lang);
        // 对照格式：引用块原文 + 译文 + 分隔
        parts.push("> " + chunk.replace(/\n+/g, " ").trim() + "\n\n" + tgt.trim());
        done++;
        progress.setText((I18n.isZh ? "翻译中 " : "Translating ") + done + "/" + chunks.length);
        progress.setProgress(5 + Math.round(done / chunks.length * 90));
        if (done < chunks.length) await new Promise((r) => setTimeout(r, 300));
      }

      const md = (I18n.isZh
        ? `**对照说明**：上为原文（引用块），下为${lang}译文，逐段对应。\n\n`
        : "Source (quote) and translation, paragraph by paragraph.\n\n") +
        parts.join("\n\n---\n\n");
      await Notes.createFromMarkdown(item, `${I18n.t("noteBilingualTitle")}｜${title}`, md);
      progress.setText(I18n.isZh ? `完成：${chunks.length} 段` : `Done: ${chunks.length} chunks`);
      progress.setProgress(100);
    } catch (e) {
      progress.setError();
      progress.setText(e && e.message === "NO_PDF"
        ? I18n.t("chatNoPdf")
        : (I18n.isZh ? "出错：" : "Error: ") + String(e && e.message || e).slice(0, 80));
      Zotero.logError(e);
    }
    pw.startCloseTimer(4000);
  },
};
