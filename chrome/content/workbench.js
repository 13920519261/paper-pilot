/* PaperPilot 工作台逻辑（独立窗口，0.9.0）
 * 与主应用的数据同步方式：
 *  - 窗口内所有 Zotero 操作都经 window.opener.Zotero 走主应用同一个
 *    XPCOM 实例（同一进程、同一数据库连接）——条目数据每次操作现读，
 *    天然同步；saveTx 写入由 Notifier 驱动主窗口 UI 自动刷新。
 *  - “跟随主窗口选中”= 1.5s 轮询主窗口选中条目（轻量，仅取 id 对比）。
 * 生命周期：
 *  - 单实例：openWorkbench() 里按 windowtype 枚举，已有则 focus；
 *  - 主窗口关闭 → 本窗口自动关闭（opener unload 监听 + 轮询兜底）；
 *  - 位置/大小由窗口 persist 属性记忆。
 */
/* global window, document */

(function () {
  const XHTML = "http://www.w3.org/1999/xhtml";

  function boot() {
    let Services, opener, Zotero, PP, zh;
    try {
      // ⚠️ 窗口作用域里 ChromeUtils.importESModule("…/Services.sys.mjs") 会失败，
      // window.Services 也未必有——Services/Zotero 都经 window.arguments 传入
      // （openWorkbench 传的 {Zotero, Services}）
      const args = window.arguments && window.arguments[0];
      Services = (args && args.Services) || window.Services;
      Zotero = (args && args.Zotero) || (window.opener && window.opener.Zotero);
      opener = window.opener;
      if (!Services || !Zotero || !Zotero.PaperPilot) {
        showError("无法获取依赖（Services=" + typeof Services + ", Zotero=" + typeof Zotero + "）");
        return;
      }
      PP = Zotero.PaperPilot;
      zh = (Zotero.locale || "").toLowerCase().startsWith("zh");
    } catch (e) {
      showError("初始化异常：" + (e && (e.message || e)));
      return;
    }

    try {
      _run(Services, opener, Zotero, PP, zh);
    } catch (e) {
      // 初始化失败：错误写进对话区 + Zotero 日志，不再无声死掉
      try { Zotero.logError(new Error("PaperPilot workbench init FAILED: " + (e && (e.stack || e.message) || e))); } catch (_) {}
      showError("工作台初始化失败：" + (e && (e.message || e) || e));
    }
  }

  function showError(text) {
    try {
      const d = document.createElementNS(XHTML, "div");
      d.style.cssText = "color:#c0392b;font-size:12px;padding:8px;";
      d.textContent = text;
      const box = document.getElementById("pp-wb-msgs");
      if (box) box.appendChild(d);
    } catch (_) {}
  }

  function _run(Services, opener, Zotero, PP, zh) {
    /* ---------- 状态 ---------- */
    let currentItem = null;
    let history = [];       // {role, content}，最多 12 条滚动窗口
    let transcript = [];    // 完整对话记录（存笔记用）
    let busy = false;
    let followTimer = null;
    let contextItem = null; // 已注入对话上下文的条目（切条目后重注）

    const $ = (id) => document.getElementById(id);
    const msgs = $("pp-wb-msgs");
    const status = $("pp-wb-status");

    function setStatus(t) { status.textContent = t || ""; }

    /* ---------- 轻量 Markdown → HTML（AI 气泡渲染用，0.9.1） ---------- */

    function esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function mdInline(s) {
      return esc(s)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
        .replace(/`([^`\n]+)`/g, "<code style='background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:12px;'>$1</code>")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
          "<a href='$2' style='color:#2563eb;'>$1</a>");
    }

    /** md 块级渲染：标题/列表/表格/引用/分隔线/段落（AI 回复够用） */
    function mdToHtml(md) {
      const lines = String(md || "").split(/\r?\n/);
      let html = "";
      let inUl = false, inOl = false, para = [], table = [];
      const closeLists = () => {
        if (inUl) { html += "</ul>"; inUl = false; }
        if (inOl) { html += "</ol>"; inOl = false; }
      };
      const flushPara = () => {
        if (para.length) { html += "<p style='margin:4px 0;'>" + para.join("<br/>") + "</p>"; para = []; }
      };
      const flushTable = () => {
        if (!table.length) return;
        const rows = table.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l));
        if (rows.length) {
          html += "<div style='overflow-x:auto;margin:6px 0;'>";
          html += "<table style='border-collapse:collapse;font-size:12px;'>";
          rows.forEach((l, idx) => {
            const cells = l.trim().replace(/^\||\|$/g, "").split("|");
            const tag = idx === 0 ? "th" : "td";
            html += "<tr>" + cells.map((c) =>
              `<${tag} style='border:1px solid #ddd;padding:4px 8px;text-align:left;${idx === 0 ? "background:#f5f5f5;" : ""}'>${mdInline(c.trim())}</${tag}>`).join("") + "</tr>";
          });
          html += "</table></div>";
        }
        table = [];
      };
      for (const raw of lines) {
        const line = raw.replace(/\s+$/, "");
        if (/^\s*\|.+\|\s*$/.test(line)) { flushPara(); closeLists(); table.push(line); continue; }
        flushTable();
        const h = line.match(/^\s*#{1,4}\s+(.+)$/);
        const ul = line.match(/^\s*[-*•]\s+(.+)$/);
        const ol = line.match(/^\s*\d+[.)]\s+(.+)$/);
        if (h) {
          flushPara(); closeLists();
          const sizes = ["15px", "14px", "13.5px", "13px"];
          const lv = Math.min(h[0].trim().split(/\s+/)[0].length, 4);
          html += `<div style='font-weight:700;font-size:${sizes[lv - 1]};margin:8px 0 4px;'>${mdInline(h[1])}</div>`;
        } else if (ul) {
          flushPara();
          if (inOl) { html += "</ol>"; inOl = false; }
          if (!inUl) { html += "<ul style='margin:4px 0;padding-left:20px;'>"; inUl = true; }
          html += "<li style='margin:2px 0;'>" + mdInline(ul[1]) + "</li>";
        } else if (ol) {
          flushPara();
          if (inUl) { html += "</ul>"; inUl = false; }
          if (!inOl) { html += "<ol style='margin:4px 0;padding-left:22px;'>"; inOl = true; }
          html += "<li style='margin:2px 0;'>" + mdInline(ol[1]) + "</li>";
        } else if (!line.trim()) {
          flushPara(); closeLists();
        } else if (/^\s*>/.test(line)) {
          flushPara(); closeLists();
          html += "<blockquote style='border-left:3px solid #bbb;margin:4px 0;padding:2px 10px;color:#555;'>" + mdInline(line.replace(/^\s*>\s?/, "")) + "</blockquote>";
        } else if (/^\s*---+\s*$/.test(line)) {
          flushPara(); closeLists();
          html += "<hr style='border:none;border-top:1px solid #ddd;margin:8px 0;'/>";
        } else {
          closeLists();
          para.push(mdInline(line));
        }
      }
      flushTable();
      flushPara(); closeLists();
      return html;
    }

    /** 气泡：AI 消息（isMd）渲染 Markdown；用户消息纯文本。
     *  noRecord=true 用于“思考中”占位——不进 transcript。 */
    function addBubble(role, text, isMd, noRecord) {
      const wrap = document.createElementNS(XHTML, "div");
      wrap.style.cssText = role === "user"
        ? "display:flex;justify-content:flex-end;margin:6px 0;"
        : "display:flex;justify-content:flex-start;margin:6px 0;";
      const b = document.createElementNS(XHTML, "div");
      b.style.cssText = role === "user"
        ? "max-width:78%;background:#2563eb;color:#fff;padding:8px 12px;border-radius:10px 10px 2px 10px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.6;"
        : "max-width:88%;background:#fff;border:1px solid #ddd;padding:8px 12px;border-radius:10px 10px 10px 2px;font-size:13px;line-height:1.6;word-break:break-word;";
      if (isMd) b.innerHTML = mdToHtml(text);
      else b.textContent = text;
      wrap.appendChild(b);
      msgs.appendChild(wrap);
      msgs.scrollTop = msgs.scrollHeight;
      // transcript 存 md 原文（存笔记走 MdLite 渲染）；占位不记录
      if (!noRecord) transcript.push({ role, text });
      return b;
    }

    function addNotice(text) {
      const d = document.createElementNS(XHTML, "div");
      d.style.cssText = "text-align:center;color:#999;font-size:12px;margin:4px 0;";
      d.textContent = text;
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
    }

    /* ---------- 条目上下文 ---------- */

    function itemMetaLine(item) {
      try {
        const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
        const year = String(get("date")).match(/(\d{4})/);
        const bits = [];
        if (get("publicationTitle")) bits.push(get("publicationTitle"));
        if (year) bits.push(year[1]);
        const c = item.getCreators()[0];
        if (c && c.lastName) bits.push(c.lastName + (item.getCreators().length > 1 ? " 等" : ""));
        return bits.join(" · ");
      } catch (e) { return ""; }
    }

    function setItem(item) {
      const changed = !item || !currentItem || item.id !== currentItem.id;
      currentItem = item;
      if (item) {
        let title = "";
        try { title = item.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
        $("pp-wb-item-title").textContent = title || "(no title)";
        $("pp-wb-item-meta").textContent = itemMetaLine(item);
      } else {
        $("pp-wb-item-title").textContent = zh ? "（未选择条目）" : "(No item)";
        $("pp-wb-item-meta").textContent = "";
      }
      if (changed && transcript.length) {
        addNotice(zh ? "—— 条目已切换，后续提问针对新条目 ——" : "—— item switched ——");
      }
    }

    /** 主窗口选中 → 常规条目（附件上溯父条目） */
    function followSelection() {
      if (busy || !$("pp-wb-follow").checked) return;
      try {
        if (!opener || opener.closed) { window.close(); return; }
        const zp = Zotero.getActiveZoteroPane();
        if (!zp) return;
        const sel = zp.getSelectedItems() || [];
        let it = null;
        for (const i of sel) {
          try {
            if (i.isRegularItem && i.isRegularItem()) { it = i; break; }
            if (i.isAttachment && i.isAttachment() && i.parentID) {
              const p = Zotero.Items.get(i.parentID);
              if (p && p.isRegularItem && p.isRegularItem()) { it = p; break; }
            }
          } catch (e) { /* ignore */ }
        }
        if ((it && !currentItem) || (!it && currentItem)
          || (it && currentItem && it.id !== currentItem.id)) {
          setItem(it);
        }
      } catch (e) { /* 主窗口切换瞬间可能拿不到 pane，忽略 */ }
    }

    /** 手动选条目：关键词 → 标题检索 → 单选/列表选 */
    async function pickItem() {
      const input = { value: "" };
      if (!Services.prompt.prompt(window, "PaperPilot",
        zh ? "输入标题关键词检索文献：" : "Search items by title keyword:", input)) return;
      const kw = (input.value || "").trim();
      if (!kw) return;
      try {
        const s = new Zotero.Search();
        s.libraryID = Zotero.Libraries.userLibraryID;
        s.addCondition("title", "contains", kw);
        s.addCondition("itemType", "isNot", "attachment");
        const ids = await s.search();
        if (!ids.length) {
          Services.prompt.alert(window, "PaperPilot", zh ? "没有匹配的条目" : "No matching items");
          return;
        }
        if (ids.length === 1) {
          setItem(await Zotero.Items.getAsync(ids[0]));
          return;
        }
        const items = [];
        for (const id of ids.slice(0, 10)) items.push(await Zotero.Items.getAsync(id));
        const titles = items.map((i) => {
          let t = "";
          try { t = i.getDisplayTitle() || ""; } catch (e) { /* ignore */ }
          return t.length > 70 ? t.slice(0, 70) + "…" : t;
        });
        const out = { value: 0 };
        if (Services.prompt.select(window, "PaperPilot",
          zh ? `找到 ${ids.length} 篇，选择：` : `Found ${ids.length}, pick one:`,
          titles.length, titles, out)) {
          setItem(items[out.value]);
        }
      } catch (e) {
        Services.prompt.alert(window, "PaperPilot", String(e && e.message || e));
      }
    }

    /* ---------- AI 对话 ---------- */

    async function buildContext(item) {
      const get = (f) => { try { return item.getField(f) || ""; } catch (e) { return ""; } };
      let ctx = `【论文题录】\n标题：${get("title")}\n作者：${(item.getCreators() || [])
        .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")).slice(0, 8).join(", ")}\n` +
        `期刊：${get("publicationTitle")}  年份：${String(get("date")).slice(0, 4)}`;
      let body = "";
      try {
        body = get("abstractNote") || (await PP.aiChat.getFullText(item)) || "";
      } catch (e) { /* ignore */ }
      if (body) ctx += `\n【正文材料】\n${body.slice(0, 16000)}`;
      return ctx;
    }

    async function send() {
      if (busy) return;
      const text = $("pp-wb-input").value.trim();
      if (!text) return;
      $("pp-wb-input").value = "";
      addBubble("user", text);
      await runChat(text);
    }

    async function runChat(question) {
      busy = true;
      $("pp-wb-send").disabled = true;
      document.querySelectorAll(".pp-wb-act").forEach((b) => { b.disabled = true; });
      const bubble = addBubble("ai", zh ? "AI 思考中…" : "AI is thinking…", false, true);
      setStatus(zh ? "AI 思考中…" : "Thinking…");
      try {
        const messages = [];
        const sys = Zotero.Prefs.get("extensions.zotero.paperpilot.aiSystemPrompt", true) || "";
        if (sys) messages.push({ role: "system", content: sys });
        // 条目上下文：切换条目或首轮注入
        if (currentItem && contextItem !== currentItem) {
          contextItem = currentItem;
          history = []; // 换条目，旧对话不再延续
          const ctx = await buildContext(currentItem);
          messages.push({ role: "user", content: zh
            ? "以下是背景材料，之后的提问都围绕它：\n\n" + ctx
            : "Background material for the following questions:\n\n" + ctx });
          messages.push({ role: "assistant", content: zh ? "好的，已了解该文献。" : "Got it." });
        }
        for (const m of history) messages.push({ role: m.role, content: m.content });
        messages.push({ role: "user", content: question });
        const reply = await PP.aiClient.chat(messages);
        bubble.innerHTML = mdToHtml(reply);
        transcript.push({ role: "ai", text: reply });
        history.push({ role: "user", content: question }, { role: "assistant", content: reply });
        if (history.length > 12) history = history.slice(-12);
        setStatus("");
      } catch (e) {
        bubble.textContent = (zh ? "出错：" : "Error: ") + (e && e.message || e);
        setStatus(zh ? "请求失败" : "Failed");
      } finally {
        busy = false;
        $("pp-wb-send").disabled = false;
        document.querySelectorAll(".pp-wb-act").forEach((b) => { b.disabled = false; });
        msgs.scrollTop = msgs.scrollHeight;
      }
    }

    async function quickAction(act) {
      if (busy) return;
      if (!currentItem) {
        Services.prompt.alert(window, "PaperPilot",
          zh ? "请先选择条目（跟随主窗口选中，或点「选择条目…」）" : "Select an item first");
        return;
      }
      const labels = {
        summary: zh ? "【快捷】总结本文" : "[Quick] Summarize",
        translate: zh ? "【快捷】翻译标题与摘要" : "[Quick] Translate",
        interpret: zh ? "【快捷】深度解读" : "[Quick] Interpret",
      };
      addBubble("user", labels[act] || act);
      busy = true;
      $("pp-wb-send").disabled = true;
      document.querySelectorAll(".pp-wb-act").forEach((b) => { b.disabled = true; });
      const bubble = addBubble("ai", zh ? "AI 思考中…" : "AI is thinking…", false, true);
      setStatus(zh ? "AI 思考中…" : "Thinking…");
      try {
        const fns = {
          summary: () => PP.aiChat.summarize(currentItem),
          translate: () => PP.aiChat.translateTitleAbstract(currentItem),
          interpret: () => PP.aiChat.interpret(currentItem),
        };
        const reply = await (fns[act] || fns.summary)();
        bubble.innerHTML = mdToHtml(reply);
        transcript.push({ role: "ai", text: reply });
        setStatus("");
      } catch (e) {
        bubble.textContent = (zh ? "出错：" : "Error: ") + (e && e.message || e);
        setStatus(zh ? "请求失败" : "Failed");
      } finally {
        busy = false;
        $("pp-wb-send").disabled = false;
        document.querySelectorAll(".pp-wb-act").forEach((b) => { b.disabled = false; });
        msgs.scrollTop = msgs.scrollHeight;
      }
    }

    /* ---------- 存为笔记 / 清空 ---------- */

    async function saveNote() {
      if (!transcript.some((t) => t.role === "ai")) {
        Services.prompt.alert(window, "PaperPilot", zh ? "还没有可保存的对话" : "Nothing to save yet");
        return;
      }
      try {
        const md = transcript.map((t) =>
          (t.role === "user" ? "**🧑 问：**\n" : "**🤖 答：**\n") + t.text).join("\n\n---\n\n");
        const date = new Date().toISOString().slice(0, 10);
        if (currentItem) {
          await PP.notes.createFromMarkdown(currentItem,
            (zh ? "工作台对话｜" : "Workbench Chat | ") + date, md);
        } else {
          const note = new Zotero.Item("note");
          note.libraryID = Zotero.Libraries.userLibraryID;
          note.setNote(PP.mdLite.toNoteHtml((zh ? "工作台对话｜" : "Workbench Chat | ") + date, md));
          await note.saveTx();
        }
        setStatus(zh ? "✓ 已保存为笔记" : "✓ Saved as note");
      } catch (e) {
        Services.prompt.alert(window, "PaperPilot", String(e && e.message || e));
      }
    }

    function clearChat() {
      history = [];
      transcript = [];
      contextItem = null;
      msgs.innerHTML = "";
      setStatus("");
    }

    /* ---------- 装配 ---------- */

    $("pp-wb-send").addEventListener("click", send);
    $("pp-wb-input").addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) {
        ev.preventDefault();
        send();
      }
    });
    $("pp-wb-pick").addEventListener("click", () => pickItem());
    $("pp-wb-save").addEventListener("click", () => saveNote());
    $("pp-wb-clear").addEventListener("click", clearChat);
    document.querySelectorAll(".pp-wb-act").forEach((b) =>
      b.addEventListener("click", () => quickAction(b.dataset.act)));

    // 跟随轮询 + 生命周期清理
    followTimer = setInterval(followSelection, 1500);
    followSelection();
    addNotice(zh ? "PaperPilot 工作台 · 独立窗口，跟随主窗口选中条目" : "PaperPilot Workbench");

    // 主窗口关闭 → 本窗口关闭（unload 在窗口销毁与应用退出时都会触发）
    try {
      opener.addEventListener("unload", () => window.close(), { once: true });
    } catch (e) { /* ignore */ }
    window.addEventListener("unload", () => {
      if (followTimer) { clearInterval(followTimer); followTimer = null; }
    });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    boot();
  } else {
    window.addEventListener("load", boot, { once: true });
  }
})();
