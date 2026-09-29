/* PaperPilot Prompt 技能库：内置模板 + 用户自定义
 * 自定义格式（pref customPrompts，每行一条）：名称=提示词内容
 */
/* global Prefs */

var Prompts = {
  builtin: [
    {
      id: "summary-structured",
      name: "结构化总结",
      text: "用中文写一份结构化的论文摘要，分四块，每块用小标题起头：\n" +
        "**核心思想**：论文想解决什么问题，为什么值得解决，基本主张是什么，2-4 句。\n" +
        "**方法论**：研究设计、数据或样本来源、关键变量与测量、主要分析方法，写出具体名字和数字。\n" +
        "**主要结论**：按重要性列 3-5 条，说明效应方向与大小、哪些结论稳健。\n" +
        "**创新点**：相对既有文献新在哪里（新问题/新数据/新方法/新结论），逐条对照说明。\n" +
        "要求：用论文自己的术语和数字说话，论文没写的不要补。",
    },
    {
      id: "summary-critical",
      name: "批判性总结",
      text: "请用中文对这篇论文做批判性审读，分三块输出：\n" +
        "**主张与证据**：作者的核心主张是什么，支撑证据是什么，证据与主张之间是否有跳跃。\n" +
        "**方法软肋**：研究设计、样本、变量测量、因果识别上有哪些可质疑之处，逐条说明。\n" +
        "**被忽略的替代解释**：还有哪些机制能解释同样的结果，作者是否排除了它们。\n" +
        "要求：批评要落到具体段落和论证上，不要泛泛而谈。",
    },
    {
      id: "summary-concise",
      name: "简明总结",
      text: "请用中文把这篇论文压缩成 150 字以内的一段话：研究了什么、怎么做的、发现了什么。只说最核心的，不要评论。",
    },
    {
      id: "translate-abstract",
      name: "翻译标题与摘要",
      text: "请将这篇论文的标题与摘要翻译成中文，学术语气、忠实原文，" +
        "专业术语保留英文原词并用括号标注，按「标题」「摘要」两节输出。",
    },
    {
      id: "explain-like-review",
      name: "审稿意见模拟",
      text: "请你扮演该领域苛刻但公正的审稿人，用中文写一份审稿意见：" +
        "1) 论文一句话概括 2) 三条主要优点 3) 三条主要问题（按严重程度排序）4) 修改建议 5) 录用倾向（接收/小修/大修/拒稿）及理由。",
    },
  ],

  /** 全部可用 prompt（内置 + 自定义） */
  all() {
    const custom = [];
    const raw = Prefs.get("customPrompts", "") || "";
    for (const line of String(raw).split(/\r?\n/)) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const name = line.slice(0, idx).trim();
      const text = line.slice(idx + 1).trim();
      if (name && text) custom.push({ id: "custom-" + custom.length, name, text });
    }
    return this.builtin.concat(custom);
  },
};
