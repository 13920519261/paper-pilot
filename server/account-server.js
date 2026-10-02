#!/usr/bin/env node
/* PaperPilot 账号后台 · account-server.js（Node >= 14，零依赖）
 *
 * 实现 Zotero 插件 0.14.0 账号系统契约（docs/账号系统与模型通道.md）：
 *   POST /api/auth/register  {email,password,nickname} → {ok,user}（公开自助注册，固定 Free）
 *   POST /api/auth/login     {email,password} → {ok,token,expiresAt,user} | 401
 *   POST /api/auth/logout    Bearer → {ok:true}
 *   GET  /api/auth/me        Bearer → {ok,user,expiresAt}（滑动续期）
 *   GET  /v1/models          Bearer → OpenAI 格式
 *   POST /v1/chat/completions Bearer → 转发活动通道上游（SSE 流式透传，auto→通道模型）
 *   GET  /register           公开自助注册页（public/register.html）
 *
 * 会员域（服务端 1.4.3，插件 0.24.4；Free / Pro 两档 + 价格表，全部配置化）：
 *   GET  /api/plans                 公开 → {plans, priceOptions, priceItems, upcoming, cycles, pay}
 *   GET  /api/membership            Bearer → {membership(等级/到期/剩余天数/额度/历史), user(含用量趋势)}
 *   GET  /api/auth/me               Bearer → user 内附带 usage:{today,limit,last7,days[30]}
 *   POST /api/orders                Bearer {plan,months} → 下单（订单号+金额+收款信息）
 *   GET  /api/orders/:id            Bearer → 订单状态
 *   POST /api/orders/:id/claim      Bearer → 标记「我已完成支付」，等管理员核销
 *   POST /api/orders/:id/cancel     Bearer → 取消未支付订单
 *   POST /api/redeem                Bearer {code} → 激活码兑换（绑定账号 + 叠加续期）
 * 会员管理（仅本机直连）：
 *   GET  /api/admin/membership      订单 + 激活码 + 套餐/价格表/收款配置一览
 *   PUT  /api/admin/membership      改套餐额度 / 收款信息（局部更新；仍兼容旧的 priceOptions 写法）
 *   GET  /api/admin/prices          价格表全量（含未生效/已过期/已停用）+ 计费周期预设
 *   POST /api/admin/prices          新增价格条目 {plan, cycle, months, price, label,
 *                                   effectiveFrom, effectiveTo, enabled, note}
 *   PUT  /api/admin/prices/:id      改价格条目（局部更新，用于改价 / 定时生效 / 启停）
 *   DELETE /api/admin/prices/:id    删除价格条目
 *   GET  /api/admin/orders          订单列表
 *   POST /api/admin/orders/:id/fulfill | /cancel   核销（自动开通）/ 取消
 *   GET|POST /api/admin/codes       激活码列表 / 批量生成
 *   DELETE /api/admin/codes/:id     作废未使用的激活码
 *   POST /api/admin/users/:id/membership           直接给用户开通/续期（叠加式）
 * 数据：server/data/membership.json（套餐 / 价格表 priceItems / 收款 / 订单 / 激活码）
 * ★ 价格表 = 等级 × 计费周期 × 生效时段；同等级同月数的生效时段不允许重叠（写入校验），
 *   因此「下单价」永远唯一。促销 = 给旧价填 effectiveTo，再新增一条同周期的促销价。
 *
 * 令牌生命周期（0.15.1 / 服务端 1.3.1，修「更新后被迫重新登录」）：
 *   TTL 30 天（PP_TOKEN_TTL_MS 可覆盖，测试用）；/api/auth/me 与 /v1/* 网关调用
 *   均滑动续期——用户只要在用（含仅用 AI 而不重启 Zotero 的场景）令牌就一直有效，
 *   不再出现「距上次重启 >7 天，更新后首次校验 401 → 被登出」。
 *
 * 公网部署（Cloudflare Tunnel）：
 *   cloudflared 回源 http://localhost:8000，socket 恒为回环但带 CF-Connecting-IP 头。
 *   clientIp() 取真实访客 IP（限速按真实 IP 计）；管理接口/管理页仅认「本机直连」
 *   （回环 socket 且无代理头）——公网用户只能注册/登录/调网关，摸不到管理面。
 *
 * 本机管理 API（仅本机直连，供启动管理器 GUI 与 /admin 管理页）：
 *   GET    /api/health
 *   GET    /admin                       浏览器管理页（public/admin.html）
 *   GET    /api/admin/providers         厂商预设目录
 *   用户：GET/POST /api/admin/users · PUT /api/admin/users/:id
 *         POST /api/admin/users/:id/password · DELETE /api/admin/users/:id
 *   通道：GET/POST /api/admin/channels · PUT/DELETE /api/admin/channels/:id
 *         PUT /api/admin/channels/active · POST /api/admin/channels/:id/test
 *         GET /api/admin/channels/:id/models · POST /api/admin/channels/detect
 *   上线：PUT /api/admin/channels/published {models:[...]}（0.15.0 对外上线模型清单，
 *         空数组=全部上线；/v1/models 只返回上线模型，显式调用未上线模型返回 400）
 *
 * 数据：server/data/users.json（scrypt 密码散列 + 令牌表，令牌仅存散列）
 *      server/data/channels.json（官方网关上游通道池 + active + publishedModels，
 *      与插件本地通道互不相干）
 *
 * 启动：node account-server.js [--port=8000]（或环境变量 PP_PORT）
 * 用量：官方网关每成功转发一次 chat/completions，当日计数 +1；超 dailyLimit 返回 429。
 */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { JsonStore } = require('./lib/store');
const { PROVIDERS, providerOf, providersForClient } = require('./lib/presets');
const membership = require('./lib/membership');
const backup = require('./lib/backup');
const alerts = require('./lib/alerts');
const lockout = require('./lib/lockout');
const mail = require('./lib/mail');

/* ---------------- 配置 ---------------- */

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number((portArg && portArg.slice(7)) || process.env.PP_PORT || 8000);
const HOST = '127.0.0.1';
// 数据目录：默认 server/data；环境变量 PP_DATA_DIR 可覆盖（测试隔离用）
const DATA_DIR = process.env.PP_DATA_DIR || path.join(__dirname, 'data');
const ADMIN_HTML = path.join(__dirname, 'public', 'admin.html');
const REGISTER_HTML = path.join(__dirname, 'public', 'register.html');
const VERIFY_HTML = path.join(__dirname, 'public', 'verify.html');
const FORGOT_HTML = path.join(__dirname, 'public', 'forgot.html');
const RESET_HTML = path.join(__dirname, 'public', 'reset.html');

/* 本地配置文件 {DATA_DIR}/pp.env（KEY=VALUE 每行；server/data/ 已 gitignore，密钥不进 git）：
 * PP_RESEND_KEY=re_xxx      启用邮箱验证/密码找回（Resend）
 * PP_MAIL_FROM=...          发件人（可选）
 * PP_PUBLIC_URL=https://... 邮件链接前缀（可选，默认按 Host 头推断）
 * 已有的同名进程环境变量优先，不会被覆盖。 */
(function loadEnvFile() {
  try {
    const envPath = path.join(DATA_DIR, 'pp.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[1] && !m[1].startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2];
      }
    }
    log('pp.env loaded (keys:', Object.keys(process.env).filter((k) => /^PP_/.test(k)).join(', ') + ')');
  } catch (e) { log('pp.env load failed:', e.message); }
})();

// 令牌 TTL：默认 30 天，滑动续期（/me 与 /v1/* 网关调用均续期）。
// 0.14.x 的 7 天 + 仅 /me 续期曾导致：用户不重启 Zotero 超过 7 天后令牌悄然过期，
// 下次启动（往往正是插件更新触发的重启）首次校验 401 → 客户端清会话 →「每次更新都要重新登录」。
// PP_TOKEN_TTL_MS 可覆盖（毫秒），E2E 测试用短 TTL 实测续期行为。
const TOKEN_TTL_MS = Number(process.env.PP_TOKEN_TTL_MS) > 0
  ? Number(process.env.PP_TOKEN_TTL_MS) : 30 * 86400e3;
// 限速阈值均可通过环境变量覆盖（PP_*_MAX），既方便按需收紧，也让自动化测试
// 不必为了绕开限速而拉长用例。账号级的锁定策略见 lib/lockout.js（与 IP 限速互补）。
const LOGIN_WINDOW_MS = 60e3;            // 限速窗口
function limitOf(envKey, dft) {
  const n = Number(process.env[envKey]);
  return Number.isFinite(n) && n > 0 ? n : dft;
}
const LOGIN_MAX = limitOf('PP_LOGIN_MAX', 10);     // 登录限速（每 IP 每分钟）
const REDEEM_MAX = limitOf('PP_REDEEM_MAX', 10);   // 激活码兑换限速（每 IP 每分钟，防撞码）
// 每日额度不再写死在这里：0.23.0 起由 membership.json 的套餐配置驱动
// （membership.dailyLimitFor），管理员在用户级的 dailyLimit 覆盖优先级最高。
const REG_MAX = 5;                       // 公开注册限速（每 IP 每分钟）
const MAIL_MAX = 3;                      // 验证/重置邮件请求限速（每 IP 每分钟）
const GATEWAY_MAX = 20;                  // 网关全局限速（每 IP 每分钟，防高频薅上游 Key）
const VERIFY_TTL_MS = 24 * 3600e3;       // 邮箱验证链接有效期
const RESET_TTL_MS = 30 * 60e3;          // 密码重置链接有效期
const GATEWAY_TIMEOUT_MS = 120e3;        // 网关转发上限（流式应答可能较长）

/* ---------------- 存储 ---------------- */

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const usersStore = new JsonStore(path.join(DATA_DIR, 'users.json'), { users: [], tokens: {} });
const channelsStore = new JsonStore(path.join(DATA_DIR, 'channels.json'), { channels: [], active: null });
// 0.23.0 会员域：套餐/价格/收款信息/订单/激活码。
// 首次启动自动落默认配置；v1（无 schemaVersion）文档自动升级，幂等。
const membershipStore = new JsonStore(path.join(DATA_DIR, 'membership.json'), membership.newDoc());
membershipStore.data = membership.normalize(membershipStore.data);
membershipStore.save();
// 1.4.2 订单积压告警状态（重启不丢，避免重复轰炸）
const alertStore = new JsonStore(path.join(DATA_DIR, 'alerts.json'), {});

/* ---------------- 工具 ---------------- */

// 日志：始终写 server-console.log（任何启动方式都有排障日志，不依赖 stdout 重定向）；
// 前台交互（TTY）时额外打印到控制台
const LOG_FILE = path.join(DATA_DIR, 'server-console.log');
function log(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.join(' ');
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* ignore */ }
  if (process.stdout.isTTY) {
    try { console.log(line); } catch (e) { /* stdout 不可用时静默 */ }
  }
}

function uid(prefix) { return prefix + '-' + crypto.randomBytes(6).toString('hex'); }

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ---------------- 用量（近 30 天按日趋势，1.4.3） ----------------
 * 旧结构只有 { date, count }（当日计数，跨天即清零），用户看不到趋势、
 * 也无法判断"这个月用了多少"。这里**在不破坏旧字段的前提下**增加
 * usage.daily = { 'YYYY-MM-DD': count }，只留最近 30 天。
 * 旧数据（只有 date/count）由 usageDays() 现场兼容，无需迁移。
 */

/** 本地时区的 YYYY-MM-DD（与 today() 同口径，避免 UTC 偏移导致跨天错位） */
function isoDay(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const USAGE_KEEP_DAYS = 30;

/** 丢弃 keepDays 之前的按日记录（字符串比较即可，YYYY-MM-DD 天然有序） */
function pruneUsageDaily(daily, refDay, keepDays) {
  if (!daily || typeof daily !== 'object') return daily;
  const n = Number(keepDays) > 0 ? Number(keepDays) : USAGE_KEEP_DAYS;
  const refMs = Date.parse((refDay || today()) + 'T00:00:00');
  if (Number.isNaN(refMs)) return daily;
  const cutoff = isoDay(refMs - (n - 1) * 86400e3);
  for (const k of Object.keys(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < cutoff) delete daily[k];
  }
  return daily;
}

/**
 * 记一次用量。dayKey 可注入（单测用），默认今天。
 * 同时维护 { date, count }（旧契约）与 { daily }（新趋势）。
 */
function bumpUsage(user, dayKey) {
  const d = dayKey || today();
  if (!user.usage || typeof user.usage !== 'object') user.usage = {};
  if (!user.usage.daily || typeof user.usage.daily !== 'object') user.usage.daily = {};
  if (user.usage.date !== d) { user.usage.date = d; user.usage.count = 0; }
  user.usage.count = (Number(user.usage.count) || 0) + 1;
  user.usage.daily[d] = (Number(user.usage.daily[d]) || 0) + 1;
  pruneUsageDaily(user.usage.daily, d);
  return user.usage;
}

/**
 * 取最近 n 天（含当天）的按日用量，缺日补 0 —— 前端画图直接可用。
 * 无 daily 的旧账号：把 { date, count } 当作那一天的值，其余为 0。
 */
function usageDays(user, days, endDay) {
  const n = Math.max(1, Math.min(90, Number(days) || USAGE_KEEP_DAYS));
  const u = (user && user.usage) || {};
  const daily = (u.daily && typeof u.daily === 'object') ? u.daily : {};
  const end = endDay || today();
  const endMs = Date.parse(end + 'T00:00:00');
  const base = Number.isNaN(endMs) ? Date.now() : endMs;
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = isoDay(base - i * 86400e3);
    let c = Number(daily[key]) || 0;
    if (!c && u.date === key) c = Number(u.count) || 0;   // 旧数据兜底
    out.push({ date: key, count: c });
  }
  return out;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function verifyPassword(user, password) {
  const h = Buffer.from(hashPassword(password, user.salt), 'hex');
  const s = Buffer.from(user.hash, 'hex');
  return h.length === s.length && crypto.timingSafeEqual(h, s);
}

function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 4) + '****' + k.slice(-4);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 5 * 1024 * 1024)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 原生 http(s) JSON 请求（Title-Case 头名，兼容按大小写提取头的老网关） */
function requestJson(method, url, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('接口地址格式非法')); }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({ 'Accept': 'application/json' }, headers || {});
    if (payload) {
      h['Content-Type'] = h['Content-Type'] || 'application/json';
      h['Content-Length'] = payload.length;
    }
    const req = mod.request(u, { method, headers: h, timeout: timeoutMs || 10000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: r.statusCode, data, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('连接超时')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function netErrorText(e) {
  const msg = (e && e.message) || String(e);
  if (/timed?\s*out|timeout/i.test(msg)) return '连接超时';
  if (/ECONNREFUSED/i.test(msg)) return '无法连接（服务未启动或地址不对）';
  return '网络错误：' + msg.slice(0, 120);
}

/** 客户端真实 IP：经 Cloudflare Tunnel/反向代理回源时 socket 恒为回环，取代理头 */
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).split(',')[0].trim();
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** 管理请求判定：必须「本机直连」= 回环 socket 且无代理头。
 *  Tunnel/反代回源虽也来自回环，但必带 CF-Connecting-IP / X-Forwarded-For——
 *  一律视为公网请求并拒绝管理访问（公网只开放注册/登录/网关）。 */
function isLocalAdmin(req) {
  if (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']) return false;
  const ra = req.socket.remoteAddress || '';
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}

function slug(name, fallback) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback || 'ch';
}

/* ---------------- 账号域 ---------------- */

function planEffective(user) {
  // 套餐有效期过期 → 降级 Free 限额（不踢下线，插件端契约无需新增错误码）
  if (user.expiresAt && Date.now() > new Date(user.expiresAt).getTime()) return 'Free';
  return user.plan || 'Free';
}

/**
 * 每日额度（0.23.0 起由套餐配置驱动）：
 *   管理员在用户级显式设置的 dailyLimit 优先 → 否则取该等级在 membership.json
 *   里配置的 dailyLimit。等级/额度调整只需改后台配置，无需动代码。
 */
function dailyLimitOf(user) {
  if (Number(user.dailyLimit) > 0) return Number(user.dailyLimit);
  return membership.dailyLimitFor(membershipStore.data, planEffective(user));
}

function dailyUsedOf(user) {
  return user.usage && user.usage.date === today() ? Number(user.usage.count) || 0 : 0;
}

/** 客户端可见的用户对象（docs 契约字段 + 0.23.0 会员视图） */
function userForClient(user) {
  const out = {
    email: user.email,
    name: user.nickname || user.email,
    plan: planEffective(user),
    dailyUsed: dailyUsedOf(user),
    dailyLimit: dailyLimitOf(user),
    status: user.status === 'pending' ? 'pending' : 'active',
    membership: membership.membershipOf(membershipStore.data, user),
    // 1.4.3 用量趋势（近 30 天按日；days 供前端画图，last7 为近 7 天合计）
    usage: {
      today: dailyUsedOf(user),
      limit: dailyLimitOf(user),
      last7: usageDays(user, 7).reduce((s, d) => s + d.count, 0),
      days: usageDays(user, USAGE_KEEP_DAYS),
    },
  };
  if (user.expiresAt) out.expiresAt = user.expiresAt; // 套餐有效期（可缺省）
  return out;
}

function findUserByEmail(email) {
  return usersStore.data.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase()) || null;
}

function findUserById(id) {
  return usersStore.data.users.find((u) => u.id === id) || null;
}

function pruneTokens() {
  const now = Date.now();
  let changed = false;
  for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
    if (!rec || rec.expiresAt < now || !findUserById(rec.userId)) {
      delete usersStore.data.tokens[tok];
      changed = true;
    }
  }
  if (changed) usersStore.save();
}

/** 令牌仅存散列（数据文件泄露也不至于直接拿到可用令牌） */
function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function issueToken(userId) {
  const token = 'pp-' + crypto.randomBytes(24).toString('hex');
  usersStore.data.tokens = usersStore.data.tokens || {};
  usersStore.data.tokens[tokenKey(token)] = { userId, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

/** 一次性令牌（邮箱验证 / 密码重置）：仅存 SHA-256 散列 + 有效期 */
function oneTimeToken() { return crypto.randomBytes(24).toString('hex'); }

function findUserByOneTimeToken(field, token) {
  const hash = tokenKey(String(token || ''));
  const now = Date.now();
  for (const u of usersStore.data.users) {
    const rec = u[field];
    if (rec && rec.hash === hash) {
      if (rec.expiresAt < now) return { user: u, expired: true };
      return { user: u, expired: false };
    }
  }
  return null;
}

function userByToken(req) {
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!auth) return null;
  const rec = (usersStore.data.tokens || {})[tokenKey(auth)];
  if (!rec || rec.expiresAt < Date.now()) return null;
  const user = findUserById(rec.userId);
  return user || null;
}

function touchToken(req) {
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const rec = auth && (usersStore.data.tokens || {})[tokenKey(auth)];
  if (rec) rec.expiresAt = Date.now() + TOKEN_TTL_MS; // 滑动续期
}

/** 滑动续期（网关高频路径用）：内存即时续期，磁盘落盘按 30s 节流——
 *  避免每次 AI 调用都重写 users.json（含密码散列，文件不小）。停机/崩溃兜底：
 *  shutdown 时强制落盘；即便丢最后一次续期也只是提前一天过期，无安全影响。 */
let _tokenSaveTimer = null;
function touchTokenSoon(req) {
  const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const rec = auth && (usersStore.data.tokens || {})[tokenKey(auth)];
  if (!rec) return;
  rec.expiresAt = Date.now() + TOKEN_TTL_MS;
  if (!_tokenSaveTimer) {
    _tokenSaveTimer = setTimeout(() => {
      _tokenSaveTimer = null;
      try { usersStore.save(); } catch (e) { log('token touch save failed:', e.message); }
    }, 30e3);
    if (typeof _tokenSaveTimer.unref === 'function') _tokenSaveTimer.unref();
  }
}

const rateAttempts = new Map(); // key → [ts]
function rateThrottled(key, max, windowMs) {
  const now = Date.now();
  const list = (rateAttempts.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) { rateAttempts.set(key, list); return true; }
  list.push(now);
  rateAttempts.set(key, list);
  return false;
}

function countUsage(user) {
  bumpUsage(user);
  usersStore.save();
}

/* ---------------- 通道域（官方网关上游池） ---------------- */

function sanitizeModels(list) {
  if (!Array.isArray(list)) return undefined;
  const out = [];
  for (const m of list) {
    const s = String(m == null ? '' : m).trim();
    if (s && s.length <= 120 && !out.includes(s)) out.push(s);
    if (out.length >= 200) break;
  }
  return out;
}

function validExtra(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  return extra;
}

function channelOut(c) {
  return {
    id: c.id, name: c.name || c.id, provider: c.provider || '',
    baseUrl: c.baseUrl, apiKeyMasked: maskKey(c.apiKey),
    model: c.model || 'auto', models: Array.isArray(c.models) ? c.models : [],
    extraBody: c.extraBody || {}, timeoutMs: c.timeoutMs || 12000,
  };
}

function providerNoKey(providerId, baseUrl) {
  if (providerId === 'ollama') return true;
  return /127\.0\.0\.1|localhost/.test(String(baseUrl || ''));
}

/** 通道 upsert（与插件端 channels.js 校验规则一致；编辑时 apiKey 留空=保持原值） */
function upsertChannel(input, existingId) {
  if (!input || typeof input !== 'object') return { error: '参数缺失' };
  const channels = channelsStore.data.channels;
  const id = String(input.id || existingId || '').trim();
  if (!/^[a-z0-9-]+$/.test(id)) return { error: '通道 id 必填（小写字母/数字/连字符）' };
  const idx = channels.findIndex((c) => c && c.id === id);
  const existing = idx >= 0 ? channels[idx] : null;

  const apiKey = String(input.apiKey || '') || (existing && existing.apiKey) || '';
  const baseUrl = String(input.baseUrl || (existing && existing.baseUrl) || '').replace(/\/+$/, '');
  if (!baseUrl && !(existing && existing.baseUrl)) return { error: '接口地址 baseUrl 必填' };
  const provider = input.provider !== undefined
    ? String(input.provider || '').slice(0, 40) : (existing && existing.provider) || '';
  if (!apiKey && !providerNoKey(provider, baseUrl)) {
    return { error: 'API Key 必填（本地 Ollama 等免密接口除外）' };
  }
  const models = sanitizeModels(input.models);
  const clean = {
    id,
    name: String(input.name || (existing && existing.name) || id).slice(0, 60),
    provider,
    baseUrl,
    apiKey,
    model: String(input.model || (existing && existing.model) || 'auto'),
    models: models !== undefined ? models : (existing && Array.isArray(existing.models) ? existing.models : []),
    extraBody: validExtra(input.extraBody) || (existing && existing.extraBody) || {},
    timeoutMs: Number(input.timeoutMs) || (existing && existing.timeoutMs) || 12000,
  };
  if (idx >= 0) channels[idx] = clean; else channels.push(clean);
  if (!channelsStore.data.active) channelsStore.data.active = clean.id;
  channelsStore.save();
  return { channel: clean };
}

/** GET {baseUrl}/models → {ok,models,latencyMs} | {ok:false,error} */
async function fetchModelsOf({ baseUrl, apiKey, timeoutMs }) {
  const t0 = Date.now();
  const bu = String(baseUrl || '').trim().replace(/\/+$/, '');
  let r;
  try {
    r = await requestJson('GET', bu + '/models',
      apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}, undefined, timeoutMs || 8000);
  } catch (e) { return { ok: false, error: netErrorText(e) }; }
  if (r.status >= 400) {
    const hint = r.status === 401 || r.status === 403 ? '（密钥无效或无权限）' : '';
    return { ok: false, error: 'HTTP ' + r.status + hint };
  }
  const data = r.data || {};
  const raw = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
  const models = [];
  for (const m of raw) {
    const s = typeof m === 'string' ? m : String((m && (m.id || m.name)) || '').trim();
    if (s && !models.includes(s)) models.push(s);
    if (models.length >= 300) break;
  }
  if (!models.length) return { ok: false, error: '上游未返回任何模型' };
  return { ok: true, models, latencyMs: Date.now() - t0 };
}

/** 按密钥格式圈定候选厂商（特异格式唯一；与插件端同源逻辑） */
function candidatesByKey(apiKey) {
  const k = String(apiKey || '').trim();
  if (!k) return [];
  const uniq = PROVIDERS.filter((p) => p.keyHint && p.keyHint.unique && p.keyHint.re.test(k));
  if (uniq.length) return uniq;
  const generic = PROVIDERS.filter((p) => p.keyHint && !p.keyHint.unique && p.keyHint.re.test(k));
  if (generic.length) return generic;
  return PROVIDERS.filter((p) => !p.custom && p.baseUrl && !/127\.0\.0\.1|localhost/.test(p.baseUrl));
}

/** 自动探测：有 baseUrl 直探；只有 key 按格式圈候选并行探，首个应答者胜出 */
async function detectChannel({ apiKey, baseUrl, timeoutMs }) {
  const key = String(apiKey || '').trim();
  const bu = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!key && !bu) return { ok: false, error: 'apiKey 与 baseUrl 至少填一项' };

  if (bu) {
    const preset = PROVIDERS.find((p) => p.baseUrl &&
      (bu === p.baseUrl || bu.startsWith(p.baseUrl + '/') || p.baseUrl.startsWith(bu + '/')));
    const r = await fetchModelsOf({ baseUrl: bu, apiKey: key, timeoutMs });
    if (!r.ok) return { ok: false, error: r.error, provider: preset ? preset.id : 'custom', baseUrl: bu, models: [] };
    return { ok: true, provider: preset ? preset.id : 'custom', providerName: preset ? preset.name : '自定义接口',
      baseUrl: bu, models: r.models, latencyMs: r.latencyMs };
  }

  const cands = candidatesByKey(key).slice(0, 10);
  if (!cands.length) return { ok: false, error: '无法根据密钥格式识别厂商，请手动填写接口地址' };
  const results = await Promise.all(cands.map(async (p) => {
    const r = await fetchModelsOf({ baseUrl: p.baseUrl, apiKey: key, timeoutMs: timeoutMs || 8000 });
    return r.ok ? { provider: p, models: r.models, latencyMs: r.latencyMs } : null;
  }));
  const matches = results.filter(Boolean);
  if (!matches.length) {
    const uniqueHit = cands.length === 1 && cands[0].keyHint && cands[0].keyHint.unique;
    return {
      ok: false, tried: cands.map((p) => p.id),
      provider: uniqueHit ? cands[0].id : '',
      error: uniqueHit
        ? '密钥格式像「' + cands[0].name + '」但探测失败（密钥无效/欠费/网络不可达），已按该厂商预填，可手动修正'
        : '所有候选厂商探测均失败（密钥无效或网络不可达），请手动填写接口地址',
    };
  }
  const best = matches[0];
  return { ok: true, provider: best.provider.id, providerName: best.provider.name,
    baseUrl: best.provider.baseUrl, models: best.models, latencyMs: best.latencyMs,
    matches: matches.map((m) => m.provider.id) };
}

/** 通道实测：小负荷一次调用，预算内对 5xx/超时/网络抖动重试一次 */
async function testChannelById(id) {
  const c = channelsStore.data.channels.find((x) => x && x.id === id);
  if (!c) return { ok: false, error: '通道不存在' };
  if (!c.apiKey && !providerNoKey(c.provider, c.baseUrl)) return { ok: false, error: '该通道缺少 API Key' };
  const t0 = Date.now();
  const body = {
    model: c.model || 'auto',
    messages: [
      { role: 'system', content: '你是连通性测试助手，用一句中文回答。' },
      { role: 'user', content: '请回复：通道正常' },
    ],
    temperature: 0.4,
    max_tokens: 120,
    ...(c.extraBody || {}),
  };
  const once = async (timeoutMs) => {
    let r;
    try {
      r = await requestJson('POST', String(c.baseUrl).replace(/\/+$/, '') + '/chat/completions',
        { 'Authorization': 'Bearer ' + (c.apiKey || ''), 'Content-Type': 'application/json' },
        body, timeoutMs);
    } catch (e) {
      return { error: netErrorText(e), retryable: true };
    }
    if (r.status >= 400) {
      return { error: 'HTTP ' + r.status + (r.status === 401 || r.status === 403 ? '（密钥无效或未授权）' : ''),
        retryable: r.status >= 500 || r.status === 429 };
    }
    const msg = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message;
    const text = msg && msg.content ? String(msg.content).trim() : '';
    if (!text) return { error: '模型返回内容为空', retryable: true };
    return { text, model: (r.data && r.data.model) || c.model, latencyMs: Date.now() - t0 };
  };
  const budget = c.timeoutMs || 12000;
  const deadline = Date.now() + budget;
  let r = await once(budget);
  if (r.error && r.retryable && deadline - Date.now() >= 800) {
    await new Promise((ok) => setTimeout(ok, 350));
    r = await once(deadline - Date.now());
  }
  if (r.error) return { ok: false, error: r.error };
  return { ok: true, model: r.model, latencyMs: r.latencyMs, reply: (r.text || '').slice(0, 60) };
}

/* ---------------- 官方网关（/v1/*） ---------------- */

function activeChannel() {
  const doc = channelsStore.data;
  if (!doc.active) return null;
  return doc.channels.find((c) => c && c.id === doc.active) || null;
}

/** 对外上线模型清单（0.15.0）：channels.json 顶层 publishedModels。
 * 空/缺省 = 全部上线（兼容既有部署）；非空 = 仅上线清单内模型（auto 恒放行）。
 * 后台据此控制官方模型分批上线：不一次性暴露全部上游模型。 */
function publishedModels() {
  const s = sanitizeModels(channelsStore.data.publishedModels);
  return s || [];
}

function gatewayModels() {
  const pub = publishedModels();
  const c = activeChannel();
  const out = ['auto'];
  const src = pub.length ? pub : ((c && c.models) || []);
  for (const m of src) {
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** 转发 chat/completions：auto→通道模型、合并 extraBody、SSE 透传、用量计数 */
function gatewayChat(req, res, user) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 8 * 1024 * 1024) { json(res, 413, { ok: false, error: '请求体过大' }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', async () => {
    let body = {};
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
    catch (e) { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); }

    // 全局限速：每 IP 每分钟 GATEWAY_MAX 次（正常科研对话远低于此；防高频脚本薅上游 Key）
    if (rateThrottled('gw:' + clientIp(req), GATEWAY_MAX, LOGIN_WINDOW_MS)) {
      return json(res, 429, { ok: false,
        error: '请求过于频繁（每 IP 每分钟 ' + GATEWAY_MAX + ' 次），请稍后再试' });
    }

    const c = activeChannel();
    if (!c) {
      return json(res, 503, { ok: false,
        error: '官方网关尚未配置模型通道：请在「启动管理器」或后台管理页添加并启用一条通道' });
    }

    // 0.15.0 模型上线管控：后台配置了 publishedModels 时，显式指定的模型必须在
    // 上线清单内（auto 恒放行——映射到通道默认模型，由通道 model 字段另行控制）
    const pub = publishedModels();
    if (pub.length) {
      const asked = (!body.model || body.model === 'auto') ? null : String(body.model);
      if (asked && !pub.includes(asked)) {
        return json(res, 400, { ok: false,
          error: '模型 ' + asked + ' 暂未开放。当前开放模型：auto、' + pub.join('、') });
      }
    }

    if (dailyUsedOf(user) >= dailyLimitOf(user)) {
      return json(res, 429, { ok: false,
        error: '今日官方模型用量已达上限（' + dailyLimitOf(user) + ' 次），明日自动重置；或在设置中配置自己的模型通道' });
    }

    // 模型映射与 extraBody 合并（不覆盖调用方已有键）
    const upstreamBody = Object.assign({}, body);
    if (!upstreamBody.model || upstreamBody.model === 'auto') upstreamBody.model = c.model || 'auto';
    for (const [k, v] of Object.entries(c.extraBody || {})) {
      if (!(k in upstreamBody)) upstreamBody[k] = v;
    }
    const payload = Buffer.from(JSON.stringify(upstreamBody), 'utf8');

    let u;
    try { u = new URL(String(c.baseUrl).replace(/\/+$/, '') + '/chat/completions'); }
    catch (e) { return json(res, 500, { ok: false, error: '通道 baseUrl 非法：' + c.baseUrl }); }

    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
      'Accept': body.stream ? 'text/event-stream' : 'application/json',
    };
    if (c.apiKey) headers['Authorization'] = 'Bearer ' + c.apiKey;

    const timeout = Math.min(Number(c.timeoutMs) > 0 ? Number(c.timeoutMs) * 5 : GATEWAY_TIMEOUT_MS, GATEWAY_TIMEOUT_MS);
    const upReq = mod.request(u, { method: 'POST', headers, timeout }, (upRes) => {
      const passHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (['connection', 'transfer-encoding', 'keep-alive'].includes(k)) continue;
        passHeaders[k] = v;
      }
      passHeaders['Cache-Control'] = 'no-store';
      res.writeHead(upRes.statusCode, passHeaders);
      upRes.pipe(res);
      if (upRes.statusCode < 400) {
        upRes.on('end', () => {
          try { countUsage(user); } catch (e) { log('usage count failed:', e.message); }
        });
      }
    });
    upReq.on('timeout', () => {
      upReq.destroy(new Error('上游连接超时'));
    });
    upReq.on('error', (e) => {
      if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
      json(res, 502, { ok: false, error: '上游请求失败：' + netErrorText(e) });
    });
    upReq.write(payload);
    upReq.end();
  });
}

/* ---------------- 快照 / 告警 / 风控（1.4.2 运维三件套） ---------------- */

const PUBLIC_URL_FALLBACK = 'https://pp.xinglintools.top';

function publicUrl() {
  return String(process.env.PP_PUBLIC_URL || PUBLIC_URL_FALLBACK).replace(/\/+$/, '');
}

/**
 * 告警收件人：PP_ALERT_EMAIL（逗号分隔可多个）。
 * 不配置也能跑——只是退化为「只写 alerts.log」，后台会明确提示怎么开。
 * 刻意不默认取 PP_MAIL_FROM（那通常是 noreply，发过去没人看）。
 */
function alertRecipients() {
  return String(process.env.PP_ALERT_EMAIL || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function alertLogPath() { return path.join(DATA_DIR, 'alerts.log'); }

/** alerts.log 追加（保留最后 2000 行，防止无限增长） */
function appendAlertLog(line) {
  const p = alertLogPath();
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { /* 首次写 */ }
  let lines = (text + line + '\n').split('\n');
  if (lines.length > 2000) lines = lines.slice(lines.length - 2000);
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
}

/** alerts.log 尾部若干行（后台直接展示，不用去翻文件） */
function readAlertLogTail(n) {
  try {
    const lines = fs.readFileSync(alertLogPath(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-(n || 20));
  } catch (e) { return []; }
}

/**
 * 改动前打快照。**失败绝不影响主流程**——它是保险，不是前置条件。
 * 同 reason 在节流窗口内只留第一份（保住「这一串改动开始前」的状态）。
 */
function snapshot(reason, opts) {
  try {
    const r = backup.snapshot(DATA_DIR, reason, opts);
    if (!r.skipped) log('snapshot:', r.snapshot.id, '(' + r.snapshot.files.length + ' files)');
    return r;
  } catch (e) {
    log('snapshot FAILED (' + reason + '):', e.message);
    return { ok: false, error: e.message };
  }
}

/** 回滚后把内存 store 换成磁盘内容（否则会继续用回滚前的旧数据对外服务） */
function reloadStores() {
  const before = { users: usersStore.data.users.length, orders: membershipStore.data.orders.length };
  usersStore.reload();
  channelsStore.reload();
  membershipStore.reload();
  membershipStore.data = membership.normalize(membershipStore.data);
  return {
    before,
    after: { users: usersStore.data.users.length, orders: membershipStore.data.orders.length },
  };
}

/** 当前积压视图 */
function backlogNow(now) {
  return alerts.backlogOf(membershipStore.data, { now });
}

/**
 * 巡检一次积压，必要时告警（写 alerts.log + 发邮件）。
 * force=true 忽略去重直接告警（后台「立即测试」用）；dryRun=true 只算不发。
 */
async function runAlertCheck({ now, force, dryRun } = {}) {
  const t = now || Date.now();
  const bl = backlogNow(t);
  const state = (alertStore.data && typeof alertStore.data === 'object') ? alertStore.data : {};
  const need = force ? (bl.count > 0 && bl.over) : alerts.shouldAlert(state, bl, { now: t });
  const view = alerts.view(state, bl);
  if (!need) return { backlog: view, alerted: false, mailed: false };

  const line = alerts.logLine(bl) + ' at=' + new Date(t).toISOString();
  try { appendAlertLog(line); } catch (e) { log('alert log failed:', e.message); }
  log('ALERT', line);

  let mailed = false;
  let mailError = '';
  const to = alertRecipients();
  if (!dryRun && to.length && mail.configured()) {
    try {
      const m = alerts.buildMail(bl, { serverUrl: publicUrl() });
      const r = await mail.send({ subject: m.subject, text: m.text, to: to.join(',') });
      mailed = !!r.ok;
      if (!r.ok) mailError = r.error || '发送失败';
    } catch (e) { mailError = e.message; }
  } else if (to.length && !mail.configured()) {
    mailError = '邮件服务未配置（PP_RESEND_KEY）';
  } else if (!to.length) {
    mailError = '未配置收件人（PP_ALERT_EMAIL）';
  }

  alertStore.data = alerts.record(state, bl, { mailed, now: t });
  try { alertStore.save(); } catch (e) { log('alert state save failed:', e.message); }
  return {
    backlog: alerts.view(alertStore.data, bl), alerted: true, mailed, mailError,
    logPath: alertLogPath(),
  };
}

/** 后台展示用的告警配置与状态 */
function alertStatus() {
  const bl = backlogNow();
  return Object.assign(alerts.view(alertStore.data, bl), {
    mailConfigured: mail.configured(),
    recipients: alertRecipients(),
    logPath: 'server/data/alerts.log',
    hint: alertRecipients().length
      ? ''
      : '邮件告警未启用：在 server/data/pp.env 里加一行 PP_ALERT_EMAIL=你的邮箱 即可（支持逗号分隔多个）；不配则只写 alerts.log。',
  });
}

/* ---------------- 后台任务（订单积压巡检） ---------------- */

let _alertTimer = null;
const ALERT_INTERVAL_MS = Number(process.env.PP_ALERT_INTERVAL_MS) > 0
  ? Number(process.env.PP_ALERT_INTERVAL_MS) : 5 * 60e3;

/**
 * 启动周期任务：每 ALERT_INTERVAL_MS（默认 5 分钟）巡检一次待核销积压。
 * 放在函数里而不是模块顶层 —— 测试 require 本模块时不该凭空多出定时器。
 */
function startBackgroundJobs({ intervalMs } = {}) {
  if (_alertTimer) return _alertTimer;
  const ms = Number(intervalMs) > 0 ? Number(intervalMs) : ALERT_INTERVAL_MS;
  _alertTimer = setInterval(() => {
    runAlertCheck().catch((e) => log('alert check failed:', e.message));
  }, ms);
  if (_alertTimer.unref) _alertTimer.unref();
  log('background jobs started: 订单积压巡检每 ' + Math.round(ms / 60000) + ' 分钟一次');
  return _alertTimer;
}

function stopBackgroundJobs() {
  if (_alertTimer) { clearInterval(_alertTimer); _alertTimer = null; }
}

/* ---------------- 用户管理（管理域） ---------------- */

/**
 * 管理端直接改 plan / expiresAt 时同步会员对象（0.23.0）。
 * 注意语义差别：这里是**覆盖式**设置（以管理员填写的到期日为准），
 * 与「激活码/订单自动开通」的**叠加式续期**不同——后台手改就是最终裁决。
 */
function syncMembershipFromLegacy(user) {
  const plan = user.plan || 'Free';
  if (plan === 'Free') { user.membership = null; return; }
  const prev = user.membership || {};
  user.membership = {
    plan,
    name: membership.planOf(membershipStore.data, plan).name,
    months: prev.months || 0,
    activatedAt: prev.activatedAt || new Date().toISOString(),
    expiresAt: user.expiresAt || null,
    source: 'admin',
    refId: prev.refId || '',
    history: Array.isArray(prev.history) ? prev.history : [],
  };
}

function userAdminOut(u) {
  const lock = lockout.status(u);
  return {
    id: u.id, email: u.email, nickname: u.nickname || '', plan: planEffective(u),
    planRaw: u.plan || 'Free', expiresAt: u.expiresAt || null,
    dailyLimit: dailyLimitOf(u), dailyUsed: dailyUsedOf(u),
    membership: membership.membershipOf(membershipStore.data, u),
    // 1.4.3 用量趋势（后台用户列表 / CSV 导出用）
    usage7: usageDays(u, 7).reduce((s, d) => s + d.count, 0),
    usage30: usageDays(u, USAGE_KEEP_DAYS).reduce((s, d) => s + d.count, 0),
    usageDaily: usageDays(u, USAGE_KEEP_DAYS),
    status: u.status === 'pending' ? 'pending' : 'active',
    createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null,
    // 1.4.2 风控状态：后台用户列表据此显示「已锁定 / 近失败 N 次」
    locked: lock.locked,
    lockUntil: lock.lockUntil,
    lockRemainMinutes: lock.remainMinutes,
    failCount: lock.failCount,
    lastFailAt: lock.lastFailAt,
    lastFailIp: lock.lastFailIp,
  };
}

/**
 * 管理端激活码展示：把 userId 回查成邮箱。
 * 只给后台用的接口加，客户端契约（codeOut）保持不含任何用户标识。
 */
function adminCodeOut(c) {
  const out = membership.codeOut(c);
  const mail = (id) => {
    if (!id) return null;
    const u = findUserById(id);
    return u ? u.email : String(id);
  };
  out.usedByEmail = mail(c.usedBy);
  out.boundToEmail = mail(c.boundTo);
  return out;
}

async function adminCreateUser(input) {
  const email = String(input.email || '').trim();
  const password = String(input.password || '');
  const nickname = String(input.nickname || '').trim().slice(0, 40);
  const plan = ['Free', 'Pro'].includes(input.plan) ? input.plan : 'Free';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: '邮箱格式不正确' };
  if (password.length < 8) return { error: '密码至少 8 位' };
  if (findUserByEmail(email)) return { error: '该邮箱已注册' };
  let expiresAt = null;
  if (input.expiresAt) {
    const t = new Date(input.expiresAt).getTime();
    if (!Number.isNaN(t) && t > Date.now()) expiresAt = input.expiresAt;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: uid('u'), email, nickname: nickname || email.split('@')[0],
    salt, hash: hashPassword(password, salt), plan, expiresAt,
    dailyLimit: input.dailyLimit > 0 ? Number(input.dailyLimit) : null,
    createdAt: new Date().toISOString(), lastLoginAt: null, usage: { date: today(), count: 0 },
  };
  usersStore.data.users.push(user);
  syncMembershipFromLegacy(user);
  pruneTokens();
  usersStore.save();
  log('user created:', email, plan);
  return { user: userAdminOut(user) };
}

function adminUpdateUser(id, input) {
  const user = findUserById(id);
  if (!user) return { error: '用户不存在' };
  if (input.nickname !== undefined) user.nickname = String(input.nickname || '').trim().slice(0, 40);
  if (input.plan !== undefined && ['Free', 'Pro'].includes(input.plan)) user.plan = input.plan;
  if (input.expiresAt !== undefined) {
    const t = new Date(input.expiresAt).getTime();
    user.expiresAt = (input.expiresAt && !Number.isNaN(t)) ? input.expiresAt : null;
  }
  if (input.dailyLimit !== undefined) {
    user.dailyLimit = Number(input.dailyLimit) > 0 ? Number(input.dailyLimit) : null;
  }
  // 等级或到期日被改动 → 同步会员对象（覆盖式，不做叠加）
  if (input.plan !== undefined || input.expiresAt !== undefined) syncMembershipFromLegacy(user);
  usersStore.save();
  return { user: userAdminOut(user) };
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;
  try {
    /* --- 静态与管理页 --- */
    if (method === 'GET' && (url === '/admin' || url === '/admin.html')) {
      if (!isLocalAdmin(req)) return json(res, 403, { ok: false, error: '管理页仅限本机访问' });
      let html;
      try { html = fs.readFileSync(ADMIN_HTML); }
      catch (e) { return json(res, 500, { ok: false, error: 'admin.html 缺失' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    // 浏览器自动请求的站点图标：回 204，避免各公开页控制台出现无意义的 404
    if (method === 'GET' && (url === '/favicon.ico' || url === '/favicon.png')) {
      res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
      return res.end();
    }
    // 公开自助注册页（插件「注册账号」链接指向这里；本机/公网均可访问）
    if (method === 'GET' && url === '/register') {
      let html;
      try { html = fs.readFileSync(REGISTER_HTML); }
      catch (e) { return json(res, 500, { ok: false, error: 'register.html 缺失' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    // 邮箱验证 / 忘记密码 / 重置密码（公开页面，token 走 query）
    if (method === 'GET' && (url === '/verify' || url === '/forgot' || url === '/reset')) {
      const file = { '/verify': VERIFY_HTML, '/forgot': FORGOT_HTML, '/reset': RESET_HTML }[url];
      let html;
      try { html = fs.readFileSync(file); }
      catch (e) { return json(res, 500, { ok: false, error: '页面文件缺失' }); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (method === 'GET' && url === '/api/health') {
      return json(res, 200, {
        ok: true, service: 'paperpilot-account-server', version: '1.4.3',
        uptime: Math.round(process.uptime()), now: new Date().toISOString(),
        mail: mail.configured() ? 'on' : 'off',
        users: usersStore.data.users.length,
        channels: channelsStore.data.channels.length,
        active: channelsStore.data.active || null,
        publishedModels: publishedModels().length, // 0 = 全部上线
        // 0.23.0 会员域
        plans: Object.keys(membershipStore.data.plans || {}),
        orders: membershipStore.data.orders.length,
        ordersAwaitingReview: membershipStore.data.orders.filter((o) => o.status === 'claimed').length,
        codesUnused: membershipStore.data.codes.filter((c) => !c.usedAt).length,
        // 1.4.1 价格表
        priceActive: membershipStore.data.priceItems.filter((i) => membership.priceState(i) === 'active').length,
        priceScheduled: membershipStore.data.priceItems.filter((i) => membership.priceState(i) === 'scheduled').length,
        // 1.4.2 运维观测：订单积压 + 快照
        backlogCount: backlogNow().count,
        backlogOldestMinutes: backlogNow().oldestMinutes,
        backlogOverdue: backlogNow().over,
        snapshots: backup.list(DATA_DIR).length,
        lastSnapshotAt: (backup.latest(DATA_DIR) || {}).at || null,
      });
    }

    /* --- 插件契约：鉴权 --- */
    if (method === 'POST' && url === '/api/auth/register') {
      const ip = clientIp(req);
      if (rateThrottled('register:' + ip, REG_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '注册过于频繁，请稍后再试' });
      }
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      // 公开自助注册：固定 Free 套餐（升级/有效期管理走本机管理页或启动管理器）
      const r = await adminCreateUser(Object.assign({}, input, { plan: 'Free' }));
      if (r.error) return json(res, 400, { ok: false, error: r.error });
      const user = findUserByEmail(r.user.email);
      const base = { email: user.email, name: user.nickname, plan: user.plan };
      if (mail.configured()) {
        // 邮箱验证注册：pending → 验证邮件（24h）；发信失败自动降级为直接激活
        user.status = 'pending';
        const token = oneTimeToken();
        user.verify = { hash: tokenKey(token), expiresAt: Date.now() + VERIFY_TTL_MS };
        const verifyUrl = mail.publicBaseUrl(req) + '/verify?token=' + token;
        const m = await mail.sendVerifyMail(user.email, verifyUrl);
        if (!m.ok) {
          user.status = 'active'; user.verify = null;
          usersStore.save();
          log('verify mail failed, activated directly:', user.email, '|', m.error);
          return json(res, 200, { ok: true, user: Object.assign(base, { status: 'active' }),
            notice: '验证邮件暂不可用（' + m.error + '），账号已直接激活' });
        }
        usersStore.save();
        log('user self-registered (pending verify):', user.email, 'ip', ip);
        return json(res, 200, { ok: true, user: Object.assign(base, { status: 'pending' }),
          notice: '验证邮件已发送到 ' + user.email + '，请在 24 小时内点击邮件中的链接完成激活' });
      }
      log('user self-registered:', user.email, 'ip', ip);
      return json(res, 200, { ok: true, user: Object.assign(base, { status: 'active' }) });
    }

    if (method === 'POST' && url === '/api/auth/resend') {
      const ip = clientIp(req);
      if (rateThrottled('mailresend:' + ip, MAIL_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      }
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const user = findUserByEmail(input.email || '');
      if (user && user.status === 'pending') {
        const token = oneTimeToken();
        user.verify = { hash: tokenKey(token), expiresAt: Date.now() + VERIFY_TTL_MS };
        const m = await mail.sendVerifyMail(user.email,
          mail.publicBaseUrl(req) + '/verify?token=' + token);
        usersStore.save();
        if (m.ok) log('verify mail resent:', user.email);
      }
      // 恒定成功文案：不暴露邮箱是否存在/是否待验证
      return json(res, 200, { ok: true, message: '如果该邮箱待验证，验证邮件已重新发送，请查收（含垃圾邮件箱）' });
    }

    if (method === 'POST' && url === '/api/auth/verify') {
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const hit = findUserByOneTimeToken('verify', input.token);
      if (!hit) return json(res, 400, { ok: false, error: '验证链接无效' });
      if (hit.expired) {
        hit.user.verify = null; usersStore.save();
        return json(res, 400, { ok: false, error: '验证链接已过期——请回到注册页重新发送验证邮件' });
      }
      hit.user.status = 'active';
      hit.user.verify = null;
      usersStore.save();
      log('email verified:', hit.user.email);
      return json(res, 200, { ok: true, message: '邮箱验证成功，现在可以在 Zotero 中登录了' });
    }

    if (method === 'POST' && url === '/api/auth/forgot') {
      const ip = clientIp(req);
      if (rateThrottled('mailforgot:' + ip, MAIL_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' });
      }
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const user = findUserByEmail(input.email || '');
      if (user && user.status !== 'pending' && mail.configured()) {
        const token = oneTimeToken();
        user.reset = { hash: tokenKey(token), expiresAt: Date.now() + RESET_TTL_MS };
        const m = await mail.sendResetMail(user.email,
          mail.publicBaseUrl(req) + '/reset?token=' + token);
        usersStore.save();
        if (m.ok) log('reset mail sent:', user.email);
      }
      // 恒定成功文案：不暴露邮箱是否已注册
      return json(res, 200, { ok: true, message: '如果该邮箱已注册，重置邮件已发送，请在 30 分钟内完成重置' });
    }

    if (method === 'POST' && url === '/api/auth/reset') {
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      if (String(input.password || '').length < 8) {
        return json(res, 400, { ok: false, error: '密码至少 8 位' });
      }
      const hit = findUserByOneTimeToken('reset', input.token);
      if (!hit) return json(res, 400, { ok: false, error: '重置链接无效' });
      if (hit.expired) {
        hit.user.reset = null; usersStore.save();
        return json(res, 400, { ok: false, error: '重置链接已过期——请重新申请忘记密码' });
      }
      const user = hit.user;
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = hashPassword(input.password, user.salt);
      user.reset = null;
      // 重置密码 = 吊销该用户全部既有令牌
      for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
        if (rec && rec.userId === user.id) delete usersStore.data.tokens[tok];
      }
      usersStore.save();
      log('password self-reset:', user.email);
      return json(res, 200, { ok: true, message: '密码已重置，请用新密码在 Zotero 中登录' });
    }

    if (method === 'POST' && url === '/api/auth/login') {
      const ip = clientIp(req);
      if (rateThrottled('login:' + ip, LOGIN_MAX, LOGIN_WINDOW_MS)) {
        return json(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
      }
      let input;
      try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
      const user = findUserByEmail(input.email || '');

      // 账号级风控（1.4.2）：锁定期内**即使密码正确也拒绝**，否则锁定形同虚设
      if (user) {
        const st = lockout.status(user);
        if (st.locked) {
          log('login blocked (locked):', user.email, 'remain=' + st.remainMinutes + 'min', 'ip=' + ip);
          return json(res, 403, { ok: false, code: 'account_locked',
            lockUntil: st.lockUntil, remainMinutes: st.remainMinutes,
            error: lockout.lockedMessage(st) });
        }
      }

      const passOk = !!user && verifyPassword(user, String(input.password || ''));
      if (!passOk) {
        // 邮箱不存在时没有对象可写 —— 由 IP 限速兜底；应答文案与密码错误完全一致，不泄漏账号是否存在
        if (user) {
          const st = lockout.registerFailure(user, { ip });
          usersStore.save();
          if (st.locked) {
            log('account locked:', user.email, 'failCount=' + st.failCount, 'ip=' + ip);
          } else {
            log('login failed:', user.email, 'failCount=' + st.failCount, 'ip=' + ip);
          }
        }
        return json(res, 401, { ok: false, error: lockout.GENERIC_FAIL });
      }
      if (user.status === 'pending') {
        return json(res, 403, { ok: false, code: 'email_unverified',
          error: '邮箱未验证：请查收验证邮件并点击激活链接；未收到可在注册页点「重新发送」' });
      }
      lockout.reset(user);            // 登录成功清零失败计数与锁定
      const token = issueToken(user.id);
      user.lastLoginAt = new Date().toISOString();
      pruneTokens();
      usersStore.save();
      log('login ok:', user.email);
      return json(res, 200, {
        ok: true, token,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
        user: userForClient(user),
      });
    }

    if (method === 'POST' && url === '/api/auth/logout') {
      const auth = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (auth && usersStore.data.tokens && usersStore.data.tokens[tokenKey(auth)]) {
        delete usersStore.data.tokens[tokenKey(auth)];
        usersStore.save();
      }
      return json(res, 200, { ok: true }); // 未带令牌也视为登出成功（幂等）
    }

    if (method === 'GET' && url === '/api/auth/me') {
      const user = userByToken(req);
      if (!user) return json(res, 401, { ok: false, error: '登录已过期' });
      touchToken(req);
      usersStore.save();
      return json(res, 200, {
        ok: true, user: userForClient(user),
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      });
    }

    /* --- 插件契约：会员（0.23.0） --- */

    // 套餐目录：公开接口（未登录也能看价格，便于登录前决策）
    if (method === 'GET' && url === '/api/plans') {
      return json(res, 200, Object.assign({ ok: true }, membership.plansForClient(membershipStore.data)));
    }

    if (url === '/api/membership' || url === '/api/orders' || url === '/api/redeem'
        || url.startsWith('/api/orders/')) {
      const user = userByToken(req);
      if (!user) return json(res, 401, { ok: false, error: '登录已过期' });
      touchTokenSoon(req);

      if (method === 'GET' && url === '/api/membership') {
        return json(res, 200, { ok: true,
          membership: membership.membershipOf(membershipStore.data, user),
          user: userForClient(user) });
      }

      // 激活码兑换：绑定当前账号 + 叠加续期，一步到位
      if (method === 'POST' && url === '/api/redeem') {
        if (rateThrottled('redeem:' + clientIp(req), REDEEM_MAX, LOGIN_WINDOW_MS)) {
          return json(res, 429, { ok: false, error: '尝试过于频繁，请稍后再试' });
        }
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '激活码兑换：' + user.email });
        const r = membership.redeem(membershipStore.data, input.code, user);
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        usersStore.save();
        log('membership redeemed:', user.email, r.code.plan, r.code.months + 'm');
        return json(res, 200, { ok: true, membership: r.membership, user: userForClient(user), code: r.code });
      }

      // 下单：返回订单号 + 金额 + 收款信息；支付与核销在线下完成
      if (method === 'POST' && url === '/api/orders') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        if (membership.reapOrders(membershipStore.data)) membershipStore.save();
        const r = membership.createOrder(membershipStore.data, { user, plan: input.plan, months: input.months });
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('order created:', user.email, r.order.plan, r.order.months + 'm', '¥' + r.order.amount);
        return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, r.order) });
      }

      const om = url.match(/^\/api\/orders\/([a-zA-Z0-9-]+)(\/claim|\/cancel)?$/);
      if (om) {
        const order = membership.findOrder(membershipStore.data, om[1]);
        if (!order || order.userId !== user.id) return json(res, 404, { ok: false, error: '订单不存在' });
        if (method === 'GET' && !om[2]) {
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
        }
        if (method === 'POST' && om[2] === '/claim') {
          const r = membership.claimOrder(membershipStore.data, order, user);
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          log('order claimed (awaiting review):', user.email, order.id);
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
        }
        if (method === 'POST' && om[2] === '/cancel') {
          const r = membership.cancelOrder(membershipStore.data, order, user);
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
        }
      }
      return json(res, 405, { ok: false, error: '该方法不支持：' + method + ' ' + url });
    }

    /* --- 插件契约：官方模型网关 --- */
    if ((url === '/v1/models' || url === '/v1/chat/completions')) {
      const user = userByToken(req);
      if (!user) return json(res, 401, { ok: false, error: '登录已过期' });
      // 0.15.1：网关调用滑动续期（节流落盘）——用户持续使用 AI 即保持登录有效，
      // 不再依赖「重启 Zotero 触发 /me」这一个续期点
      touchTokenSoon(req);
      if (method === 'GET' && url === '/v1/models') {
        return json(res, 200, { object: 'list', data: gatewayModels().map((id) => ({ id, object: 'model' })) });
      }
      if (method === 'POST' && url === '/v1/chat/completions') {
        return gatewayChat(req, res, user);
      }
    }

    /* --- 以下为管理 API：仅本机 --- */
    if (url.startsWith('/api/admin/')) {
      if (!isLocalAdmin(req)) return json(res, 403, { ok: false, error: '管理接口仅限本机调用' });

      if (method === 'GET' && url === '/api/admin/providers') {
        return json(res, 200, { ok: true, providers: providersForClient() });
      }

      /* 用户管理 */
      if (url === '/api/admin/users') {
        if (method === 'GET') {
          return json(res, 200, { ok: true, users: usersStore.data.users.map(userAdminOut) });
        }
        if (method === 'POST') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          snapshot('users-change', { note: '新建用户：' + String(input && input.email || '') });
          const r = await adminCreateUser(input);
          return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, { ok: true, user: r.user });
        }
      }
      let m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)$/);
      if (m) {
        const id = m[1];
        if (method === 'PUT') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          snapshot('users-change', { note: '修改用户：' + id });
          const r = adminUpdateUser(id, input);
          return r.error ? json(res, 404, { ok: false, error: r.error }) : json(res, 200, { ok: true, user: r.user });
        }
        if (method === 'DELETE') {
          const idx = usersStore.data.users.findIndex((u) => u.id === id);
          if (idx < 0) return json(res, 404, { ok: false, error: '用户不存在' });
          snapshot('users-change', { note: '删除用户：' + usersStore.data.users[idx].email });
          log('user deleted:', usersStore.data.users[idx].email);
          usersStore.data.users.splice(idx, 1);
          for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
            if (rec && rec.userId === id) delete usersStore.data.tokens[tok];
          }
          usersStore.save();
          return json(res, 200, { ok: true });
        }
      }
      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/password$/);
      if (m && method === 'POST') {
        const user = findUserById(m[1]);
        if (!user) return json(res, 404, { ok: false, error: '用户不存在' });
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        if (String(input.password || '').length < 8) return json(res, 400, { ok: false, error: '密码至少 8 位' });
        snapshot('users-change', { note: '重置密码：' + user.email });
        user.salt = crypto.randomBytes(16).toString('hex');
        user.hash = hashPassword(input.password, user.salt);
        // 重置密码 = 吊销该用户全部既有令牌 + 顺带解除登录锁定（管理员介入即视为人工放行）
        for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
          if (rec && rec.userId === user.id) delete usersStore.data.tokens[tok];
        }
        lockout.reset(user);
        usersStore.save();
        log('password reset:', user.email);
        return json(res, 200, { ok: true });
      }
      // 1.4.2：一键解锁（连续失败被临时锁定的账号）
      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/unlock$/);
      if (m && method === 'POST') {
        const user = findUserById(m[1]);
        if (!user) return json(res, 404, { ok: false, error: '用户不存在' });
        const st = lockout.status(user);
        lockout.unlock(user);
        usersStore.save();
        log('account unlocked:', user.email, '(was failCount=' + st.failCount + ')');
        return json(res, 200, { ok: true, user: userAdminOut(user),
          note: st.locked ? '已解除锁定' : '该账号当前未被锁定（已顺带清零失败计数）' });
      }

      /* 通道管理 */
      if (url === '/api/admin/channels') {
        if (method === 'GET') {
          return json(res, 200, {
            ok: true,
            channels: channelsStore.data.channels.map(channelOut),
            active: channelsStore.data.active || null,
            publishedModels: publishedModels(), // 0.15.0 对外上线清单（空 = 全部上线）
          });
        }
        if (method === 'POST') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          let id = String(input.id || input.name || '').trim();
          if (input.id && !/^[a-z0-9-]+$/.test(input.id)) {
            return json(res, 400, { ok: false, error: '通道 id 只能含小写字母/数字/连字符' });
          }
          if (!input.id) id = slug(input.name || input.provider || '', 'ch');
          while (channelsStore.data.channels.some((c) => c && c.id === id)) id = id + '-2';
          const r = upsertChannel(Object.assign({}, input, { id }));
          return r.error ? json(res, 400, { ok: false, error: r.error })
            : json(res, 200, { ok: true, channel: channelOut(r.channel) });
        }
      }
      if (url === '/api/admin/channels/active' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const id = String(input.id || '');
        if (!channelsStore.data.channels.some((c) => c && c.id === id)) {
          return json(res, 404, { ok: false, error: '通道不存在' });
        }
        channelsStore.data.active = id;
        channelsStore.save();
        log('active channel ->', id);
        return json(res, 200, { ok: true, active: id });
      }
      // 0.15.0 对外上线模型清单：{ models: [...] }（空数组 = 恢复全部上线）
      if (url === '/api/admin/channels/published' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const list = sanitizeModels(input.models);
        if (list === undefined) return json(res, 400, { ok: false, error: 'models 必须是模型名数组' });
        channelsStore.data.publishedModels = list;
        channelsStore.save();
        log('published models ->', JSON.stringify(list));
        return json(res, 200, { ok: true, publishedModels: list,
          note: list.length ? '仅上线清单内模型（auto 恒放行）' : '已恢复全部上线' });
      }
      if (url === '/api/admin/channels/detect' && method === 'POST') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        const r = await detectChannel(input);
        return json(res, r.ok ? 200 : 400, r);
      }
      m = url.match(/^\/api\/admin\/channels\/([a-z0-9-]+)$/);
      if (m) {
        const id = m[1];
        if (method === 'PUT') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          if (!channelsStore.data.channels.some((c) => c && c.id === id)) {
            return json(res, 404, { ok: false, error: '通道不存在' });
          }
          const r = upsertChannel(Object.assign({}, input, { id }));
          return r.error ? json(res, 400, { ok: false, error: r.error })
            : json(res, 200, { ok: true, channel: channelOut(r.channel) });
        }
        if (method === 'DELETE') {
          const idx = channelsStore.data.channels.findIndex((c) => c && c.id === id);
          if (idx < 0) return json(res, 404, { ok: false, error: '通道不存在' });
          log('channel deleted:', channelsStore.data.channels[idx].name);
          channelsStore.data.channels.splice(idx, 1);
          if (channelsStore.data.active === id) channelsStore.data.active = null;
          channelsStore.save();
          return json(res, 200, { ok: true });
        }
        if (method === 'POST' && url.endsWith('/test')) { /* handled below via /test route */ }
      }
      m = url.match(/^\/api\/admin\/channels\/([a-z0-9-]+)\/test$/);
      if (m && method === 'POST') {
        const r = await testChannelById(m[1]);
        return json(res, r.ok ? 200 : 400, r);
      }
      m = url.match(/^\/api\/admin\/channels\/([a-z0-9-]+)\/models$/);
      if (m && method === 'GET') {
        const c = channelsStore.data.channels.find((x) => x && x.id === m[1]);
        if (!c) return json(res, 404, { ok: false, error: '通道不存在' });
        const r = await fetchModelsOf({ baseUrl: c.baseUrl, apiKey: c.apiKey, timeoutMs: c.timeoutMs });
        if (!r.ok) return json(res, 400, { ok: false, error: r.error });
        // 拉取成功即刷新通道的模型列表缓存（「官方默认模型」下拉与 /v1/models 展示用）
        const models = sanitizeModels(r.models);
        if (models && models.length && JSON.stringify(models) !== JSON.stringify(c.models || [])) {
          c.models = models;
          channelsStore.save();
          log('channel models refreshed:', c.id, models.length);
        }
        return json(res, 200, { ok: true, models: r.models, latencyMs: r.latencyMs });
      }

      /* ---- 会员管理（0.23.0，仅本机） ---- */

      /** 订单 + 激活码 + 套餐配置一览 */
      if (url === '/api/admin/membership' && method === 'GET') {
        if (membership.reapOrders(membershipStore.data)) membershipStore.save();
        const orders = membershipStore.data.orders.slice().reverse()
          .map((o) => Object.assign(membership.orderOut(membershipStore.data, o),
            { userId: o.userId, email: o.email }));
        const codes = membershipStore.data.codes.slice().reverse().map((c) => adminCodeOut(c));
        return json(res, 200, {
          ok: true, orders, codes,
          plans: membership.plansForClient(membershipStore.data),
          priceItems: membershipStore.data.priceItems.map((i) => membership.priceItemOut(membershipStore.data, i)),
          cycles: membership.CYCLE_PRESETS,
          counts: {
            orders: orders.length,
            awaitingReview: orders.filter((o) => o.status === 'claimed').length,
            fulfilled: orders.filter((o) => o.status === 'fulfilled').length,
            codesUnused: codes.filter((c) => c.status === 'unused').length,
            codesUsed: codes.filter((c) => c.status === 'used').length,
            priceActive: membershipStore.data.priceItems
              .filter((i) => membership.priceState(i) === 'active').length,
            priceScheduled: membershipStore.data.priceItems
              .filter((i) => membership.priceState(i) === 'scheduled').length,
          },
        });
      }

      /* ---- 价格表 CRUD（1.4.1：等级 × 计费周期 × 生效时段） ---- */

      /** 全部价格条目（含未生效 / 已过期 / 已停用），供后台列表 */
      if (url === '/api/admin/prices' && method === 'GET') {
        const doc = membershipStore.data;
        return json(res, 200, {
          ok: true,
          items: doc.priceItems
            .slice()
            .sort((a, b) => (a.plan === b.plan ? a.months - b.months : a.plan < b.plan ? -1 : 1))
            .map((i) => membership.priceItemOut(doc, i)),
          cycles: membership.CYCLE_PRESETS,
          plans: Object.values(doc.plans)
            .filter((p) => p.id !== 'Free')
            .map((p) => ({ id: p.id, name: p.name })),
          states: membership.PRICE_STATE_TEXT,
        });
      }

      /** 新增价格条目 */
      if (url === '/api/admin/prices' && method === 'POST') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '新增价格条目' });
        const r = membership.upsertPriceItem(membershipStore.data, input);
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('price item created:', r.item.plan, r.item.months + 'm', '¥' + r.item.price);
        return json(res, 200, { ok: true, warn: r.warn || '',
          item: membership.priceItemOut(membershipStore.data, r.item),
          plans: membership.plansForClient(membershipStore.data) });
      }

      /** 修改 / 启停价格条目（局部更新：未提交字段保持原值） */
      let pm = url.match(/^\/api\/admin\/prices\/([a-zA-Z0-9-]+)$/);
      if (pm && (method === 'PUT' || method === 'DELETE')) {
        const doc = membershipStore.data;
        const cur = doc.priceItems.find((i) => i && i.id === pm[1]);
        if (!cur) return json(res, 404, { ok: false, error: '价格条目不存在' });
        snapshot('membership-change', { note: (method === 'DELETE' ? '删除价格条目 ' : '修改价格条目 ') + pm[1] });
        if (method === 'DELETE') {
          const r = membership.removePriceItem(doc, pm[1]);
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          log('price item deleted:', pm[1], r.item.plan, r.item.months + 'm');
          return json(res, 200, { ok: true, plans: membership.plansForClient(doc) });
        }
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        // 局部更新：只覆盖显式提交的字段，其余沿用现值
        // ⚠️ 新增字段必须同步加进这里，否则「只改 enabled」之类的局部更新会把该字段抹掉
        const merged = {
          id: cur.id, plan: input.plan !== undefined ? input.plan : cur.plan,
          months: input.months !== undefined ? input.months : cur.months,
          price: input.price !== undefined ? input.price : cur.price,
          label: input.label !== undefined ? input.label : cur.label,
          cycle: input.cycle !== undefined ? input.cycle : cur.cycle,
          effectiveFrom: input.effectiveFrom !== undefined ? input.effectiveFrom : cur.effectiveFrom,
          effectiveTo: input.effectiveTo !== undefined ? input.effectiveTo : cur.effectiveTo,
          enabled: input.enabled !== undefined ? input.enabled : cur.enabled,
          priority: input.priority !== undefined ? input.priority : cur.priority,
          note: input.note !== undefined ? input.note : cur.note,
          createdAt: cur.createdAt,
        };
        const r = membership.upsertPriceItem(doc, merged);
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        log('price item updated:', r.item.id, r.item.plan, r.item.months + 'm', '¥' + r.item.price);
        return json(res, 200, { ok: true, warn: r.warn || '',
          item: membership.priceItemOut(doc, r.item),
          plans: membership.plansForClient(doc) });
      }

      /** 改套餐配置 / 收款信息（局部更新，未提交的字段保持原值） */
      if (url === '/api/admin/membership' && method === 'PUT') {
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '改套餐额度/收款配置' });
        const doc = membershipStore.data;
        if (input.plans && typeof input.plans === 'object') {
          for (const [pid, p] of Object.entries(input.plans)) {
            if (!doc.plans[pid] || !p || typeof p !== 'object') continue;
            if (p.dailyLimit !== undefined) doc.plans[pid].dailyLimit = Math.max(0, Number(p.dailyLimit) || 0);
            if (p.price !== undefined) doc.plans[pid].price = Math.max(0, Number(p.price) || 0);
            if (p.name !== undefined) doc.plans[pid].name = String(p.name).slice(0, 20);
            if (p.tagline !== undefined) doc.plans[pid].tagline = String(p.tagline).slice(0, 60);
            if (Array.isArray(p.features)) {
              doc.plans[pid].features = p.features.slice(0, 12).map((s) => String(s).slice(0, 80));
            }
          }
        }
        if (input.pay && typeof input.pay === 'object') {
          if (input.pay.channel !== undefined) doc.pay.channel = String(input.pay.channel).slice(0, 20);
          if (input.pay.qrImage !== undefined) doc.pay.qrImage = String(input.pay.qrImage).slice(0, 500);
          if (input.pay.qrText !== undefined) doc.pay.qrText = String(input.pay.qrText).slice(0, 500);
          if (input.pay.note !== undefined) doc.pay.note = String(input.pay.note).slice(0, 200);
        }
        // 兼容旧后台：提交 priceOptions（平铺档位）时，同步到对应价格条目
        // —— 命中「同等级 + 同月数」的现有条目就改价，没有就新建一条立即生效的价格。
        if (input.priceOptions && typeof input.priceOptions === 'object') {
          for (const [pid, list] of Object.entries(input.priceOptions)) {
            if (!Array.isArray(list)) continue;
            for (const o of list) {
              if (!o) continue;
              const months = membership.clampMonths(o.months);
              const price = Math.max(0, Number(o.price) || 0);
              const exist = doc.priceItems.find((i) => i.plan === pid && i.months === months);
              const r = membership.upsertPriceItem(doc, {
                id: exist ? exist.id : null, plan: pid, months, price,
                label: String(o.label || '').slice(0, 40),
                effectiveFrom: exist ? exist.effectiveFrom : null,
                effectiveTo: exist ? exist.effectiveTo : null,
                enabled: true,
              });
              if (r.error) log('priceOptions 兼容写入失败:', pid, months, r.error);
            }
          }
        }
        membershipStore.save();
        log('membership config updated');
        return json(res, 200, { ok: true, plans: membership.plansForClient(membershipStore.data) });
      }

      if (url === '/api/admin/orders' && method === 'GET') {
        if (membership.reapOrders(membershipStore.data)) membershipStore.save();
        return json(res, 200, {
          ok: true,
          orders: membershipStore.data.orders.slice().reverse()
            .map((o) => Object.assign(membership.orderOut(membershipStore.data, o),
              { userId: o.userId, email: o.email })),
        });
      }

      /** 核销（fulfill）/ 取消（cancel）订单 */
      m = url.match(/^\/api\/admin\/orders\/([a-zA-Z0-9-]+)\/(fulfill|cancel)$/);
      if (m && method === 'POST') {
        const order = membership.findOrder(membershipStore.data, m[1]);
        if (!order) return json(res, 404, { ok: false, error: '订单不存在' });
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空请求体 */ }
        if (m[2] === 'fulfill') {
          const user = findUserById(order.userId);
          if (!user) return json(res, 400, { ok: false, error: '下单账号已不存在（无法开通）' });
          snapshot('orders-change', { note: '核销订单 ' + order.id });
          const r = membership.fulfillOrder(membershipStore.data, order, { by: 'admin' });
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          // 核销即开通：直接给下单账号叠加续期（同时留档一枚已用兑换码）
          membership.grantMembership(membershipStore.data, user, {
            plan: order.plan, months: order.months, source: 'order', refId: order.id,
          });
          membershipStore.save();
          usersStore.save();
          log('order fulfilled:', order.id, user.email, order.plan, order.months + 'm');
          return json(res, 200, {
            ok: true, order: membership.orderOut(membershipStore.data, order),
            archiveCode: membership.codeOut(r.code), user: userAdminOut(user),
          });
        }
        snapshot('orders-change', { note: '取消订单 ' + order.id });
        const r = membership.cancelOrder(membershipStore.data, order, { id: order.userId }, input.reason || '管理员取消');
        if (r.error) return json(res, 400, { ok: false, error: r.error });
        membershipStore.save();
        return json(res, 200, { ok: true, order: membership.orderOut(membershipStore.data, order) });
      }

      /** 激活码：批量生成 / 列表 / 作废（已使用的不可删，保留对账） */
      if (url === '/api/admin/codes') {
        if (method === 'GET') {
          return json(res, 200, { ok: true,
            codes: membershipStore.data.codes.slice().reverse().map((c) => adminCodeOut(c)) });
        }
        if (method === 'POST') {
          let input;
          try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
          snapshot('membership-change', { note: '生成激活码' });
          const r = membership.createCodes(membershipStore.data, {
            plan: input.plan, months: input.months, count: input.count,
            note: input.note, by: 'admin',
            expiresAt: input.expiresAt || null, boundTo: input.boundTo || null,
          });
          if (r.error) return json(res, 400, { ok: false, error: r.error });
          membershipStore.save();
          log('activation codes created:', r.codes.length, input.plan, input.months + 'm');
          return json(res, 200, { ok: true, codes: r.codes });
        }
      }
      m = url.match(/^\/api\/admin\/codes\/([a-zA-Z0-9-]+)$/);
      if (m && method === 'DELETE') {
        const idx = membershipStore.data.codes.findIndex((c) => c && c.id === m[1]);
        if (idx < 0) return json(res, 404, { ok: false, error: '激活码不存在' });
        if (membershipStore.data.codes[idx].usedAt) {
          return json(res, 400, { ok: false, error: '已使用的激活码不能删除（保留对账记录）' });
        }
        membershipStore.data.codes.splice(idx, 1);
        membershipStore.save();
        log('activation code revoked:', m[1]);
        return json(res, 200, { ok: true });
      }

      /** 直接给指定用户开通/续期会员（叠加式，与激活码同语义） */
      m = url.match(/^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/membership$/);
      if (m && method === 'POST') {
        const user = findUserById(m[1]);
        if (!user) return json(res, 404, { ok: false, error: '用户不存在' });
        let input;
        try { input = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
        snapshot('membership-change', { note: '管理员开通/续期：' + user.email });
        const mp = membership.grantMembership(membershipStore.data, user, {
          plan: input.plan || 'Pro', months: input.months || 1,
          source: 'admin', note: input.note || '',
        });
        usersStore.save();
        log('membership granted by admin:', user.email, mp.plan, mp.expiresAt);
        return json(res, 200, { ok: true, membership: mp, user: userAdminOut(user) });
      }

      /* ---- 数据快照与一键回滚（1.4.2） ---- */

      if (url === '/api/admin/backups' && method === 'GET') {
        const items = backup.list(DATA_DIR);
        return json(res, 200, { ok: true, items, policy: backup.policy(),
          latest: items.length ? items[0].id : null });
      }
      if (url === '/api/admin/backups' && method === 'POST') {
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        const r = backup.snapshot(DATA_DIR, 'manual', { note: input && input.note, force: true });
        const pr = backup.prune(DATA_DIR);
        log('manual snapshot:', r.snapshot && r.snapshot.id, 'pruned=' + pr.removed.length);
        return json(res, 200, { ok: true, snapshot: r.snapshot, pruned: pr.removed });
      }
      let bm = url.match(/^\/api\/admin\/backups\/([A-Za-z0-9_-]+)(\/restore)?$/);
      if (bm && method === 'DELETE' && !bm[2]) {
        const snap = backup.find(DATA_DIR, bm[1]);
        if (!snap) return json(res, 404, { ok: false, error: '快照不存在' });
        fs.rmSync(path.join(backup.backupRoot(DATA_DIR), bm[1]), { recursive: true, force: true });
        log('snapshot deleted:', bm[1]);
        return json(res, 200, { ok: true });
      }
      if (bm && method === 'POST' && bm[2]) {
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        // 二次确认：回滚会把全站数据退回旧状态，必须显式回填 RESTORE，杜绝误点
        if (String((input && input.confirm) || '') !== 'RESTORE') {
          return json(res, 400, { ok: false,
            error: '回滚是不可逆操作：请在请求体里带上 {"confirm":"RESTORE"} 以确认' });
        }
        const r = backup.restore(DATA_DIR, bm[1], { note: input && input.note });
        if (r.error) return json(res, 404, { ok: false, error: r.error });
        if (r.mismatched && r.mismatched.length) {
          log('RESTORE HASH MISMATCH:', r.mismatched.join(','));
          return json(res, 500, { ok: false,
            error: '回滚后校验失败：' + r.mismatched.join('、')
              + '（已保留现场快照 ' + r.safety + '，请勿继续操作）', result: r });
        }
        const counts = reloadStores();
        log('restored from:', bm[1], 'safety=' + r.safety, JSON.stringify(counts));
        return json(res, 200, { ok: true, result: r, counts });
      }

      /* ---- 订单积压告警（1.4.2） ---- */

      if (url === '/api/admin/alerts' && method === 'GET') {
        return json(res, 200, { ok: true, alerts: alertStatus(), log: readAlertLogTail(40) });
      }
      if (url === '/api/admin/alerts/check' && method === 'POST') {
        let input = {};
        try { input = await readBody(req); } catch (e) { /* 允许空体 */ }
        const r = await runAlertCheck({ force: true, dryRun: !!(input && input.dryRun) });
        return json(res, 200, { ok: true, result: r, alerts: alertStatus() });
      }
    }

    return json(res, 404, { ok: false, error: 'not found: ' + method + ' ' + url });
  } catch (e) {
    log('ERROR', method, url, e && (e.stack || e.message));
    if (!res.headersSent) json(res, 500, { ok: false, error: '服务器内部错误：' + (e && e.message) });
    else { try { res.end(); } catch (_) { /* ignore */ } }
  }
});

if (require.main === module) {
  // 启动即打一份每日快照并清退过期快照（服务端原本是一份孤本，没有退路）
  try {
    const r = backup.snapshot(DATA_DIR, 'daily', { note: '服务启动快照' });
    const pr = backup.prune(DATA_DIR);
    log('startup snapshot:', (r.snapshot && r.snapshot.id) || ('skipped(' + r.skipped + ')'),
      '| snapshots kept=' + pr.kept, 'pruned=' + pr.removed.length);
  } catch (e) {
    log('startup snapshot failed:', e.message);
  }
  startBackgroundJobs();
  server.listen(PORT, HOST, () => {
    log('PaperPilot account server listening on http://' + HOST + ':' + PORT);
    log('admin page: http://' + HOST + ':' + PORT + '/admin  (loopback only)');
    log('data dir :', DATA_DIR);
    log('token ttl:', Math.round(TOKEN_TTL_MS / 3600e3) + 'h (sliding renewal on /me and /v1/*)');
  });
  const shutdown = (sig) => {
    log('shutdown (' + sig + ')');
    stopBackgroundJobs();
    // 兜底：把网关调用节流续期中尚未落盘的令牌有效期刷盘
    if (_tokenSaveTimer) { clearTimeout(_tokenSaveTimer); _tokenSaveTimer = null; }
    try { usersStore.save(); } catch (e) { log('shutdown save failed:', e.message); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  server, PORT, DATA_DIR,
  startBackgroundJobs, stopBackgroundJobs, runAlertCheck, alertStatus,
  backlogNow, reloadStores, snapshot,
  usageDays, bumpUsage, isoDay, pruneUsageDaily, USAGE_KEEP_DAYS, today,
};
