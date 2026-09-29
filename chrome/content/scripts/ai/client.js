/* PaperPilot AI 客户端：OpenAI 兼容接口（/chat/completions）
 * 兼容 OpenAI / DeepSeek / 通义 / 月之暗面 / SiliconFlow / 本地网关等
 */
/* global Zotero, Prefs */

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
