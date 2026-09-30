/* PaperPilot AI 客户端：OpenAI 兼容接口（/chat/completions）
 * 兼容 OpenAI / DeepSeek / 通义 / 月之暗面 / SiliconFlow / 本地网关等
 */
/* global Zotero, Prefs, fetch, AbortController, TextDecoder, setTimeout, clearTimeout */

var AIClient = {
  _endpoint() {
    return this.baseUrl() + "/chat/completions";
  },

  baseUrl() {
    return (Prefs.get("aiBaseUrl", "") || "").replace(/\/+$/, "");
  },

  model() {
    return Prefs.get("aiModel", "");
  },

  hasKey() {
    return !!Prefs.get("aiApiKey", "");
  },

  /**
   * @param {Array<{role:string, content:string}>} messages
   * @returns {Promise<string>} 助手回复文本
   */
  async chat(messages) {
    const apiKey = Prefs.get("aiApiKey", "");
    if (!apiKey) throw new Error("NO_API_KEY");

    const temperature = Number(Prefs.get("aiTemperature", 0.3));
    const payload = {
      model: Prefs.get("aiModel", "gpt-4o-mini"),
      messages,
      temperature: isNaN(temperature) ? 0.3 : Math.min(2, Math.max(0, temperature)),
      max_tokens: Number(Prefs.get("aiMaxTokens", 4096)) || 4096,
    };

    let req;
    try {
      req = await Zotero.HTTP.request("POST", this._endpoint(), {
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify(payload),
        responseType: "json",
        timeout: 180000,
      });
    } catch (e) {
      throw this._wrapError(e);
    }

    const data = req.response;
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    if (!content) throw new Error("AI 返回内容为空");
    return content;
  },

  /**
   * 流式问答（0.10.0 新增）：fetch + 手工 SSE 解析。
   * Zotero.HTTP 不支持流式，必须走 bootstrap 作用域的 fetch（Z7 FF115+/Z10 均有）。
   * 网关不透传 SSE 时自动降级为一次性读取，用户体验与 chat() 一致，不会更差。
   * @param messages 同 chat()
   * @param onDelta (textChunk) => void 每收到一段增量即回调
   * @returns {{promise: Promise<string>, abort: Function}} promise 解析为完整回复
   */
  chatStream(messages, onDelta) {
    const controller = (typeof AbortController === "function") ? new AbortController() : null;
    const promise = this._streamImpl(messages, onDelta, controller);
    return {
      promise,
      abort() { try { if (controller) controller.abort(); } catch (e) { /* ignore */ } },
    };
  },

  async _streamImpl(messages, onDelta, controller) {
    const apiKey = Prefs.get("aiApiKey", "");
    if (!apiKey) throw new Error("NO_API_KEY");

    // 流式总开关 / fetch 不可用：整体回退非流式（走完再一次性回调）
    const wantStream = Prefs.get("readerPopupStream", true) !== false &&
      typeof fetch === "function" && !!controller;
    if (!wantStream) {
      const full = await this.chat(messages);
      if (onDelta) try { onDelta(full); } catch (e) { /* UI 回调不得拖死流程 */ }
      return full;
    }

    const temperature = Number(Prefs.get("aiTemperature", 0.3));
    const payload = {
      model: Prefs.get("aiModel", "gpt-4o-mini"),
      messages,
      temperature: isNaN(temperature) ? 0.3 : Math.min(2, Math.max(0, temperature)),
      max_tokens: Number(Prefs.get("aiMaxTokens", 4096)) || 4096,
      stream: true,
    };

    // 首字节 30s（防非流式网关挂死）+ 总计 180s（与 chat() 对齐）。
    // FF115 没有 signal.reason，用标志位区分超时与外部 abort。
    let timedOut = false;
    const firstByteTimer = setTimeout(() => {
      timedOut = "first";
      try { controller.abort(); } catch (e) { /* ignore */ }
    }, 30000);
    const totalTimer = setTimeout(() => {
      timedOut = "total";
      try { controller.abort(); } catch (e) { /* ignore */ }
    }, 180000);
    const clearTimers = () => { clearTimeout(firstByteTimer); clearTimeout(totalTimer); };

    try {
      const resp = await fetch(this._endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!resp.ok) {
        let detail = "";
        try {
          const txt = await resp.text();
          try {
            const j = JSON.parse(txt);
            detail = (j && j.error && (j.error.message || j.error)) || txt;
          } catch (e) { detail = txt; }
        } catch (e) { /* ignore */ }
        throw this._httpStatusError(resp.status, detail);
      }

      // 网关不透传 SSE：按普通 JSON 一次性读取，降级但行为正确
      const ctype = resp.headers.get("content-type") || "";
      if (!ctype.includes("event-stream") || !resp.body) {
        const data = await resp.json();
        const content = data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content : "";
        if (!content) throw new Error("AI 返回内容为空");
        if (onDelta) try { onDelta(content); } catch (e) { /* ignore */ }
        return content;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      let full = "";
      let gotFirst = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!gotFirst) { gotFirst = true; clearTimeout(firstByteTimer); }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta &&
              j.choices[0].delta.content;
            if (delta) {
              full += delta;
              if (onDelta) try { onDelta(delta); } catch (e) { /* ignore */ }
            }
          } catch (e) { /* 半帧 JSON 忽略，等下一帧拼齐 */ }
        }
      }
      if (!full) throw new Error("AI 返回内容为空");
      return full;
    } catch (e) {
      clearTimers();
      if (controller.signal.aborted) {
        if (timedOut) throw new Error("AI 请求失败：请求超时");
        throw new Error("ABORTED"); // 外部主动取消：调用方静默处理
      }
      if (e && e._ppWrapped) throw e;
      throw this._wrapError(e);
    } finally {
      clearTimers();
    }
  },

  /** fetch 流式路径的 HTTP 状态错误（与 _wrapError 文案对齐） */
  _httpStatusError(status, detail) {
    detail = String(detail || "").slice(0, 300);
    let msg;
    if (status === 401 || status === 403) msg = `API Key 无效或未授权（HTTP ${status}）`;
    else if (status === 429) msg = "请求过于频繁或额度不足（HTTP 429）";
    else msg = `HTTP ${status}`;
    const err = new Error(`AI 请求失败：${msg}${detail ? "（" + detail + "）" : ""}`);
    err._ppWrapped = true;
    return err;
  },

  /** 把 Zotero.HTTP 异常翻译为可读错误 */
  _wrapError(e) {
    let detail = "";
    try {
      const resp = e.xmlhttp && e.xmlhttp.response;
      detail = (resp && resp.error && (resp.error.message || resp.error)) || e.xmlhttp.responseText || "";
    } catch (_) { /* ignore */ }
    if (typeof detail !== "string") detail = "";
    detail = detail.slice(0, 300);

    let msg = (e && e.message) || String(e);
    const status = e && e.xmlhttp && e.xmlhttp.status;
    if (/timed?\s*out|timeout/i.test(msg)) msg = "请求超时";
    else if (status === 401 || status === 403) msg = `API Key 无效或未授权（HTTP ${status}）`;
    else if (status === 429) msg = "请求过于频繁或额度不足（HTTP 429）";
    else if (status) msg = `HTTP ${status}`;

    return new Error(`AI 请求失败：${msg}${detail ? "（" + detail + "）" : ""}`);
  },
};
