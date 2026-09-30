pref("extensions.zotero.paperpilot.aiBaseUrl", "http://127.0.0.1:18790/v1");
// 注意：公开仓库不包含任何密钥。安装后请在 编辑→设置→PaperPilot 填写自己的 API Key
pref("extensions.zotero.paperpilot.aiApiKey", "");
pref("extensions.zotero.paperpilot.aiModel", "deepseek-v4-flash");
pref("extensions.zotero.paperpilot.aiSystemPrompt", "你是一个学术研究助手，帮助用户分析论文、解读文献。回复使用中文，除非用户要求其他语言。使用 Markdown 格式输出。");
pref("extensions.zotero.paperpilot.aiMaxTokens", 4096);
// 注意：Mozilla pref 没有浮点类型（int 会截断 0.3→0），温度一律存字符串，代码里 Number() 解析
pref("extensions.zotero.paperpilot.aiTemperature", "0.3");
pref("extensions.zotero.paperpilot.aiFullTextMaxChars", 16000);
pref("extensions.zotero.paperpilot.rankColumnEnabled", true);
pref("extensions.zotero.paperpilot.rankDataPath", "");
// 0.5.0 新增：easyScholar 在线期刊等级（离线 JSON 数据仍为优先兜底）
pref("extensions.zotero.paperpilot.easyScholarEnabled", true);
pref("extensions.zotero.paperpilot.easyScholarKey", "");
// 0.5.0 新增：国产大模型服务商与配置快照
pref("extensions.zotero.paperpilot.aiProvider", "");
pref("extensions.zotero.paperpilot.aiProfiles", "[]");
pref("extensions.zotero.paperpilot.readerPopupEnabled", true);
pref("extensions.zotero.paperpilot.customPrompts", "");
pref("extensions.zotero.paperpilot.matrixMaxItems", 8);
pref("extensions.zotero.paperpilot.autoTagMax", 6);
// 0.6.0 新增：Semantic Scholar 被引量列
pref("extensions.zotero.paperpilot.citationColumnEnabled", true);
pref("extensions.zotero.paperpilot.s2ApiKey", "");
// 无 DOI 的条目是否走标题检索兜底（较慢、可能误配，可关闭）
pref("extensions.zotero.paperpilot.s2TitleSearch", true);
// 0.6.0 新增：规则打标。行格式：标签 | 字段 | 操作 | 值（// 开头为注释）
pref("extensions.zotero.paperpilot.ruleTagRules", "// 每行一条规则：标签 | 字段 | 操作 | 值\n// 字段：title publicationTitle journalAbbreviation abstractNote year itemType DOI creators\n// 操作：contains !contains regex = != > < exists\n// 例：#方法/机器学习 | abstractNote | contains | machine learning\n// 例：#领域/心血管 | publicationTitle | regex | (?i)heart|cardio\n// 例：#近期文献 | year | > | 2023");
pref("extensions.zotero.paperpilot.ruleTagAutoOnNew", false);
// 0.10.0 新增：阅读器划词浮窗 2.0
pref("extensions.zotero.paperpilot.readerPopupAutoTranslate", false);
pref("extensions.zotero.paperpilot.readerPopupTargetLang", "中文");
pref("extensions.zotero.paperpilot.readerPopupStream", true);
pref("extensions.zotero.paperpilot.readerPopupWriteBack", true);
// 每日 AI 请求计数（格式：YYYY-MM-DD:次数），设置面板只读展示
pref("extensions.zotero.paperpilot.readerPopupDailyCount", "");
// 0.11.0 新增：阅读状态 / 全文对照翻译 / 笔记模板 / 附件命名 / Unpaywall / Anki
pref("extensions.zotero.paperpilot.readingStateAutoUnread", true);
pref("extensions.zotero.paperpilot.bilingualChunkChars", 1200);
pref("extensions.zotero.paperpilot.noteTemplatesCustom", "");
pref("extensions.zotero.paperpilot.attachNamePattern", "{author} - {year} - {title}");
pref("extensions.zotero.paperpilot.unpaywallEmail", "");
pref("extensions.zotero.paperpilot.ankiCardCount", 10);
// 0.13.0 新增：工作台 2.0（主题 auto/light/dark；会话持久化 JSON）
pref("extensions.zotero.paperpilot.wbTheme", "auto");
pref("extensions.zotero.paperpilot.workbenchSessions", "");
