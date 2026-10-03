#!/usr/bin/env node
/* 会员面板渲染测试（插件 0.24.4）
 *
 * 为什么要有它：设置面板脚本（chrome/content/prefs-account.js）跑在 Zotero 设置窗口里，
 * 无人环境点不了。这里用「迷你 DOM + 假 Account」把它**真跑一遍**，断言：
 *   #4 价格档位来自价格表（周期名 + 折合月单价）、未生效价格以灰底预告出现且不可点；
 *   #5 剩余 ≤7 天出现续费横幅、已到期转红、默认档位取「上次购买的周期」；
 *   #11 用量块画出近 7 天柱状图并显示今日/额度与近 7 天合计；老服务端（无趋势）时整块隐藏。
 *
 * 运行：node test/membership-panel.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const XHTML = path.join(ROOT, 'chrome', 'content', 'prefs.xhtml');
const PANEL = path.join(ROOT, 'chrome', 'content', 'prefs-account.js');

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }
function has(hay, needle, label) {
  return ok(String(hay).indexOf(needle) >= 0, label, { text: String(hay).slice(0, 160), want: needle });
}

/* ---------------- 迷你 DOM ---------------- */

class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.style = {}; this._attrs = {};
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false;
    this.checked = false; this.handlers = {};
  }
  setAttribute(k, v) {
    if (k === 'class') this.className = v; else this._attrs[k] = v;
  }
  getAttribute(k) { return k === 'class' ? this.className : (k in this._attrs ? this._attrs[k] : null); }
  removeAttribute(k) { if (k === 'class') this.className = ''; else delete this._attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(ev, fn) { this.handlers[ev] = fn; }
  removeEventListener(ev) { delete this.handlers[ev]; }
  click() { if (this.handlers.click) return this.handlers.click({ preventDefault() {} }); return undefined; }
  focus() {}
  scrollIntoView() {}
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set innerHTML(v) { this._text = ''; this.children = []; if (v) this._text = String(v); }
  get innerHTML() { return this.textContent; }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  /** 深度优先收集所有节点（便于断言） */
  all() { return this.children.reduce((acc, c) => acc.concat([c], c.all()), []); }
  byClass(cls) { return this.all().filter((n) => String(n.className).split(/\s+/).indexOf(cls) >= 0); }
}

function makeDom(html) {
  const ids = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(html))) ids.add(m[1]);
  const registry = new Map();
  for (const id of ids) registry.set(id, new El('div'));
  const document = {
    getElementById: (id) => registry.get(id) || null,
    createElementNS: (ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
    body: new El('body'),
  };
  return { document, registry };
}

/* ---------------- 假 Account / Channels ---------------- */

const DAY = 86400e3;
const isoDay = (n) => {
  const d = new Date(Date.now() + n * DAY);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};

const PLANS_PAYLOAD = {
  plans: [{ id: 'Free', name: '免费版', rank: 0, dailyLimit: 100, features: ['每日 100 次'] },
    { id: 'Pro', name: '专业版', rank: 1, dailyLimit: 3000, features: ['每日 3000 次', '全部官方模型'] }],
  priceOptions: [{ plan: 'Pro', months: 1, price: 29, label: '1 个月' }],
  priceItems: [
    { id: 'p1', plan: 'Pro', cycle: 'monthly', cycleName: '按月', months: 1, price: 29, perMonth: 29, label: '按月' },
    { id: 'p3', plan: 'Pro', cycle: 'quarterly', cycleName: '按季', months: 3, price: 79, perMonth: 26.33, label: '按季' },
    { id: 'p12', plan: 'Pro', cycle: 'yearly', cycleName: '按年', months: 12, price: 269, perMonth: 22.42, label: '按年' },
  ],
  upcoming: [{ id: 'p6', plan: 'Pro', cycle: 'halfyear', cycleName: '半年', months: 6, price: 149,
    perMonth: 24.83, label: '半年', effectiveFrom: '2026-11-11T00:00:00.000Z' }],
  cycles: [],
  pay: { channel: '微信收款码', note: '备注订单号' },
};

function fakeAccount(over) {
  const base = Object.assign({
    isLoggedIn: () => true,
    user: () => ({ email: 'me@test.local', name: '我', plan: 'Pro', dailyUsed: 5, dailyLimit: 3000 }),
    expiresAt: () => Date.now() + 30 * DAY,
    serverUrl: () => 'https://pp.example.com',
    persistStatus: { attempted: 1, ok: true },
    membership: () => ({ plan: 'Pro', name: '专业版', rawPlan: 'Pro', expired: false,
      expiresAt: Date.now() + 3 * DAY, dailyLimit: 3000, source: 'order',
      history: [{ plan: 'Pro', months: 1, at: '2026-09-01T00:00:00Z' },
        { plan: 'Pro', months: 12, at: '2026-10-01T00:00:00Z' }] }),
    isPro: () => true,
    membershipDaysLeft: () => 3,
    renewalReminder: () => ({ daysLeft: 3, expired: false, expiresAt: Date.now() + 3 * DAY, key: 'k' }),
    lastPurchasedMonths: () => 12,
    usage: () => ({
      today: 5, limit: 3000, last7: 12,
      days: Array.from({ length: 30 }, (_, i) => ({ date: isoDay(i - 29), count: i % 4 })),
    }),
    plans: async () => PLANS_PAYLOAD,
    onSessionChanged: () => () => {},
  }, over || {});
  return new Proxy(base, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      if (k === 'then') return undefined;
      return async () => null;      // 未 stub 的异步方法一律 null，避免未捕获拒绝
    },
  });
}

/* 通道模块只需足够让 renderAccount/renderChannels 跑完（会员面板不依赖它） */
const fakeChannels = {
  OFFICIAL_ID: '__official__',
  PROVIDERS: [],
  list: () => ({ channels: [], active: null }),
  getChannel: () => ({ id: '__official__', model: 'auto', models: ['auto'] }),
  fetchModels: async () => ({ ok: true, models: [] }),
  upsert: () => ({ ok: true }),
  setActive: () => ({ ok: true }),
  testChannel: async () => ({ ok: true }),
  detectChannel: async () => ({ ok: true }),
  remove: () => ({ ok: true }),
  providerOf: () => null,
  activeChannel: () => null,
};

function boot(accountOver) {
  const { document, registry } = makeDom(fs.readFileSync(XHTML, 'utf8'));
  const prefs = new Map();
  const sandbox = {
    console,
    document,
    Zotero: {
      locale: 'zh-CN',
      PaperPilot: { account: fakeAccount(accountOver), channels: fakeChannels },
      Prefs: { get: (k, d) => (prefs.has(k) ? prefs.get(k) : d), set: (k, v) => prefs.set(k, v) },
      getMainWindow: () => null,
    },
    window: {
      setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {},
      addEventListener: () => {}, confirm: () => false,
    },
    Components: undefined,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PANEL, 'utf8'), sandbox, { filename: 'prefs-account.js' });
  return { registry, prefs, sandbox };
}

const flush = () => new Promise((r) => setImmediate(r));

(async () => {
  /* ============ A. Pro 用户：剩余 3 天 + 用量趋势 ============ */
  let { registry } = boot({});

  const renew = registry.get('pp-mb-renew');
  ok(renew.style.display !== 'none', 'A1 剩余 ≤7 天 → 续费横幅出现', renew.style.display);
  has(renew.textContent, '仅剩 3 天', 'A2 横幅说明剩余天数');
  has(renew.textContent, '点此续费', 'A3 横幅提示可点');
  ok(!/expired/.test(renew.className), 'A4 未到期时不是危险样式', renew.className);

  const usage = registry.get('pp-mb-usage');
  ok(usage.style.display !== 'none', 'A5 用量块出现');
  has(usage.textContent, '今日 5 / 3000', 'A6 显示今日/额度');
  has(usage.textContent, '近 7 天合计 12', 'A7 显示近 7 天合计');
  const bars = usage.byClass('pp-mb-bar');
  eq(bars.length, 7, 'A8 画出 7 根柱子');
  const cols = usage.byClass('pp-mb-bar-col');
  eq(cols.length, 7, 'A9 7 个柱位（含日期标签）');
  ok(bars.some((b) => parseInt(b.style.height, 10) > 2), 'A10 有非零柱高', bars.map((b) => b.style.height));
  const dayLabels = usage.byClass('pp-mb-bar-day');
  eq(dayLabels.length, 7, 'A11 每根柱都有日期标签');
  eq(dayLabels[6].textContent, isoDay(0).slice(8, 10), 'A12 最后一根是今天');

  /* ============ B. 续费面板：价格表档位 + 预告 ============ */
  renew.click();                       // 打开续费面板（等价于点「续费专业版」）
  await flush(); await flush(); await flush();

  const order = registry.get('pp-mb-order');
  ok(order.style.display !== 'none', 'B1 点横幅 → 续费面板打开');
  const opts = registry.get('pp-mb-options');
  const chips = opts.children.filter((c) => !/soo?n/.test(c.className) && /pp-mb-opt/.test(c.className));
  eq(chips.length, 3, 'B2 生效中 3 个档位（来自 priceItems）', chips.map((c) => c.textContent));
  has(chips[0].textContent, '按月 · ¥29', 'B3 档位显示中文周期名与价格');
  has(chips[1].textContent, '折合 ¥26.33/月', 'B4 多周期档位显示折合月单价');
  has(chips[2].textContent, '折合 ¥22.42/月', 'B5 按年档位折合价正确');
  ok(!/折合/.test(chips[0].textContent), 'B6 按月档位不显示多余的折合价');

  const soon = opts.children.filter((c) => /pp-mb-opt-soon/.test(c.className));
  eq(soon.length, 1, 'B7 未生效价格以预告形式出现');
  has(soon[0].textContent, '即将生效', 'B8 预告标注「即将生效」');
  has(soon[0].textContent, '2026-11-11', 'B9 预告带生效日期');
  eq(soon[0].handlers.click, undefined, 'B10 预告不可点（没绑 click）');

  const on = chips.filter((c) => /pp-mb-opt-on/.test(c.className));
  eq(on.length, 1, 'B11 恰有一个默认选中档位');
  has(on[0].textContent, '按年', 'B12 默认档位 = 上次购买的 12 个月');

  /* ============ C. 已过期：横幅转红 + 文案变化 ============ */
  ({ registry } = boot({
    membershipDaysLeft: () => 0,
    isPro: () => false,
    renewalReminder: () => ({ daysLeft: 0, expired: true, expiresAt: Date.now() - 2 * DAY, key: 'e' }),
    membership: () => ({ plan: 'Free', name: '免费版', rawPlan: 'Pro', expired: true,
      expiresAt: Date.now() - 2 * DAY, dailyLimit: 100, source: 'order', history: [{ plan: 'Pro', months: 1 }] }),
  }));
  const rb2 = registry.get('pp-mb-renew');
  ok(rb2.style.display !== 'none', 'C1 已过期 → 横幅仍出现');
  has(rb2.textContent, '已', 'C2 文案说明已到期');
  has(rb2.className, 'pp-mb-renew-expired', 'C3 已过期用危险样式（红色）');

  /* ============ D. 免费用户（无到期日）：不打扰 ============ */
  ({ registry } = boot({
    isPro: () => false,
    membership: () => ({ plan: 'Free', name: '免费版', rawPlan: 'Free', expired: false,
      expiresAt: 0, dailyLimit: 100, source: '', history: [] }),
    membershipDaysLeft: () => Infinity,
    renewalReminder: () => null,
    lastPurchasedMonths: () => null,
  }));
  eq(registry.get('pp-mb-renew').style.display, 'none', 'D1 免费用户不显示到期横幅');
  ok(registry.get('pp-mb-upgrade').textContent.indexOf('升级') >= 0, 'D2 按钮仍显示「升级专业版」');

  /* ============ E. 老服务端（无用量趋势）：整块隐藏而不是画空图 ============ */
  ({ registry } = boot({
    usage: () => ({ today: 5, limit: 3000, last7: 0, days: [] }),
  }));
  eq(registry.get('pp-mb-usage').style.display, 'none', 'E1 无趋势数据 → 用量块隐藏');
  eq(registry.get('pp-mb-renew').style.display, '', 'E2 到期提醒不受影响（仍显示）');

  /* ============ F. 优惠码：试算 → 展示折后价 → 下单带券 ============ */
  let createdArgs = null;
  let validatedArgs = null;
  ({ registry } = boot({
    validateCoupon: async (code, plan, months, cycle) => {
      validatedArgs = { code: code, plan: plan, months: months, cycle: cycle };
      return { code: 'CP-AAAA-BBBB-CCCC', type: 'percent', label: '减 25%（75 折）',
        originalText: '¥269.00', discountText: '−¥67.25', payableText: '¥201.75', payableCents: 20175 };
    },
    createOrder: async (plan, months, cycle, couponCode) => {
      createdArgs = { plan: plan, months: months, cycle: cycle, couponCode: couponCode };
      return { id: 'o-cp1', plan: 'Pro', planName: '专业版', months: 12, status: 'pending',
        amountText: '¥201.85', baseCents: 20175, originalCents: 26900,
        originalText: '¥269.00', discountText: '−¥67.25', discountCents: 6725,
        couponCode: couponCode, tailCents: 10, pay: { channel: '微信收款码' } };
    },
  }));

  registry.get('pp-mb-upgrade').click();
  await flush(); await flush(); await flush();
  eq(registry.get('pp-mb-quote').style.display, 'none', 'F1 未应用优惠码时折后价区隐藏');

  registry.get('pp-mb-coupon').value = 'cp-aaaa-bbbb-cccc';
  registry.get('pp-mb-coupon-btn').click();
  await flush(); await flush(); await flush();
  eq(validatedArgs && validatedArgs.code, 'cp-aaaa-bbbb-cccc', 'F2 用户输入原样交给服务端校验');
  eq(validatedArgs && validatedArgs.months, 12, 'F3 带上当前档位月数（服务端据此算折前价）');
  has(registry.get('pp-mb-coupon-msg').textContent, '减 25%', 'F4 应用成功回显券的内容');

  const qbox = registry.get('pp-mb-quote');
  eq(qbox.style.display, '', 'F5 折后价区出现');
  has(qbox.textContent, '¥269.00', 'F6 显示折前价');
  has(qbox.textContent, '−¥67.25', 'F7 显示减免额');
  has(qbox.textContent, '¥201.75', 'F8 显示应付金额');
  has(qbox.textContent, '尾数', 'F9 提醒应付之外还会加对账尾数（避免用户以为被多收）');

  // 换档位必须作废已试算的折后价（否则用户会照着旧价格转账）
  const opts2 = registry.get('pp-mb-options');
  const chips2 = opts2.children.filter((c) => /pp-mb-opt/.test(c.className) && !/soo?n/.test(c.className));
  chips2[0].click();
  await flush();
  eq(registry.get('pp-mb-quote').style.display, 'none', 'F10 换档位 → 折后价区收起');
  has(registry.get('pp-mb-coupon-msg').textContent, '重新应用', 'F11 换档位提示需要重新应用优惠码');

  registry.get('pp-mb-coupon-btn').click();
  await flush(); await flush(); await flush();
  eq(registry.get('pp-mb-quote').style.display, '', 'F12 重新应用后折后价区回来');

  registry.get('pp-mb-create').click();
  await flush(); await flush(); await flush();
  eq(createdArgs && createdArgs.couponCode, 'CP-AAAA-BBBB-CCCC', 'F13 下单时把券码带上（用归一后的码）');
  const payInfo = registry.get('pp-mb-pay-info').textContent;
  has(payInfo, '折前 ¥269.00', 'F14 支付页显示折前价');
  has(payInfo, '−¥67.25', 'F15 支付页显示减免额');
  has(payInfo, '折后 ¥201.75', 'F16 支付页显示折后价');
  has(payInfo, '201.85', 'F17 转账金额仍是含尾数的实付（不是折后价）');
  has(payInfo, 'CP-AAAA-BBBB-CCCC', 'F18 支付页标注用了哪张券（便于对账）');

  /* ============ G. 优惠码不可用 / 清除 ============ */
  ({ registry } = boot({
    validateCoupon: async () => { throw new Error('该优惠码需满 ¥100.00，本单折前 ¥29.00，未达门槛'); },
  }));
  registry.get('pp-mb-upgrade').click();
  await flush(); await flush(); await flush();
  registry.get('pp-mb-coupon').value = 'CP-AAAA-BBBB-CCCC';
  registry.get('pp-mb-coupon-btn').click();
  await flush(); await flush(); await flush();
  has(registry.get('pp-mb-coupon-msg').textContent, '未达门槛', 'G1 服务端给的原因原样告诉用户');
  eq(registry.get('pp-mb-quote').style.display, 'none', 'G2 失败时不显示折后价（绝不显示错的价）');
  ok(registry.get('pp-mb-order-msg').textContent.indexOf('✗') < 0, 'G3 券失败不影响正常下单流程');

  registry.get('pp-mb-coupon').value = '';
  registry.get('pp-mb-coupon-btn').click();
  await flush();
  has(registry.get('pp-mb-coupon-msg').textContent, '已清除', 'G4 清空输入即取消已应用的券');
  eq(registry.get('pp-mb-quote').style.display, 'none', 'G5 清除后折后价区收起');

  console.log('\n会员面板渲染测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) {
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
