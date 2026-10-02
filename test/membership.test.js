#!/usr/bin/env node
/* PaperPilot 会员域集成测试（0.23.0 / 服务端 1.4.0）
 *
 * 零依赖、自起自停：用临时 PP_DATA_DIR 起一个账号服务器实例，跑完整购买/激活链路。
 *   node test/membership.test.js
 *
 * 覆盖：套餐目录 → 注册登录 → 下单 → 我已完成支付 → 管理员核销自动开通 →
 *       激活码批量生成 → 兑换 → 重复兑换拦截 → 管理员直开 → 续期叠加 →
 *       过期降级 → 额度随等级变化 → 越权访问订单被拒。
 */
'use strict';

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-membership-'));
const PORT = 18000 + Math.floor(Math.random() * 1200);
process.env.PP_DATA_DIR = DATA_DIR;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY; // 邮件关闭 → 注册直接激活，测试不依赖外网

const serverPath = path.join(__dirname, '..', 'server', 'account-server.js');
const { server } = require(serverPath);

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; return true; }
  failures.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const DAY = 86400e3;
function daysBetween(iso) { return Math.round((Date.parse(iso) - Date.now()) / DAY); }

(async () => {
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));

  try {
    /* 1. 套餐目录（公开，未登录可看） */
    let r = await req('GET', '/api/plans');
    eq(r.status, 200, '1.1 /api/plans 公开可访问');
    const planIds = (r.json.plans || []).map((p) => p.id);
    ok(planIds.includes('Free') && planIds.includes('Pro'), '1.2 套餐含 Free 与 Pro', planIds);
    ok((r.json.priceOptions || []).length >= 3, '1.3 价格档位已下发', r.json.priceOptions);
    const freePlan = r.json.plans.find((p) => p.id === 'Free');
    const proPlan = r.json.plans.find((p) => p.id === 'Pro');
    eq(freePlan.dailyLimit, 100, '1.4 Free 每日额度 = 100');
    eq(proPlan.dailyLimit, 3000, '1.5 Pro 每日额度 = 3000');
    eq(proPlan.purchasable, true, '1.6 Pro 可购买');
    eq(freePlan.purchasable, false, '1.7 Free 不可购买');

    /* 2. 注册 + 登录 */
    r = await req('POST', '/api/auth/register', { email: 'u1@test.local', password: 'pw12345678', nickname: '测试甲' });
    eq(r.status, 200, '2.1 注册成功');
    eq(r.json.user.status, 'active', '2.2 无邮件服务时直接激活');
    const userId = (await req('POST', '/api/auth/login', { email: 'u1@test.local', password: 'pw12345678' }));
    let token = userId.json.token;
    ok(!!token, '2.3 登录拿到令牌');
    eq(userId.json.user.membership.plan, 'Free', '2.4 新用户默认 Free');
    eq(userId.json.user.dailyLimit, 100, '2.5 新用户额度 100');
    eq(userId.json.user.membership.expiresAt, null, '2.6 Free 无到期日');

    /* 3. 下单 */
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 3 }, token);
    eq(r.status, 200, '3.1 下单成功');
    const order = r.json.order;
    eq(order.status, 'pending', '3.2 订单初始为待支付');
    eq(order.amount, 79, '3.3 3 个月走档位价 79');
    eq(order.months, 3, '3.4 订单月数');
    ok(!!order.pay && 'note' in order.pay, '3.5 订单带收款信息');

    r = await req('POST', '/api/orders', { plan: 'Free', months: 1 }, token);
    eq(r.status, 400, '3.6 免费版不可下单');

    /* 4. 越权：另一个账号读不到该订单 */
    await req('POST', '/api/auth/register', { email: 'u2@test.local', password: 'pw12345678' });
    const t2 = (await req('POST', '/api/auth/login', { email: 'u2@test.local', password: 'pw12345678' })).json.token;
    r = await req('GET', '/api/orders/' + order.id, undefined, t2);
    eq(r.status, 404, '4.1 他人订单不可见');

    /* 5. 我已完成支付 → 管理员核销 → 自动开通 */
    r = await req('POST', `/api/orders/${order.id}/claim`, undefined, token);
    eq(r.status, 200, '5.1 标记已支付');
    eq(r.json.order.status, 'claimed', '5.2 状态转待核销');

    r = await req('GET', '/api/admin/membership');
    eq(r.status, 200, '5.3 管理接口本机可访问');
    eq(r.json.counts.awaitingReview, 1, '5.4 待核销计数 = 1');

    r = await req('POST', `/api/admin/orders/${order.id}/fulfill`, {}, undefined);
    eq(r.status, 200, '5.5 核销成功');
    eq(r.json.order.status, 'fulfilled', '5.6 订单已开通');
    eq(r.json.user.membership.plan, 'Pro', '5.7 核销后开通 Pro');
    ok(!!r.json.archiveCode && r.json.archiveCode.status === 'used', '5.8 生成已用留档兑换码');
    const afterFulfill = r.json.user.membership.expiresAt;
    eq(daysBetween(afterFulfill), 90, '5.9 3 个月 = 90 天');

    r = await req('POST', `/api/admin/orders/${order.id}/fulfill`, {}, undefined);
    eq(r.status, 400, '5.10 重复核销被拒（幂等保护）');

    /* 6. /me 反映 Pro */
    r = await req('GET', '/api/auth/me', undefined, token);
    eq(r.json.user.plan, 'Pro', '6.1 /me 返回 Pro');
    eq(r.json.user.dailyLimit, 3000, '6.2 Pro 额度 3000');
    ok(r.json.user.membership.daysLeft >= 89, '6.3 剩余天数 ≥ 89', r.json.user.membership.daysLeft);

    /* 7. 激活码：生成 → 兑换 → 续期叠加 */
    r = await req('POST', '/api/admin/codes', { plan: 'Pro', months: 1, count: 2, note: '线下售卖' });
    eq(r.status, 200, '7.1 批量生成 2 枚激活码');
    eq(r.json.codes.length, 2, '7.2 返回 2 枚');
    const codeA = r.json.codes[0].code;
    const codeB = r.json.codes[1].code;
    ok(/^PP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codeA), '7.3 激活码格式', codeA);

    r = await req('POST', '/api/redeem', { code: codeA }, token);
    eq(r.status, 200, '7.4 兑换成功');
    eq(r.json.membership.plan, 'Pro', '7.5 兑换后 Pro');
    eq(daysBetween(r.json.membership.expiresAt), 120, '7.6 续期叠加：90 → 120 天（剩余时长不吞）');

    r = await req('POST', '/api/redeem', { code: codeA }, token);
    eq(r.status, 400, '7.7 同一激活码重复兑换被拒');
    ok(/已.*使用/.test(r.json.error || ''), '7.8 报错文案说明已被使用', r.json.error);

    r = await req('POST', '/api/redeem', { code: 'PP-XXXX-XXXX-XXXX' }, token);
    eq(r.status, 400, '7.9 不存在的激活码被拒');

    // 小写 / 无分隔符写法也应识别
    const loose = codeB.toLowerCase().replace(/-/g, '');
    r = await req('POST', '/api/redeem', { code: loose }, t2);
    eq(r.status, 200, '7.10 激活码大小写与分隔符不敏感');

    // 已绑定的码不能被别人用
    r = await req('POST', '/api/redeem', { code: codeA }, t2);
    eq(r.status, 400, '7.11 已用激活码他人不可用');

    /* 8. 管理员直接开通（叠加） */
    r = await req('GET', '/api/admin/users');
    const u1 = r.json.users.find((u) => u.email === 'u1@test.local');
    ok(!!u1, '8.1 管理列表含目标用户');
    const before = u1.membership.expiresAt;
    r = await req('POST', `/api/admin/users/${u1.id}/membership`, { plan: 'Pro', months: 1, note: '补偿' });
    eq(r.status, 200, '8.2 管理员直开成功');
    eq(daysBetween(r.json.membership.expiresAt) - daysBetween(before), 30, '8.3 直开同样叠加 30 天');

    /* 9. 过期降级（不踢下线） */
    r = await req('PUT', `/api/admin/users/${u1.id}`, { expiresAt: new Date(Date.now() - DAY).toISOString() });
    eq(r.status, 200, '9.1 管理员把到期日改到昨天');
    r = await req('GET', '/api/auth/me', undefined, token);
    eq(r.status, 200, '9.2 过期不踢下线（仍 200）');
    eq(r.json.user.plan, 'Free', '9.3 过期后有效等级回落 Free');
    eq(r.json.user.dailyLimit, 100, '9.4 额度同步回落到 100');
    eq(r.json.user.membership.expired, true, '9.5 membership.expired 标记为真');
    eq(r.json.user.membership.daysLeft, 0, '9.6 剩余天数 0');

    /* 10. 套餐配置可后台调整 */
    r = await req('PUT', '/api/admin/membership', { plans: { Free: { dailyLimit: 150 } } });
    eq(r.status, 200, '10.1 改 Free 额度');
    r = await req('GET', '/api/auth/me', undefined, token);
    eq(r.json.user.dailyLimit, 150, '10.2 改配置即刻生效（无需重启）');
    r = await req('PUT', '/api/admin/membership', { plans: { Free: { dailyLimit: 100 } } });
    eq(r.json.plans.plans.find((p) => p.id === 'Free').dailyLimit, 100, '10.3 改回 100');

    /* 11. 未登录访问会员接口 */
    r = await req('GET', '/api/membership');
    eq(r.status, 401, '11.1 未登录查会员 → 401');
    r = await req('POST', '/api/orders', { plan: 'Pro', months: 1 });
    eq(r.status, 401, '11.2 未登录下单 → 401');

    /* 12. 持久化：membership.json 与 users.json 均落盘且可重新加载 */
    const mdoc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'membership.json'), 'utf8'));
    eq(mdoc.schemaVersion, 2, '12.1 membership.json 带 schemaVersion');
    ok(mdoc.orders.length >= 1 && mdoc.codes.length >= 3, '12.2 订单与激活码已落盘',
      { orders: mdoc.orders.length, codes: mdoc.codes.length });
    const udoc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8'));
    const su = udoc.users.find((u) => u.email === 'u1@test.local');
    ok(!!su.membership && su.membership.history.length >= 3, '12.3 用户会员历史已落盘',
      su.membership && su.membership.history.length);
    eq(su.plan, su.membership.plan, '12.4 兼容镜像 user.plan 与 membership.plan 一致');
  } catch (e) {
    failures.push('异常中断：' + (e && e.stack || e));
  } finally {
    server.close();
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\n会员域集成测试：' + pass + ' 项通过，' + failures.length + ' 项失败');
  if (failures.length) {
    for (const f of failures) console.log('  ✗ ' + f);
    process.exit(1);
  }
  console.log('  ✓ 全部通过');
})();
