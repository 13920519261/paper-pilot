// 0.14.0: 账号系统 + AI 模型通道管理
// 账号服务器（登录/鉴权/官方模型网关同源）；会话令牌存数据目录 JSON，不进 pref
// 0.15.0 起官方账号服务器地址内置固定（https://pp.xinglintools.top）：
// 设置界面不再提供服务器入口，也不开放自建后台；本 pref 仅作高级覆盖用（about:config）
pref("extensions.zotero.paperpilot.accountServerUrl", "https://pp.xinglintools.top");
// 0.15.0 一次性迁移标记：清除指向本地的旧自建后台地址（执行一次后置 true）
pref("extensions.zotero.paperpilot.accountServerMigrated15", false);
// 模型通道注册表 {channels:[{id,name,provider,baseUrl,apiKey,model,models,extraBody,timeoutMs}],active}
// 官方通道(official)的 baseUrl/apiKey 由账号系统运行时注入，不落盘
pref("extensions.zotero.paperpilot.aiChannels", "");
// —— 以下三项为 0.13 及更早的单通道配置，0.14.0 启动时自动迁移为通道，仅作兜底 ——
pref("extensions.zotero.paperpilot.aiBaseUrl", "http://127.0.0.1:8000/v1");
pref("extensions.zotero.paperpilot.aiApiKey", "");
pref("extensions.zotero.paperpilot.aiModel", "auto");
pref("extensions.zotero.paperpilot.aiProvider", "account");
pref("extensions.zotero.paperpilot.aiSystemPrompt", "你是一个学术研究助手，帮助用户分析论文、解读文献。回复使用中文，除非用户要求其他语言。使用 Markdown 格式输出。");
pref("extensions.zotero.paperpilot.aiMaxTokens", 4096);
// 注意：Mozilla pref 没有浮点类型（int 会截断 0.3→0），温度一律存字符串，代码里 Number() 解析
pref("extensions.zotero.paperpilot.aiTemperature", "0.3");
pref("extensions.zotero.paperpilot.aiFullTextMaxChars", 16000);
pref("extensions.zotero.paperpilot.rankColumnEnabled", true);
pref("extensions.zotero.paperpilot.rankDataPath", "");
// 0.5.0 新增：easyScholar 在线期刊等级（离线 JSON 数据仍为优先兜底）
// 0.15.0：内置官方默认 SecretKey（rank-column.js ES_OFFICIAL_KEY，开箱即用）；
// 本 pref 留空 = 使用内置官方 Key；填入自定义值则优先于内置 Key（用户自有额度）
pref("extensions.zotero.paperpilot.easyScholarEnabled", true);
pref("extensions.zotero.paperpilot.easyScholarKey", "");
// 0.18.0 分区列细化：数据集开关（逗号分隔 kind，空=默认集）、badge 数量上限、
// 配色风格（color=分区色阶 / mono=跟随主题强调色）
pref("extensions.zotero.paperpilot.rankDataSets", "");
pref("extensions.zotero.paperpilot.rankMaxBadges", 6);
pref("extensions.zotero.paperpilot.rankBadgeStyle", "color");
// 0.5.0 新增：AI 配置快照(0.14.0 起由模型通道体系取代，仅作迁移数据源)
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
// 0.15.0 新增：浮窗结果区字号缩放（"0.85"/"1"/"1.15"/"1.3"/"1.5"，字符串存法同 aiTemperature）
pref("extensions.zotero.paperpilot.readerPopupFontScale", "1");
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
// 0.14.5 新增：中文转换器/抓取（茉莉花同等能力）
pref("extensions.zotero.paperpilot.cnTranslatorsAuto", true);
pref("extensions.zotero.paperpilot.cnTranslatorUpdateTime", "0");
pref("extensions.zotero.paperpilot.cnFetchUseCNKI", true);
pref("extensions.zotero.paperpilot.cnDownloadDir", "");
// 0.16.1 新增：抓取中文元数据时同时尝试下载 PDF 全文（PubScholar 免费直链 + CNKI 机构权限通道）
pref("extensions.zotero.paperpilot.cnFetchPDF", true);
// 0.14.7 新增：设置界面敏感信息默认掩码（接口地址明文开关）
pref("extensions.zotero.paperpilot.uiShowFullUrl", false);
// 0.16.0 新增：界面主题（"" = 跟随 Zotero 原生；主题 id 见 ui-theme.js THEMES）
// 借鉴 yaobian-zotero（CSS 变量映射换肤）与 zotero-night（Nord 色板）设计
pref("extensions.zotero.paperpilot.uiTheme", "");
// 自定义界面主题色板 JSON：{__dark,background,side,surface,ink,accent,line,select}
// 只填核心角色，toolbar/tab/menu/ink2/ink3 等由模块运行时派生（yaobian 思路）
pref("extensions.zotero.paperpilot.uiThemeCustom", "");
// 0.16.0 新增：PDF 阅读主题（default/careeye/sepia/sakura/mint/night/night-warm/custom）
// 借鉴 zotero-pdf-background（textLayer 半透明叠色 + 阅读器工具栏按钮）
// 与 zotero-night（canvas invert 反色夜间模式）
pref("extensions.zotero.paperpilot.pdfTheme", "default");
// 0.17.0 壁纸语义重构：主题=配色+壁纸一体包
// "theme"（默认）= 用主题包自带壁纸；"off" = 关闭壁纸纯色主题；"custom" = 自定义文件
// （0.16.1 的 auto/内置壁纸 id/"" 由 UiTheme.migrateLegacy 一次性迁移，幂等）
pref("extensions.zotero.paperpilot.uiWallpaper", "theme");
// custom 壁纸的本地文件路径（图片 jpg/png/webp/gif/bmp 或视频 mp4/webm/mkv/mov）
pref("extensions.zotero.paperpilot.uiWallpaperPath", "");
// 0.18.0 新增：在线壁纸 URL（图片或视频直链；优先于本地路径，下载缓存到数据目录）
pref("extensions.zotero.paperpilot.uiWallpaperUrl", "");
// 壁纸可见度 10-90（越大面板越透、壁纸越明显；主题可带推荐值，用户滑条可覆盖）
pref("extensions.zotero.paperpilot.uiWallpaperOpacity", 70);
// 自定义 PDF 叠色：颜色 + 不透明度（5-60，百分整数；Mozilla pref 无浮点）
pref("extensions.zotero.paperpilot.pdfThemeCustomColor", "#578f32");
pref("extensions.zotero.paperpilot.pdfThemeCustomOpacity", 30);
