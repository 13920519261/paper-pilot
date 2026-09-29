/* PaperPilot 参考文献勾选入库对话框（modal，window.arguments 传参）
 * io = { refs: [{title,year,venue,citationCount,doi}], paperTitle, total,
 *        selected: number[]|null（输出：勾中的 refs 下标） }
 */
/* global window, document */

(function () {
  const io = window.arguments && window.arguments[0];
  if (!io) { window.close(); return; }

  const list = document.getElementById("pp-refs-list");
  const titleEl = document.getElementById("pp-refs-title");
  const subEl = document.getElementById("pp-refs-sub");
  const countEl = document.getElementById("pp-refs-count");
  if (titleEl) titleEl.setAttribute("value", "来源：" + (io.paperTitle || ""));
  if (subEl) subEl.setAttribute("value",
    `共 ${io.total} 篇参考文献，其中 ${(io.refs || []).length} 篇不在本地文库（按被引量降序），勾选导入：`);

  const boxes = [];
  const XHTML = "http://www.w3.org/1999/xhtml";
  (io.refs || []).forEach((ref, idx) => {
    const cb = document.createElementNS(XHTML, "input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.id = "pp-r-" + idx;
    const label = document.createElementNS(XHTML, "label");
    label.setAttribute("for", cb.id);
    label.style.cssText = "display:block;padding:3px 0;cursor:pointer;border-bottom:1px solid #eee;";
    const bits = [];
    if (ref.year) bits.push(ref.year);
    if (ref.venue) bits.push(ref.venue);
    if (typeof ref.citationCount === "number") bits.push("被引 " + ref.citationCount);
    label.textContent = " " + (ref.title || "(no title)") +
      (bits.length ? "（" + bits.join("，") + "）" : "");
    label.insertBefore(cb, label.firstChild);
    list.appendChild(label);
    boxes.push({ cb, idx });
  });

  const updateCount = () => {
    countEl.textContent = "已选 " + boxes.filter(b => b.cb.checked).length + " 篇";
  };
  updateCount();
  for (const b of boxes) b.cb.addEventListener("change", updateCount);

  document.getElementById("pp-refs-all").addEventListener("click", () => {
    for (const b of boxes) { b.cb.checked = true; }
    updateCount();
  });
  document.getElementById("pp-refs-none").addEventListener("click", () => {
    for (const b of boxes) { b.cb.checked = false; }
    updateCount();
  });
  document.getElementById("pp-refs-ok").addEventListener("click", () => {
    io.selected = boxes.filter(b => b.cb.checked).map(b => b.idx);
    window.close();
  });
  document.getElementById("pp-refs-cancel").addEventListener("click", () => {
    io.selected = null;
    window.close();
  });
})();
