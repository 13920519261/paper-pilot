/* PaperPilot 主入口：装配各模块
 * 由 bootstrap.js 通过 Services.scriptloader 加载，共享 bootstrap 作用域
 */
/* global Zotero, Services, Prefs, RankColumn, CitationColumn, S2Client, AIChatPane, Menus, ReaderPopup, AIProviders, RuleTag, CitationTrace, FakeCheck, SmartCleanup, MetaEnrich, _ppDiag */

Zotero.PaperPilot = {
  id: null,
  version: null,
  rootURI: null,
  _initialized: false,
  _prefObserverSymbols: null,
  _paneID: null,

  _diag(msg) {
    try { _ppDiag(msg); } catch (e) { /* bootstrap 未提供则忽略 */ }
  },

  async init({ id, version, rootURI }) {
    if (this._initialized) return;
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    // 按依赖顺序加载子模块（共享同一全局作用域，var 声明互相可见）
    const files = [
      "core/utils.js",
      "ai/providers.js",
      "ai/client.js",
      "ai/chat.js",
      "ai/prompts.js",
      "ai/auto-tag.js",
      "ai/matrix.js",
      "ai/semantic-scholar.js",
      "features/annotations.js",
      "features/collection-stats.js",
      "features/reader-popup.js",
      "features/rule-tag.js",
      "features/citation-trace.js",
      "features/fake-check.js",
      "features/smart-cleanup.js",
      "features/meta-enrich.js",
      "columns/rank-column.js",
      "columns/citation-column.js",
      "panels/ai-chat-pane.js",
      "menus.js",
    ];
    for (const f of files) {
      try {
        // ?v= 缓存破坏：与 bootstrap 同理，防止热升级时加载到旧编译缓存
        Services.scriptloader.loadSubScript(rootURI + "chrome/content/scripts/" + f + "?v=" + version);
      } catch (e) {
        // 单个模块失败不拖垮整个插件：记录后继续，功能按模块独立降级
        await this._diag("loadSubScript FAILED " + f + ": " + (e && (e.stack || e.message) || e));
      }
    }
    await this._diag("subscripts loaded");

    // 暴露给设置窗口脚本（prefs-pane.js 运行在设置窗口作用域，访问不到 bootstrap 作用域，
    // 但能访问 Zotero 全局）
    this.providers = AIProviders;
    this.rankColumn = RankColumn;
    this.citationColumn = CitationColumn;
    this.s2 = S2Client;
    this.ruleTag = RuleTag;
    this.citationTrace = CitationTrace;
    this.fakeCheck = FakeCheck;
    this.smartCleanup = SmartCleanup;
    this.metaEnrich = MetaEnrich;
    // 工作台独立窗口需要（窗口脚本访问不到 bootstrap 作用域）
    this.aiChat = AIChat;
    this.aiClient = AIClient;
    this.notes = Notes;
    this.mdLite = MdLite;

    // 一次性迁移：aiTemperature 旧版本默认是浮点 0.3，被 Mozilla int pref 截断成 0；
    // 0.4.0 起改存字符串。若用户 pref 仍是 int 类型则清掉，让新的字符串默认值生效
    try {
      const tempKey = Prefs.PREFIX + "aiTemperature";
      if (Services.prefs.getPrefType(tempKey) === Services.prefs.PREF_INT) {
        Services.prefs.clearUserPref(tempKey);
        await this._diag("migrated aiTemperature int -> string default");
      }
    } catch (e) {
      await this._diag("pref migration failed: " + (e && (e.stack || e.message) || e));
    }

    // 注册设置面板（prefs.xhtml 为 fragment，配套脚本处理测试连接/文件选择）
    // 显式给稳定 id：openPreferences(paneID) 导航需要它（自动生成的 id 带随机串，
    // 且传 pluginID 给 openPreferences 无法定位面板——Z10 preferences.js 实证）
    try {
      this._paneID = await Zotero.PreferencePanes.register({
        pluginID: id,
        id: "paperpilot-prefs",
        src: rootURI + "chrome/content/prefs.xhtml",
        scripts: [rootURI + "chrome/content/prefs-pane.js"],
        label: "PaperPilot",
        image: "chrome://paperpilot/content/icons/icon.png",
      });
      await this._diag("PreferencePanes registered paneID=" + this._paneID);
    } catch (e) {
      await this._diag("PreferencePanes FAILED: " + (e && (e.stack || e.message) || e));
    }

    // UI 相关要等主窗口就绪（带超时兜底，永不挂死）
    await Promise.race([
      Zotero.uiReadyPromise,
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]);
    await this._diag("ui ready (or timed out)");

    // 期刊分区列
    if (Prefs.get("rankColumnEnabled", true)) {
      try {
        await RankColumn.load(rootURI);
        await RankColumn.register(id);
        await this._diag("rank column registered");
      } catch (e) {
        await this._diag("rank column FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    // 被引量列（Semantic Scholar）
    if (Prefs.get("citationColumnEnabled", true)) {
      try {
        await CitationColumn.register(id);
        await this._diag("citation column registered");
      } catch (e) {
        await this._diag("citation column FAILED: " + (e && (e.stack || e.message) || e));
      }
    }

    // AI 问答侧栏
    try {
      AIChatPane.register(id);
      await this._diag("chat pane registered");
    } catch (e) {
      await this._diag("chat pane FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 菜单
    try {
      Menus.init(rootURI);
      await this._diag("menus registered");
    } catch (e) {
      await this._diag("menus FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 阅读器划词浮窗
    try {
      ReaderPopup.register(id);
      await this._diag("reader popup registered");
    } catch (e) {
      await this._diag("reader popup FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 规则打标：新条目自动应用的 Notifier（菜单部分已由 Menus 注入）
    try {
      RuleTag.register();
      await this._diag("rule tag notifier registered");
    } catch (e) {
      await this._diag("rule tag FAILED: " + (e && (e.stack || e.message) || e));
    }

    // 监听配置变更：分区开关 / 数据路径 即时生效（非关键功能，失败不得拖死 startup）
    try {
      this._watchPrefs();
      await this._diag("pref watchers registered");
    } catch (e) {
      await this._diag("pref watchers FAILED: " + (e && (e.stack || e.message) || e));
    }

    this._initialized = true;
    Zotero.debug(`PaperPilot ${version} initialized`);
  },

  /** 工作台独立窗口（0.9.0）：单实例——已开则聚焦，未开则新开 */
  openWorkbench() {
    try {
      const wm = Services.wm;
      const en = wm.getEnumerator("paperpilot:workbench");
      if (en.hasMoreElements()) {
        const win = en.getNext();
        try { win.focus(); } catch (e) { /* ignore */ }
        return win;
      }
      const win = Zotero.getMainWindow();
      if (!win) return null;
      // ⚠️ 新开 chrome 窗口里没有 Zotero 全局，主窗口的 Zotero 也不能经
      // opener.Zotero 跨窗口读到；且窗口作用域里 importESModule 加载
      // Services.sys.mjs 会失败（0.9.0 实证）——Zotero/Services 一律经
      // window.arguments 传对象引用，这是唯一可靠通道。
      return win.openDialog(
        "chrome://paperpilot/content/workbench.xhtml",
        "paperpilot-workbench",
        "chrome,extracz,resizable,dialog=no,centerscreen",
        { Zotero, Services }
      );
    } catch (e) {
      Zotero.logError(new Error("PaperPilot: 打开工作台失败"));
      Zotero.logError(e);
      return null;
    }
  },

  _watchPrefs() {
    // 沙箱作用域里的普通对象挂不上 nsIPrefBranch 弱引用 observer
    // （FF140 实证：addObserver(..., weak=true) 直接抛错拖死 startup）。
    // 改用 Zotero.Prefs.registerObserver——Zotero 自己在主作用域持有单个
    // nsIObserver 再分发，按「完整 pref key」注册（无前缀监听，逐 key 注册）。
    this._prefObserverSymbols = ["rankDataPath", "rankColumnEnabled", "easyScholarEnabled", "easyScholarKey", "citationColumnEnabled"].map((key) =>
      Zotero.Prefs.registerObserver(Prefs.PREFIX + key, () => {
        this._onPrefChanged(key).catch((e) => {
          try { Zotero.logError(e); } catch (_) { /* ignore */ }
        });
      }, true)
    );
  },

  async _onPrefChanged(key) {
    if (key === "rankDataPath") {
      if (RankColumn._registered) await RankColumn.reload();
    } else if (key === "rankColumnEnabled") {
      const enabled = Prefs.get("rankColumnEnabled", true);
      if (enabled && !RankColumn._registered) {
        await RankColumn.load(this.rootURI);
        await RankColumn.register(this.id);
      } else if (!enabled && RankColumn._registered) {
        RankColumn.unregister();
      }
    } else if (key === "citationColumnEnabled") {
      const enabled = Prefs.get("citationColumnEnabled", true);
      if (enabled && !CitationColumn._registered) {
        await CitationColumn.register(this.id);
      } else if (!enabled && CitationColumn._registered) {
        CitationColumn.unregister();
      }
    } else if (key === "easyScholarEnabled" || key === "easyScholarKey") {
      // 开关或密钥变化：清查找缓存并立即重绘（ES 结果按内容缓存，无需清空）
      try { RankColumn._lookupCache.clear(); } catch (e) { /* ignore */ }
      try { Zotero.ItemTreeManager.refreshColumns(); } catch (e) { /* ignore */ }
    }
  },

  destroy() {
    if (this._prefObserverSymbols) {
      for (const sym of this._prefObserverSymbols) {
        try { Zotero.Prefs.unregisterObserver(sym); } catch (e) { /* ignore */ }
      }
      this._prefObserverSymbols = null;
    }
    try { Menus.destroy(); } catch (e) { Zotero.logError(e); }
    try { RuleTag.unregister(); } catch (e) { Zotero.logError(e); }
    try { ReaderPopup.unregister(); } catch (e) { Zotero.logError(e); }
    try { AIChatPane.unregister(); } catch (e) { Zotero.logError(e); }
    try { RankColumn.unregister(); } catch (e) { Zotero.logError(e); }
    try { CitationColumn.unregister(); } catch (e) { Zotero.logError(e); }
    // unregister 接收的是 register 返回的 paneID（不是 pluginID；Z10 关机时也会自动注销）
    try {
      if (this._paneID) Zotero.PreferencePanes.unregister(this._paneID);
    } catch (e) { Zotero.logError(e); }
    this._paneID = null;
    this._initialized = false;
  },
};
