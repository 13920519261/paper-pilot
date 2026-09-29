/* PaperPilot 分类条目统计：递归统计当前分类（含子分类）的条目数 */
/* global Zotero, Services, I18n */

var CollectionStats = {
  /** 递归计数，返回 {total, lines:[{depth, name, count}]} */
  _count(col, depth, lines) {
    let own = 0;
    try { own = (col.getChildItems() || []).length; } catch (e) { /* ignore */ }
    let total = own;
    let children = [];
    try { children = col.getChildCollections() || []; } catch (e) { /* ignore */ }
    for (const c of children) {
      total += this._count(c, depth + 1, lines);
    }
    lines.push({ depth, name: col.name || "", own, total });
    return total;
  },

  /** 取当前选中分类（Z10 单数 getter 已废弃会抛错，用复数 API） */
  _getSelectedCollection(zp) {
    try {
      if (zp.getSelectedCollections) {
        const cols = zp.getSelectedCollections() || [];
        if (cols.length) return cols[0];
      }
    } catch (e) { /* ignore */ }
    try {
      if (zp.getSelectedCollection) return zp.getSelectedCollection();
    } catch (e) { /* Z10 单数 getter 抛错 */ }
    return null;
  },

  /** 菜单入口：对当前选中分类弹窗展示统计 */
  showForSelectedCollection() {
    const win = Zotero.getMainWindow();
    const zp = Zotero.getActiveZoteroPane();
    const col = zp && this._getSelectedCollection(zp);
    if (!col) {
      Services.prompt.alert(win, "PaperPilot",
        I18n.isZh ? "请先在左侧选中一个分类" : "Please select a collection first");
      return;
    }
    const lines = [];
    this._count(col, 0, lines);
    const text = lines
      .slice(0, 40)
      .map(l => `${"　".repeat(l.depth)}${l.name}：${l.own} 篇（含子分类共 ${l.total} 篇）`)
      .join("\n") + (lines.length > 40 ? `\n……（共 ${lines.length} 个分类，仅显示前 40 行）` : "");
    Services.prompt.alert(win, "PaperPilot · " + (I18n.isZh ? "分类条目统计" : "Collection Stats"), text);
  },
};
