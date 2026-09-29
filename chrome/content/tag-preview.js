/* PaperPilot 标签勾选对话框逻辑（modal，经 window.arguments 传参）
 * io = { tags: string[], paperTitle: string, selected: string[]|null }
 */
/* global window, document */

(function () {
  const io = window.arguments && window.arguments[0];
  if (!io) { window.close(); return; }

  const list = document.getElementById("pp-tag-list");
  const titleEl = document.getElementById("pp-tag-title");
  if (titleEl) titleEl.setAttribute("value", io.paperTitle || "");

  const boxes = [];
  for (const tag of io.tags || []) {
    const cb = document.createElementNS("http://www.w3.org/1999/xhtml", "input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.id = "pp-t-" + boxes.length;
    const label = document.createElementNS("http://www.w3.org/1999/xhtml", "label");
    label.setAttribute("for", cb.id);
    label.textContent = " " + tag;
    label.style.cssText = "display:block;padding:2px 0;cursor:pointer;";
    label.insertBefore(cb, label.firstChild);
    list.appendChild(label);
    boxes.push({ cb, tag });
  }

  document.getElementById("pp-tag-all").addEventListener("click", () => {
    for (const b of boxes) b.cb.checked = true;
  });
  document.getElementById("pp-tag-none").addEventListener("click", () => {
    for (const b of boxes) b.cb.checked = false;
  });
  document.getElementById("pp-tag-ok").addEventListener("click", () => {
    io.selected = boxes.filter(b => b.cb.checked).map(b => b.tag);
    window.close();
  });
  document.getElementById("pp-tag-cancel").addEventListener("click", () => {
    io.selected = null;
    window.close();
  });
})();
