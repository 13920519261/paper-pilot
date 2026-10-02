/* PaperPilot 账号后台 · 会员域（0.23.0）
 *
 * 职责：套餐目录 / 价格档位 / 订单生命周期 / 激活码（兑换码）/ 有效期管理。
 * 数据：{DATA_DIR}/membership.json（JsonStore 原子写）
 *   {
 *     schemaVersion: 2,
 *     plans:        { Free:{...}, Pro:{...} },          // 等级与权益（后台可改）
 *     priceOptions: { Pro:[{months,price,label}, ...] },// 价格档位（后台可改）
 *     pay:          { channel, qrImage, qrText, note },  // 收款信息（后台可改）
 *     orders:       [ ... ],                             // 订单
 *     codes:        [ ... ]                              // 激活码
 *   }
 *
 * 会员等级的权威落点仍是 user 对象（users.json）：
 *   user.membership = { plan, months, activatedAt, expiresAt, source, refId, history[] }
 *   user.plan / user.expiresAt 是兼容镜像（旧客户端只认这两个字段）
 * 因此会员数据与账号数据同生命周期的持久化策略，无需二次迁移。
 *
 * 有效期规则（关键）：续期 = max(现在, 现有到期) + 时长。
 *   即「剩余时长不吞」——Pro 还剩 20 天时再买 1 个月，到期日 = 今天 + 20 天 + 30 天。
 *
 * 两条开通路径：
 *   A. 订单：插件内下单 → 用户扫码付款后点「我已完成支付」→ 管理员核销 →
 *      直接给下单账号开通（同时生成一枚已用兑换码留档，便于对账）。
 *   B. 激活码：线下售卖/赠送/补偿 → 插件内输码激活（可用「未绑定」通用码，
 *      也可绑定到指定账号）。
 */
'use strict';

const crypto = require('crypto');

const DAY_MS = 86400e3;
const ORDER_TTL_MS = 7 * DAY_MS;    // 未支付订单 7 天后自动过期
const MAX_MONTHS = 36;

/* ---------------- 默认配置（后台可改，改完落 membership.json） ---------------- */

const DEFAULT_PLANS = {
  Free: {
    id: 'Free', name: '免费版', rank: 0, price: 0, currency: 'CNY',
    dailyLimit: 100, highTierModels: false,
    tagline: '登录即用，个人日常够用',
    features: [
      '官方模型每日 100 次',
      '全部核心功能（期刊分区列 / 标签治理 / 附件体检 / 库内问答 / PDF 对比…）',
      '可接入自己的 OpenAI 兼容接口，不受额度限制',
      '社区支持',
    ],
  },
  Pro: {
    id: 'Pro', name: '专业版', rank: 1, price: 29, currency: 'CNY',
    dailyLimit: 3000, highTierModels: true,
    tagline: '高频写论文/做综述时用',
    features: [
      '官方模型每日 3000 次',
      '高级模型（推理档 / 长上下文）',
      '高峰时段优先通道',
      '邮件优先支持',
    ],
  },
};

const DEFAULT_PRICE_OPTIONS = {
  Pro: [
    { months: 1, price: 29, label: '1 个月' },
    { months: 3, price: 79, label: '3 个月 · 省 ¥8' },
    { months: 12, price: 269, label: '12 个月 · 省 ¥79' },
  ],
};

const DEFAULT_PAY = {
  channel: '收款码',
  qrImage: '',   // 收款码图片地址（后台填写；为空时展示 qrText）
  qrText: '',    // 无图片时的文字收款信息（如微信号 / 支付宝账号）
  note: '扫码支付后点「我已完成支付」，管理员核销后自动开通（一般几分钟内）。',
};

/** 激活码字母表：去掉易混的 0/O/1/I/L */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/* ---------------- 基础 ---------------- */

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function newDoc() {
  return {
    schemaVersion: 2,
    plans: clone(DEFAULT_PLANS),
    priceOptions: clone(DEFAULT_PRICE_OPTIONS),
    pay: clone(DEFAULT_PAY),
    orders: [],
    codes: [],
  };
}

/**
 * 规范化 / 迁移：补齐缺字段，把 v1（无 schemaVersion）升到 v2。
 * 幂等，任何一次启动都可安全调用。
 */
function normalize(doc) {
  const out = doc && typeof doc === 'object' ? doc : newDoc();
  if (!out.plans || typeof out.plans !== 'object') out.plans = clone(DEFAULT_PLANS);
  for (const id of Object.keys(DEFAULT_PLANS)) {
    if (!out.plans[id]) out.plans[id] = clone(DEFAULT_PLANS[id]);
    else out.plans[id] = Object.assign(clone(DEFAULT_PLANS[id]), out.plans[id]);
  }
  if (!out.priceOptions || typeof out.priceOptions !== 'object') out.priceOptions = clone(DEFAULT_PRICE_OPTIONS);
  if (!out.priceOptions.Pro || !out.priceOptions.Pro.length) out.priceOptions.Pro = clone(DEFAULT_PRICE_OPTIONS.Pro);
  if (!out.pay || typeof out.pay !== 'object') out.pay = clone(DEFAULT_PAY);
  else out.pay = Object.assign(clone(DEFAULT_PAY), out.pay);
  if (!Array.isArray(out.orders)) out.orders = [];
  if (!Array.isArray(out.codes)) out.codes = [];
  out.schemaVersion = 2;
  return out;
}

function rid(prefix, bytes) {
  return prefix + '-' + crypto.randomBytes(bytes || 6).toString('hex');
}

/** 人类可读激活码 PP-XXXX-XXXX-XXXX */
function newCode() {
  const pick = () => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  const block = () => pick() + pick() + pick() + pick();
  return 'PP-' + block() + '-' + block() + '-' + block();
}

/** 激活码归一：去空白、转大写、接受带或不带分隔符 */
function normCode(c) {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length !== 14 || !s.startsWith('PP')) return '';
  return 'PP-' + s.slice(2, 6) + '-' + s.slice(6, 10) + '-' + s.slice(10, 14);
}

/* ---------------- 套餐与价格 ---------------- */

function planOf(doc, id) {
  const p = (doc.plans || {})[String(id || '')];
  return p || (doc.plans && doc.plans.Free) || DEFAULT_PLANS.Free;
}

/** 某等级的每日官方模型额度（管理员在用户级显式设置的 dailyLimit 优先级更高） */
function dailyLimitFor(doc, planId) {
  const p = planOf(doc, planId);
  const n = Number(p.dailyLimit);
  return n > 0 ? n : 100;
}

/** 价格档位查询；未配置的月数按「单价 × 月数」兜底 */
function priceOf(doc, planId, months) {
  const m = clampMonths(months);
  const p = planOf(doc, planId);
  const list = (doc.priceOptions && doc.priceOptions[planId]) || [];
  const hit = list.find((o) => Number(o.months) === m);
  if (hit) return { months: m, price: Number(hit.price) || 0, label: hit.label || m + ' 个月' };
  const unit = Number(p.price) > 0 ? Number(p.price) : 0;
  return { months: m, price: unit * m, label: m + ' 个月' };
}

function clampMonths(months) {
  const n = Math.round(Number(months) || 0);
  if (n < 1) return 1;
  if (n > MAX_MONTHS) return MAX_MONTHS;
  return n;
}

/** 客户端可见的套餐目录（不含任何后台敏感字段） */
function plansForClient(doc) {
  const plans = Object.values(doc.plans || {})
    .sort((a, b) => (Number(a.rank) || 0) - (Number(b.rank) || 0))
    .map((p) => ({
      id: p.id, name: p.name, rank: Number(p.rank) || 0,
      price: Number(p.price) || 0, currency: p.currency || 'CNY',
      dailyLimit: dailyLimitFor(doc, p.id),
      highTierModels: !!p.highTierModels,
      tagline: p.tagline || '',
      features: Array.isArray(p.features) ? p.features : [],
      purchasable: Number(p.price) > 0,
    }));
  const priceOptions = [];
  for (const [planId, list] of Object.entries(doc.priceOptions || {})) {
    if (!Array.isArray(list)) continue;
    for (const o of list) {
      priceOptions.push({
        plan: planId, months: clampMonths(o.months),
        price: Number(o.price) || 0, label: o.label || '',
        currency: planOf(doc, planId).currency || 'CNY',
      });
    }
  }
  priceOptions.sort((a, b) => (a.plan === b.plan ? a.months - b.months : a.plan < b.plan ? -1 : 1));
  return { plans, priceOptions, pay: { channel: doc.pay.channel, qrImage: doc.pay.qrImage, qrText: doc.pay.qrText, note: doc.pay.note } };
}

/* ---------------- 会员状态 ---------------- */

/**
 * 用户的有效会员视图（等级 / 到期 / 剩余天数 / 额度 / 历史）。
 * 过期即降级展示为 Free，但**不踢下线**（额度回落，客户端下次 /me 或网关调用自然更新）。
 */
function membershipOf(doc, user) {
  const now = Date.now();
  const m = (user && user.membership) || {};
  const rawPlan = m.plan || (user && user.plan) || 'Free';
  let plan = rawPlan;
  let expired = false;
  let expMs = 0;
  if (m.expiresAt) expMs = Date.parse(m.expiresAt) || 0;
  else if (user && user.expiresAt) expMs = Date.parse(user.expiresAt) || 0;
  if (rawPlan !== 'Free' && expMs && now > expMs) { expired = true; plan = 'Free'; }
  return {
    plan,
    name: planOf(doc, plan).name,
    rawPlan,
    expired,
    expiresAt: expMs ? new Date(expMs).toISOString() : null,
    daysLeft: expMs ? Math.max(0, Math.ceil((expMs - now) / DAY_MS)) : null,
    dailyLimit: dailyLimitFor(doc, plan),
    source: m.source || (expMs ? 'legacy' : ''),
    activatedAt: m.activatedAt || null,
    history: Array.isArray(m.history) ? m.history.slice(-10) : [],
  };
}

/**
 * 开通/续期会员（唯一写入口）。续期 = max(现在, 现有到期) + 时长 —— 剩余时长不吞。
 * 同时同步兼容镜像 user.plan / user.expiresAt（旧客户端与旧管理接口都读它们）。
 */
function grantMembership(doc, user, { plan, months, source, refId, note, now } = {}) {
  const t = now || Date.now();
  const pid = planOf(doc, plan).id || 'Pro';
  const monthsN = clampMonths(months);
  const cur = user.membership && user.membership.plan === pid && user.membership.expiresAt
    ? Math.max(t, Date.parse(user.membership.expiresAt) || t)
    : t;
  const expiresAt = new Date(cur + monthsN * 30 * DAY_MS).toISOString();
  const history = (Array.isArray(user.membership && user.membership.history) ? user.membership.history : []).slice(-19);
  history.push({ plan: pid, months: monthsN, at: new Date(t).toISOString(), source: source || 'manual', refId: refId || '', note: note || '' });
  user.membership = {
    plan: pid,
    name: planOf(doc, pid).name,
    months: monthsN,
    activatedAt: new Date(t).toISOString(),
    expiresAt,
    source: source || 'manual',
    refId: refId || '',
    history,
  };
  user.plan = pid;            // 兼容镜像
  user.expiresAt = expiresAt; // 兼容镜像
  return membershipOf(doc, user);
}

/* ---------------- 订单 ---------------- */

function orderOut(doc, o) {
  return {
    id: o.id, plan: o.plan, planName: planOf(doc, o.plan).name,
    months: o.months, amount: o.amount, currency: o.currency || 'CNY',
    status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt,
    claimedAt: o.claimedAt || null, fulfilledAt: o.fulfilledAt || null,
    cancelledAt: o.cancelledAt || null, cancelReason: o.cancelReason || '',
    note: o.note || '',
    pay: { channel: doc.pay.channel, qrImage: doc.pay.qrImage, qrText: doc.pay.qrText, note: doc.pay.note },
  };
}

/** 惰性过期：未支付（pending/claimed）超过 TTL 的订单落为 expired */
function reapOrders(doc, now) {
  const t = now || Date.now();
  let changed = false;
  for (const o of doc.orders) {
    if ((o.status === 'pending' || o.status === 'claimed') && (t - Date.parse(o.createdAt)) > ORDER_TTL_MS) {
      o.status = 'expired';
      o.updatedAt = new Date(t).toISOString();
      changed = true;
    }
  }
  return changed;
}

function createOrder(doc, { user, plan, months }) {
  const pid = String(plan || 'Pro');
  const p = planOf(doc, pid);
  if (!(Number(p.price) > 0)) return { error: '该套餐无需购买（' + p.name + '）' };
  const m = clampMonths(months);
  const opt = priceOf(doc, pid, m);
  const now = new Date().toISOString();
  const order = {
    id: rid('o', 6),
    userId: user.id, email: user.email,
    plan: pid, months: m,
    amount: opt.price, currency: p.currency || 'CNY',
    status: 'pending',
    createdAt: now, updatedAt: now,
    claimedAt: null, fulfilledAt: null, cancelledAt: null, cancelReason: '',
    codeId: null, note: '',
  };
  doc.orders.push(order);
  return { order };
}

function findOrder(doc, id) {
  return doc.orders.find((o) => o && o.id === id) || null;
}

function claimOrder(doc, order, user) {
  if (!order || order.userId !== user.id) return { error: '订单不存在' };
  if (order.status === 'pending') {
    order.status = 'claimed';
    order.claimedAt = new Date().toISOString();
    order.updatedAt = order.claimedAt;
  } else if (order.status !== 'claimed') {
    return { error: '当前订单状态（' + orderStatusText(order.status) + '）无需再次提交' };
  }
  return { order };
}

function cancelOrder(doc, order, user, reason) {
  if (!order || order.userId !== user.id) return { error: '订单不存在' };
  if (order.status === 'fulfilled') return { error: '订单已完成，无法取消' };
  if (order.status === 'cancelled') return { order };
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  order.updatedAt = order.cancelledAt;
  order.cancelReason = String(reason || '用户取消').slice(0, 60);
  return { order };
}

/**
 * 核销订单（管理员）：给下单账号开通会员，同时生成一枚**已使用**的兑换码留档对账。
 * 幂等：已 fulfilled 的订单重复调用不重复开通。
 */
function fulfillOrder(doc, order, { by, now } = {}) {
  const t = now || Date.now();
  if (!order) return { error: '订单不存在' };
  if (order.status === 'fulfilled') return { error: '订单已核销，无需重复操作' };
  if (order.status === 'cancelled') return { error: '订单已取消，无法核销' };
  const code = {
    id: rid('c', 6), code: newCode(),
    plan: order.plan, months: order.months,
    createdAt: new Date(t).toISOString(), createdBy: String(by || 'admin'),
    note: '订单 ' + order.id + ' 核销留档',
    boundTo: order.userId, orderId: order.id,
    usedAt: new Date(t).toISOString(), usedBy: order.userId,
  };
  doc.codes.push(code);
  order.status = 'fulfilled';
  order.fulfilledAt = code.usedAt;
  order.updatedAt = order.fulfilledAt;
  order.codeId = code.id;
  return { order, code };
}

function orderStatusText(s) {
  return { pending: '待支付', claimed: '待核销', fulfilled: '已开通',
    cancelled: '已取消', expired: '已过期' }[s] || s;
}

/* ---------------- 激活码 ---------------- */

function codeOut(c) {
  return {
    id: c.id, code: c.code, plan: c.plan, months: c.months,
    createdAt: c.createdAt, createdBy: c.createdBy || '', note: c.note || '',
    boundTo: c.boundTo || null, orderId: c.orderId || null,
    expiresAt: c.expiresAt || null,
    usedAt: c.usedAt || null, usedBy: c.usedBy || null,
    status: c.usedAt ? 'used' : (c.expiresAt && Date.now() > Date.parse(c.expiresAt) ? 'expired' : 'unused'),
  };
}

function createCodes(doc, { plan, months, count, note, by, expiresAt, boundTo }) {
  const pid = planOf(doc, plan).id;
  if (!pid || pid === 'Free') return { error: '免费版无需激活码' };
  const n = Math.min(Math.max(Math.round(Number(count) || 1), 1), 200);
  const m = clampMonths(months);
  const out = [];
  for (let i = 0; i < n; i++) {
    let code = newCode();
    // 极小概率碰撞：重生成
    while (doc.codes.some((c) => normCode(c.code) === code)) code = newCode();
    const rec = {
      id: rid('c', 6), code, plan: pid, months: m,
      createdAt: new Date().toISOString(), createdBy: String(by || 'admin'),
      note: String(note || '').slice(0, 80),
      boundTo: boundTo || null, orderId: null,
      expiresAt: expiresAt || null,
      usedAt: null, usedBy: null,
    };
    doc.codes.push(rec);
    out.push(codeOut(rec));
  }
  return { codes: out };
}

function findCode(doc, code) {
  const c = normCode(code);
  if (!c) return null;
  return doc.codes.find((x) => x && normCode(x.code) === c) || null;
}

/**
 * 兑换（用户）：校验 → 绑定 → 开通。
 * 失败原因都写成可读中文，客户端直接展示。
 */
function redeem(doc, code, user, now) {
  const t = now || Date.now();
  const rec = findCode(doc, code);
  if (!rec) return { error: '激活码不存在，请核对后重试（形如 PP-XXXX-XXXX-XXXX）' };
  if (rec.usedAt) {
    return { error: '该激活码已于 ' + new Date(rec.usedAt).toLocaleDateString() + ' 被使用' };
  }
  if (rec.expiresAt && t > Date.parse(rec.expiresAt)) return { error: '该激活码已过期' };
  if (rec.boundTo && rec.boundTo !== user.id) return { error: '该激活码已绑定其他账号，无法在本账号使用' };
  rec.usedAt = new Date(t).toISOString();
  rec.usedBy = user.id;
  if (!rec.boundTo) rec.boundTo = user.id;
  const membership = grantMembership(doc, user, {
    plan: rec.plan, months: rec.months,
    source: rec.orderId ? 'order' : 'code',
    refId: rec.id, note: rec.note || '',
  });
  return { membership, code: codeOut(rec) };
}

module.exports = {
  DAY_MS, ORDER_TTL_MS, MAX_MONTHS,
  DEFAULT_PLANS, DEFAULT_PRICE_OPTIONS, DEFAULT_PAY,
  newDoc, normalize, newCode, normCode,
  planOf, dailyLimitFor, priceOf, clampMonths, plansForClient,
  membershipOf, grantMembership,
  orderOut, reapOrders, createOrder, findOrder, claimOrder, cancelOrder, fulfillOrder,
  orderStatusText,
  codeOut, createCodes, findCode, redeem,
};
