#!/usr/bin/env node
/* PaperPilot 账号后台 · account-server.js（Node >= 14，零依赖）
 *
 * 实现 Zotero 插件 0.14.0 账号系统契约（docs/账号系统与模型通道.md）：
 *   POST /api/auth/register  {email,password,nickname} → {ok,user}（公开自助注册，固定 Free）
 *   POST /api/auth/login     {email,password} → {ok,token,expiresAt,user} | 401
 *   POST /api/auth/logout    Bearer → {ok:true}
 *   GET  /api/auth/me        Bearer → {ok,user,expiresAt}（滑动续期 7 天）
 *   GET  /v1/models          Bearer → OpenAI 格式
 *   POST /v1/chat/completions Bearer → 转发活动通道上游（SSE 流式透传，auto→通道模型）
 *   GET  /register           公开自助注册页（public/register.html）
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
 *
 * 数据：server/data/users.json（scrypt 密码散列 + 令牌表，令牌仅存散列）
 *      server/data/channels.json（官方网关上游通道池，与插件本地通道互不相干）
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

const TOKEN_TTL_MS = 7 * 86400e3;       // 令牌 7 天，/me 滑动续期
const DEFAULT_DAILY_LIMIT = 100;
const LOGIN_WINDOW_MS = 60e3, LOGIN_MAX = 10;   // 登录限速（每 IP 每分钟）
const REG_MAX = 5;                       // 公开注册限速（每 IP 每分钟）
const MAIL_MAX = 3;                      // 验证/重置邮件请求限速（每 IP 每分钟）
const VERIFY_TTL_MS = 24 * 3600e3;       // 邮箱验证链接有效期
const RESET_TTL_MS = 30 * 60e3;          // 密码重置链接有效期
const GATEWAY_TIMEOUT_MS = 120e3;        // 网关转发上限（流式应答可能较长）

/* ---------------- 存储 ---------------- */

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const usersStore = new JsonStore(path.join(DATA_DIR, 'users.json'), { users: [], tokens: {} });
const channelsStore = new JsonStore(path.join(DATA_DIR, 'channels.json'), { channels: [], active: null });

/* ---------------- 工具 ---------------- */

function log(...a) { console.log('[' + new Date().toISOString() + ']', ...a); }

function uid(prefix) { return prefix + '-' + crypto.randomBytes(6).toString('hex'); }

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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

function dailyLimitOf(user) {
  return Number(user.dailyLimit) > 0 ? Number(user.dailyLimit)
    : (planEffective(user) === 'Free' ? DEFAULT_DAILY_LIMIT : 1000);
}

function dailyUsedOf(user) {
  return user.usage && user.usage.date === today() ? Number(user.usage.count) || 0 : 0;
}

/** 客户端可见的用户对象（docs 契约字段） */
function userForClient(user) {
  const out = {
    email: user.email,
    name: user.nickname || user.email,
    plan: planEffective(user),
    dailyUsed: dailyUsedOf(user),
    dailyLimit: dailyLimitOf(user),
    status: user.status === 'pending' ? 'pending' : 'active',
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
  user.usage = { date: today(), count: dailyUsedOf(user) + 1 };
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

function gatewayModels() {
  const c = activeChannel();
  const out = ['auto'];
  for (const m of (c && c.models) || []) {
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

    const c = activeChannel();
    if (!c) {
      return json(res, 503, { ok: false,
        error: '官方网关尚未配置模型通道：请在「启动管理器」或后台管理页添加并启用一条通道' });
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

/* ---------------- 管理域（用户） ---------------- */

function userAdminOut(u) {
  return {
    id: u.id, email: u.email, nickname: u.nickname || '', plan: planEffective(u),
    planRaw: u.plan || 'Free', expiresAt: u.expiresAt || null,
    dailyLimit: dailyLimitOf(u), dailyUsed: dailyUsedOf(u),
    status: u.status === 'pending' ? 'pending' : 'active',
    createdAt: u.createdAt || null, lastLoginAt: u.lastLoginAt || null,
  };
}

async function adminCreateUser(input) {
  const email = String(input.email || '').trim();
  const password = String(input.password || '');
  const nickname = String(input.nickname || '').trim().slice(0, 40);
  const plan = ['Free', 'Pro', 'Team'].includes(input.plan) ? input.plan : 'Free';
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
  pruneTokens();
  usersStore.save();
  log('user created:', email, plan);
  return { user: userAdminOut(user) };
}

function adminUpdateUser(id, input) {
  const user = findUserById(id);
  if (!user) return { error: '用户不存在' };
  if (input.nickname !== undefined) user.nickname = String(input.nickname || '').trim().slice(0, 40);
  if (input.plan !== undefined && ['Free', 'Pro', 'Team'].includes(input.plan)) user.plan = input.plan;
  if (input.expiresAt !== undefined) {
    const t = new Date(input.expiresAt).getTime();
    user.expiresAt = (input.expiresAt && !Number.isNaN(t)) ? input.expiresAt : null;
  }
  if (input.dailyLimit !== undefined) {
    user.dailyLimit = Number(input.dailyLimit) > 0 ? Number(input.dailyLimit) : null;
  }
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
        ok: true, service: 'paperpilot-account-server', version: '1.2.0',
        uptime: Math.round(process.uptime()), now: new Date().toISOString(),
        mail: mail.configured() ? 'on' : 'off',
        users: usersStore.data.users.length,
        channels: channelsStore.data.channels.length,
        active: channelsStore.data.active || null,
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
      if (!user || !verifyPassword(user, String(input.password || ''))) {
        return json(res, 401, { ok: false, error: '邮箱或密码错误' });
      }
      if (user.status === 'pending') {
        return json(res, 403, { ok: false, code: 'email_unverified',
          error: '邮箱未验证：请查收验证邮件并点击激活链接；未收到可在注册页点「重新发送」' });
      }
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

    /* --- 插件契约：官方模型网关 --- */
    if ((url === '/v1/models' || url === '/v1/chat/completions')) {
      const user = userByToken(req);
      if (!user) return json(res, 401, { ok: false, error: '登录已过期' });
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
          const r = adminUpdateUser(id, input);
          return r.error ? json(res, 404, { ok: false, error: r.error }) : json(res, 200, { ok: true, user: r.user });
        }
        if (method === 'DELETE') {
          const idx = usersStore.data.users.findIndex((u) => u.id === id);
          if (idx < 0) return json(res, 404, { ok: false, error: '用户不存在' });
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
        user.salt = crypto.randomBytes(16).toString('hex');
        user.hash = hashPassword(input.password, user.salt);
        // 重置密码 = 吊销该用户全部既有令牌
        for (const [tok, rec] of Object.entries(usersStore.data.tokens || {})) {
          if (rec && rec.userId === user.id) delete usersStore.data.tokens[tok];
        }
        usersStore.save();
        log('password reset:', user.email);
        return json(res, 200, { ok: true });
      }

      /* 通道管理 */
      if (url === '/api/admin/channels') {
        if (method === 'GET') {
          return json(res, 200, {
            ok: true,
            channels: channelsStore.data.channels.map(channelOut),
            active: channelsStore.data.active || null,
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
    }

    return json(res, 404, { ok: false, error: 'not found: ' + method + ' ' + url });
  } catch (e) {
    log('ERROR', method, url, e && (e.stack || e.message));
    if (!res.headersSent) json(res, 500, { ok: false, error: '服务器内部错误：' + (e && e.message) });
    else { try { res.end(); } catch (_) { /* ignore */ } }
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    log('PaperPilot account server listening on http://' + HOST + ':' + PORT);
    log('admin page: http://' + HOST + ':' + PORT + '/admin  (loopback only)');
    log('data dir :', DATA_DIR);
  });
  const shutdown = (sig) => {
    log('shutdown (' + sig + ')');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { server, PORT };
