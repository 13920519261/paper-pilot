/* PaperPilot 阅读器划词浮窗：划词弹窗中注入「翻译 / 解读」
 * 官方 API：Zotero.Reader.registerEventListener("renderTextSelectionPopup", handler, pluginID)
 */
/* global Zotero, Prefs, AIClient, I18n */

var ReaderPopup = {
  _handler: null,
  _pluginID: null,

  register(pluginID) {
    if (this._handler) return;
    this._pluginID = pluginID;
    this._handler = (event) => this._onPopup(event);
    try {
      Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._handler, pluginID);
    } catch (e) {
      Zotero.logError(new Error("PaperPilot: 划词浮窗注册失败"));
      Zotero.logError(e);
      this._handler = null;
    }
  },

  unregister() {
    if (!this._handler) return;
    try {
      Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._handler);
    } catch (e) { /* ignore */ }
    this._handler = null;
  },

  _onPopup(event) {
    try {
      if (!Prefs.get("readerPopupEnabled", true)) return;
      const { doc, params, append } = event;
      const text =
        (params && params.annotation && params.annotation.text) ||
        (params && params.text) || "";
      if (!text || text.trim().length < 2) return;
      if (!AIClient.hasKey()) return;

      const NS = "http://www.w3.org/1999/xhtml";
      const box = doc.createElementNS(NS, "div");
      box.style.cssText =
        "max-width:380px;padding:2px 4px;display:flex;flex-direction:column;gap:4px;" +
        "font-size:12px;line-height:1.5;text-align:left;";

      const row = doc.createElementNS(NS, "div");
      row.style.cssText = "display:flex;gap:6px;align-items:center;";
      const mkBtn = (label) => {
        const b = doc.createElementNS(NS, "button");
        b.textContent = label;
        b.style.cssText = "padding:1px 10px;font-size:12px;cursor:pointer;";
        return b;
      };
      const trBtn = mkBtn(I18n.t("popupTranslate"));
      const aiBtn = mkBtn(I18n.t("popupExplain"));
      const src = doc.createElementNS(NS, "span");
      src.style.cssText = "color:#888;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      src.textContent = text.trim().slice(0, 40) + (text.trim().length > 40 ? "…" : "");
      row.appendChild(trBtn);
      row.appendChild(aiBtn);
      row.appendChild(src);

      const result = doc.createElementNS(NS, "div");
      result.style.cssText =
        "display:none;white-space:pre-wrap;word-break:break-word;max-height:220px;" +
        "overflow-y:auto;border-top:1px solid #8884;padding-top:4px;";

      box.appendChild(row);
      box.appendChild(result);

      const run = async (mode) => {
        result.style.display = "block";
        result.textContent = I18n.t("chatThinking");
        trBtn.disabled = true;
        aiBtn.disabled = true;
        try {
          const q = mode === "translate"
            ? (I18n.isZh
                ? "请将以下内容翻译成中文，忠实原文，专业术语保留英文并用括号标注，只输出译文：\n\n"
                : "Translate the following into Chinese, keep English terms in parentheses, output translation only:\n\n")
            : (I18n.isZh
                ? "请用中文简要解读以下摘自论文的内容（含义、在论文语境中的作用），100-200 字：\n\n"
                : "Briefly explain the following excerpt from a paper in Chinese (100-200 chars):\n\n");
          const answer = await AIClient.chat([
            { role: "system", content: Prefs.get("aiSystemPrompt", "") || "" },
            { role: "user", content: q + text },
          ]);
          result.textContent = answer;
        } catch (e) {
          result.textContent = I18n.t("errPrefix") + (e.message || e);
        } finally {
          trBtn.disabled = false;
          aiBtn.disabled = false;
        }
      };
      trBtn.addEventListener("click", () => run("translate"));
      aiBtn.addEventListener("click", () => run("explain"));

      append(box);
    } catch (e) {
      Zotero.logError(e);
    }
  },
};
