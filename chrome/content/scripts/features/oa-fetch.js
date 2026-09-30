/* PaperPilot 开放获取补全文（0.11.0，Unpaywall 合法渠道）
 * 对选中条目中【有 DOI 但无 PDF】者：查 Unpaywall → 找到开放获取 PDF → 导入附件。
 * 明确不接 Sci-Hub 渠道（版权与政策风险）。
 * pref unpaywallEmail：Unpaywall API 要求带 email 参数。
 */
/* global Zotero, Prefs, I18n, ItemSel, CitationColumn */

var OAFetch = {
  API: "https://api.unpaywall.org/v2/",

  /** 从 Unpaywall 响应挑最佳 PDF URL */
  _pickUrl(json) {
    if (!json || typeof json !== "object") return "";
    const loc = json.best_oa_location;
    if (loc && loc.url_for_pdf) return loc.url_for_pdf;
    for (const l of json.oa_locations || []) {
      if (l && l.url_for_pdf) return l.url_for_pdf;
    }
    return (loc && loc.url) || "";
  },

  async _lookup(doi, email) {
    const url = this.API + encodeURIComponent(doi) + "?email=" + encodeURIComponent(email);
    const req = await Zotero.HTTP.request("GET", url, { responseType: "json", timeout: 30000 });
    return req.response;
  },

  /** 单条目补全文；返回 "added" | "has-pdf" | "no-doi" | "not-found" */
  async fill(item, email) {
    // 已有 PDF 跳过
    try {
      for (const id of item.getAttachments()) {
        const a = Zotero.Items.get(id);
        if (a && a.isPDFAttachment && a.isPDFAttachment()) return "has-pdf";
      }
    } catch (e) { /* ignore */ }
    let doi = "";
    try { doi = CitationColumn.normalizeDOI(item.getField("DOI") || ""); } catch (e) { /* ignore */ }
    if (!doi) return "no-doi";

    const json = await this._lookup(doi, email);
    const pdfUrl = this._pickUrl(json);
    if (!pdfUrl) return "not-found";

    await Zotero.Attachments.importFromURL({
      url: pdfUrl,
      parentItemID: item.id,
      title: "Full Text PDF (OA)",
      contentType: "application/pdf",
    });
    return "added";
  },

  /** 菜单入口 */
  async runForSelected() {
    const zp = Zotero.getActiveZoteroPane();
    if (!zp) return;
    const items = ItemSel.regularOnly(zp.getSelectedItems() || []);
    if (!items.length) { ItemSel.alertEmpty(); return; }

    const zh = I18n.isZh;
    const email = (Prefs.get("unpaywallEmail", "") || "").trim() || "paperpilot@users.noreply.local";
    const pw = new Zotero.ProgressWindow({ closeOnClick: true });
    pw.changeHeadline("PaperPilot · " + I18n.t("menuOaFetch"));
    pw.show();
    let nAdded = 0, nHas = 0, nMiss = 0, nNoDoi = 0;
    let first = true;

    for (const item of items) {
      let title = "";
      try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
      const progress = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg", title);
      try {
        progress.setProgress(30);
        const r = await this.fill(item, email);
        if (r === "added") { nAdded++; progress.setText(zh ? "已补全文 PDF" : "PDF added"); }
        else if (r === "has-pdf") { nHas++; progress.setText(zh ? "已有 PDF" : "Has PDF"); }
        else if (r === "no-doi") { nNoDoi++; progress.setText(zh ? "无 DOI" : "No DOI"); }
        else { nMiss++; progress.setText(zh ? "未找到开放获取版本" : "No OA version"); }
        progress.setProgress(100);
      } catch (e) {
        progress.setError();
        progress.setText((zh ? "出错：" : "Error: ") + String(e && e.message || e).slice(0, 60));
        Zotero.logError(e);
      }
      if (!first) await new Promise((r) => setTimeout(r, 600)); // Unpaywall 礼貌限速
      first = false;
    }
    const summary = new pw.ItemProgress("chrome://paperpilot/content/icons/chat.svg",
      (zh ? "合计：补全文 " : "Done: added ") + nAdded +
      (zh ? "，已有 " : ", has ") + nHas +
      (zh ? "，未找到 " : ", miss ") + nMiss +
      (zh ? "，无 DOI " : ", no DOI ") + nNoDoi);
    summary.setProgress(100);
    pw.startCloseTimer(4000);
  },
};
