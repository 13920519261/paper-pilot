#!/usr/bin/env node
/* admin.html 会员管理端到端验证：真实账号服务器 + 无头 Chrome 真点击。
 * 验证「后台 webui 能管理会员」：概览 KPI / 订单核销 / 激活码生成 / 价格表 CRUD /
 * 套餐配置保存 / 用户行「开通·续期」，并检查控制台无 JS 报错。
 *
 * 运行：node test/admin-e2e.test.js
 *   依赖 playwright-core 与系统 Chrome；两者缺一时**优雅跳过**（退出码 0），
 *   以便 preflight 在无浏览器环境也能通过。可用 PP_CHROME=<path> 指定浏览器。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-admin-e2e-'));
const PORT = 19000 + Math.floor(Math.random() * 800);
const SHOT = path.join(os.tmpdir(), 'pp-admin-membership.png');
process.env.PP_DATA_DIR = WORK;
process.env.PP_PORT = String(PORT);
delete process.env.PP_RESEND_KEY;

let chromium = null;                       // playwright-core 缺失时保持 null
try { ({ chromium } = require('playwright-core')); } catch (e) { /* 可选依赖 */ }
const CHROME = process.env.PP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

if (!chromium || !fs.existsSync(CHROME)) {
  console.log('\nadmin.html 会员管理 E2E：跳过（'
    + (!chromium ? '未安装 playwright-core' : '未找到浏览器 ' + CHROME) + '）');
  console.log('  安装：npm i playwright-core   ·   或设 PP_CHROME=<chrome 可执行文件路径>');
  process.exit(0);
}

const { server } = require(path.join(ROOT, 'server', 'account-server.js'));

let pass = 0;
const fails = [];
function ok(c, label, extra) {
  if (c) { pass++; return true; }
  fails.push(label + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : ''));
  return false;
}
function eq(a, b, label) { return ok(a === b, label, { got: a, want: b }); }

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(cs).toString('utf8')); } catch (e) { /* ignore */ }
        resolve({ status: res.statusCode, json: j });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  await new Promise((res) => server.listen(PORT, '127.0.0.1', res));

  // ---- 造数据：一个待核销订单（走真实用户链路）+ 一个 Free 用户 ----
  await req('POST', '/api/auth/register', { email: 'buyer@test.local', password: 'pw12345678', nickname: '买家' });
  const tok = (await req('POST', '/api/auth/login', { email: 'buyer@test.local', password: 'pw12345678' })).json.token;
  const order = (await req('POST', '/api/orders', { plan: 'Pro', months: 12 }, tok)).json.order;
  await req('POST', `/api/orders/${order.id}/claim`, undefined, tok);
  await req('POST', '/api/auth/register', { email: 'free@test.local', password: 'pw12345678' });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const jsErrors = [];
  const badRequests = [];
  page.on('pageerror', (e) => jsErrors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push('console: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) badRequests.push(r.status() + ' ' + r.url()); });
  page.on('dialog', (d) => d.accept());   // 自动确认 confirm()

  try {
    await page.goto(`http://127.0.0.1:${PORT}/admin`, { waitUntil: 'networkidle' });

    ok(await page.locator('#tab-membership').count() === 1, 'E1.1 侧栏出现「会员管理」标签');
    await page.click('#tab-membership');
    await page.waitForSelector('#mb-order-table tbody tr', { timeout: 5000 });

    /* ---- KPI ---- */
    const kReview = await page.textContent('#mb-k-review');
    ok(kReview === '1', 'E2.1 待核销订单 KPI = 1', kReview);
    const kUnused = await page.textContent('#mb-k-unused');
    ok(kUnused === '0', 'E2.2 未使用激活码初始为 0', kUnused);

    /* ---- 订单行内容 ---- */
    const rowText = await page.textContent('#mb-order-table tbody tr');
    ok(rowText.includes(order.id), 'E3.1 订单行显示订单号', rowText.slice(0, 80));
    ok(rowText.includes('buyer@test.local'), 'E3.2 订单行显示用户邮箱');
    ok(rowText.includes('待核销'), 'E3.3 订单行状态为待核销');
    ok(rowText.includes('12 个月'), 'E3.4 显示时长');
    ok(rowText.includes('¥269') || rowText.includes('¥'), 'E3.5 显示金额');

    /* ---- UI 里核销 ---- */
    await page.click('#mb-order-table tbody tr:first-child button:has-text("核销开通")');
    await page.waitForFunction(() => {
      var t = document.querySelector('#mb-order-table tbody tr');
      return t && t.textContent.indexOf('已开通') >= 0;
    }, { timeout: 6000 });
    ok(true, 'E4.1 UI 点击「核销开通」后订单变为已开通');
    const kUsed = await page.textContent('#mb-k-used');
    ok(kUsed === '1', 'E4.2 已核销订单 KPI = 1', kUsed);
    const orderMsg = await page.textContent('#mb-order-msg');
    ok(/留档码 PP-/.test(orderMsg), 'E4.3 核销后提示留档兑换码', orderMsg);

    /* ---- 用户列表里能看到 Pro（核销已自动开通） ---- */
    await page.click('#tab-users');
    await page.waitForSelector('#user-table tbody tr', { timeout: 5000 });
    const usersTxt = await page.textContent('#user-table tbody');
    ok(usersTxt.includes('buyer@test.local'), 'E5.1 用户列表含下单账号');
    ok(usersTxt.includes('剩 ') || usersTxt.includes('Pro'), 'E5.2 用户列表显示会员到期/等级', usersTxt.slice(0, 120));
    ok(usersTxt.includes('开通/续期'), 'E5.3 用户行有「开通/续期」按钮');

    /* ---- 0.24.4：用户列表带「近 7 天」列 + 一键导出用量 CSV ---- */
    const headTxt = await page.textContent('#user-table thead');
    ok(headTxt.includes('近 7 天'), 'E5.4 用户表新增「近 7 天」用量列',
      headTxt.replace(/\s+/g, ' ').slice(0, 120));
    const colIdx = await page.evaluate(() => {
      const ths = Array.prototype.slice.call(document.querySelectorAll('#user-table thead th'));
      return ths.findIndex((t) => t.textContent.trim() === '近 7 天');
    });
    const cellTxt = await page.evaluate((i) => {
      const tr = document.querySelector('#user-table tbody tr');
      return tr ? tr.children[i].textContent.trim() : null;
    }, colIdx);
    ok(colIdx >= 0 && /^\d+$/.test(String(cellTxt)), 'E5.5 每行的近 7 天单元格是数字', cellTxt);

    const dl = page.waitForEvent('download', { timeout: 8000 });
    await page.click('button:has-text("导出用量 CSV")');
    const download = await dl;
    ok(/^paperpilot-usage-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()),
      'E5.6 导出 CSV 文件名规范', download.suggestedFilename());
    const csv = fs.readFileSync(await download.path(), 'utf8');
    ok(csv.charCodeAt(0) === 0xFEFF, 'E5.7 CSV 带 BOM（Excel 里中文不乱码）');
    ok(/邮箱,等级,今日用量,近7天,近30天/.test(csv), 'E5.8 CSV 表头含新增的用量列',
      csv.split(/\r?\n/)[0].slice(0, 80));
    ok(csv.indexOf('buyer@test.local') > 0, 'E5.9 CSV 含用户行', csv.split(/\r?\n/)[1]);

    /* ---- UI 里生成激活码 ---- */
    await page.click('#tab-membership');
    await page.waitForSelector('#code-form');
    await page.fill('#c-months', '3');
    await page.fill('#c-count', '2');
    await page.fill('#c-note', 'E2E 生成');
    await page.click('#code-form button[type=submit]');
    await page.waitForFunction(() => {
      var t = document.getElementById('c-msg');
      return t && /已生成 2 枚/.test(t.textContent);
    }, { timeout: 6000 });
    ok(true, 'E6.1 UI 生成 2 枚激活码并回显码值');
    // 注：E4 核销订单时已自动生成 1 枚「已使用」的留档码，故总数 = 3
    const codeRows = await page.locator('#mb-code-table tbody tr').count();
    ok(codeRows === 3, 'E6.2 激活码表 3 行（2 新生成 + 1 核销留档）', codeRows);
    const unusedRows = await page.locator('#mb-code-table tbody tr:has-text("未使用")').count();
    ok(unusedRows === 2, 'E6.2b 其中 2 枚未使用', unusedRows);
    const kUnused2 = await page.textContent('#mb-k-unused');
    ok(kUnused2 === '2', 'E6.3 未使用激活码 KPI 更新为 2', kUnused2);
    // 取一枚「未使用」的码（核销留档码已被标记使用，不能取到）
    const firstCode = (await page.textContent(
      '#mb-code-table tbody tr:has-text("未使用") .code-cell')).trim();
    ok(/^PP-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(firstCode), 'E6.4 激活码格式正确', firstCode);

    /* ---- 用生成出来的码去激活，验证闭环 ---- */
    await req('POST', '/api/redeem', { code: firstCode }, tok);
    await page.click('#pane-membership .card:nth-of-type(1) button:has-text("刷新")');
    await page.waitForTimeout(500);
    const usedRows = await page.locator('#mb-code-table tbody tr:has-text("已使用")').count();
    ok(usedRows >= 2, 'E7.1 兑换后激活码行显示「已使用」（留档 + 刚兑换）', usedRows);
    const codesTxt = await page.textContent('#mb-code-table tbody');
    ok(codesTxt.includes('buyer@test.local'), 'E7.1b 使用人显示为邮箱而不是裸 ID', codesTxt.slice(0, 120));
    const kUnused3 = await page.textContent('#mb-k-unused');
    ok(kUnused3 === '1', 'E7.2 未使用激活码 KPI 降为 1', kUnused3);

    /* ---- 套餐配置保存 ---- */
    await page.fill('#p-free-limit', '150');
    await page.fill('#p-pro-limit', '2500');
    await page.fill('#p-pay-channel', '微信收款码');
    await page.fill('#p-pay-qr', 'https://example.com/qr.png');
    await page.click('button:has-text("保存配置")');
    await page.waitForFunction(() => {
      var t = document.getElementById('p-msg');
      return t && /已保存/.test(t.textContent);
    }, { timeout: 6000 });
    const health = await req('GET', '/api/health');
    ok(health.json.plans && health.json.plans.indexOf('Pro') >= 0, 'E8.1 健康检查反映套餐域已就绪', health.json.plans);
    const plans = await req('GET', '/api/plans');
    const free = plans.json.plans.find((p) => p.id === 'Free');
    ok(free.dailyLimit === 150, 'E8.2 保存后 Free 额度变为 150（即时生效）', free.dailyLimit);
    ok(plans.json.pay.qrImage === 'https://example.com/qr.png', 'E8.3 收款码图片地址已保存', plans.json.pay);

    /* ---- 用户行「开通/续期」弹窗 ---- */
    await page.click('#tab-users');
    await page.waitForSelector('#user-table tbody tr');
    const grantBtn = page.locator('#user-table tbody tr:has-text("free@test.local") button:has-text("开通/续期")');
    await grantBtn.click();
    await page.waitForSelector('#membership-mask.show', { timeout: 5000 });
    ok(true, 'E9.1 「开通/续期」弹窗打开');
    const curText = await page.textContent('#gm-current');
    ok(/当前/.test(curText), 'E9.2 弹窗显示当前会员状态', curText);
    await page.fill('#gm-months', '2');
    await page.click('#membership-mask button:has-text("确认开通")');
    await page.waitForTimeout(900);
    const usersTxt2 = await page.textContent('#user-table tbody');
    ok(/free@test\.local/.test(usersTxt2), 'E9.3 开通后用户列表仍正常渲染');
    const uDoc = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
    const fu = uDoc.users.find((u) => u.email === 'free@test.local');
    ok(fu && fu.membership && fu.membership.plan === 'Pro', 'E9.4 免费用户已被开通为 Pro', fu && fu.membership);
    ok(fu.membership.months === 2, 'E9.5 开通时长为 2 个月', fu.membership.months);

    /* ---- 注册表单的「初始等级 Pro + 时长」 ---- */
    await page.fill('#u-email', 'vip@test.local');
    await page.fill('#u-password', 'pw12345678');
    await page.selectOption('#u-plan', 'Pro');
    await page.waitForSelector('#u-init-wrap:visible', { timeout: 3000 });
    ok(true, 'E10.1 选 Pro 后出现「Pro 时长」输入框');
    await page.fill('#u-init-months', '6');
    await page.click('#user-form button[type=submit]');
    await page.waitForTimeout(1200);
    const uDoc2 = JSON.parse(fs.readFileSync(path.join(WORK, 'users.json'), 'utf8'));
    const vu = uDoc2.users.find((u) => u.email === 'vip@test.local');
    ok(vu && vu.membership && vu.membership.plan === 'Pro' && vu.membership.months === 6,
      'E10.2 注册即开通 6 个月 Pro', vu && vu.membership);

    /* ---- 价格与计费周期：UI 里新增「未来生效」的促销价 ---- */
    await page.click('#tab-membership');
    await page.waitForSelector('#pr-table tbody tr', { timeout: 5000 });
    const prRows0 = await page.locator('#pr-table tbody tr').count();
    ok(prRows0 === 3, 'E14.1 价格表默认 3 条（1/3/12 月）', prRows0);
    const prTxt = await page.textContent('#pr-table tbody');
    ok(prTxt.includes('按年') && prTxt.includes('按月'), 'E14.2 计费周期列显示中文周期名');
    ok(prTxt.includes('/月'), 'E14.3 显示折合月单价');
    ok(prTxt.includes('当前生效'), 'E14.4 标注了当前生效那条');

    await page.click('#pane-membership button:has-text("＋ 新增价格")');
    await page.waitForSelector('#price-mask.show', { timeout: 5000 });
    ok(true, 'E15.1 新增价格弹窗打开');
    await page.selectOption('#pf-cycle', 'monthly');
    await page.fill('#pf-months', '1');
    await page.fill('#pf-price', '19');
    await page.fill('#pf-label', '双十一限时');
    await page.fill('#pf-priority', '1');
    // 生效起飞：设为明天（未生效）
    const tomorrow = new Date(Date.now() + 86400e3);
    const pad = function (n) { return (n < 10 ? '0' : '') + n; };
    const localStr = tomorrow.getFullYear() + '-' + pad(tomorrow.getMonth() + 1) + '-' + pad(tomorrow.getDate())
      + 'T' + pad(tomorrow.getHours()) + ':' + pad(tomorrow.getMinutes());
    await page.fill('#pf-from', localStr);
    const preview = await page.textContent('#pf-preview');
    ok(/未生效/.test(preview), 'E15.2 预览提示「保存后为未生效」', preview);
    ok(/折合 ¥19 \/ 月/.test(preview), 'E15.3 预览算出折合月单价', preview);
    await page.click('#price-mask button:has-text("保存")');
    await page.waitForFunction(() => {
      var t = document.getElementById('pr-msg');
      return t && t.textContent.indexOf('已保存价格') >= 0;
    }, { timeout: 6000 });
    const prRows1 = await page.locator('#pr-table tbody tr').count();
    ok(prRows1 === 4, 'E15.4 价格表变为 4 条', prRows1);
    const prTxt2 = await page.textContent('#pr-table tbody');
    ok(prTxt2.includes('未生效'), 'E15.5 新条目状态为未生效');
    const saveMsg = await page.textContent('#pr-msg');
    ok(/重叠/.test(saveMsg), 'E15.6 与基础价重叠 → 界面提示优先级规则', saveMsg);

    /* ---- 未生效价格不能被下单：客户端接口确认 ---- */
    const plansAfter = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).text()));
    ok(!plansAfter.priceItems.some((i) => i.months === 1 && i.price === 19),
      'E16.1 未生效促销价不在可购清单');
    ok(plansAfter.upcoming.some((i) => i.months === 1 && i.price === 19),
      'E16.2 未生效促销价出现在 upcoming 预告');

    /* ---- UI 里改成立即生效 + 提高优先级 → 覆盖基础价 ---- */
    const promoRow = page.locator('#pr-table tbody tr:has-text("未生效")').first();
    await promoRow.locator('button:has-text("编辑")').click();
    await page.waitForSelector('#price-mask.show');
    await page.fill('#pf-from', '');
    await page.fill('#pf-to', '');
    await page.fill('#pf-priority', '5');
    await page.click('#price-mask button:has-text("保存")');
    await page.waitForFunction(() => {
      var t = document.getElementById('pr-msg');
      return t && t.textContent.indexOf('已保存价格') >= 0;
    }, { timeout: 6000 });
    const plansNow = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).text()));
    const one = plansNow.priceItems.filter((i) => i.months === 1);
    ok(one.length === 1 && one[0].price === 19, 'E17.1 立即生效后促销价成为唯一胜者', one);

    /* ---- UI 里停用促销 → 回到基础价 ---- */
    const promoRow2 = page.locator('#pr-table tbody tr:has-text("双十一限时")').first();
    await promoRow2.locator('button:has-text("停用")').click();
    await page.waitForTimeout(700);
    const plansOff = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).text()));
    ok(plansOff.priceItems.filter((i) => i.months === 1)[0].price === 29,
      'E17.2 停用后回到基础价 29', plansOff.priceItems.filter((i) => i.months === 1));
    const prTxt3 = await page.textContent('#pr-table tbody');
    ok(prTxt3.includes('已停用'), 'E17.3 UI 状态显示已停用');

    /* ---- 删除 ---- */
    // 全局 dialog 处理器已自动 accept，这里不要再挂 once，否则两个处理器抢同一个对话框会报错
    await page.locator('#pr-table tbody tr:has-text("双十一限时")').first()
      .locator('button:has-text("删除")').click();
    await page.waitForTimeout(900);
    const prRows2 = await page.locator('#pr-table tbody tr').count();
    ok(prRows2 === 3, 'E18.1 删除后回到 3 条', prRows2);

    /* ---- 套餐额度保存仍可用（原有能力不回归） ---- */
    await page.fill('#p-free-limit', '150');
    await page.click('button:has-text("保存配置")');
    await page.waitForFunction(() => {
      var t = document.getElementById('p-msg');
      return t && /已保存/.test(t.textContent);
    }, { timeout: 6000 });
    const health2 = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).text()));
    ok(typeof health2.priceActive === 'number' && health2.priceActive === 3,
      'E19.1 health 反映生效价格数 = 3', health2.priceActive);

    /* ---- 服务端 1.4.5：永久会员（价格表单）+ 收款流水对账自动核销 ---- */
    await page.click('#tab-membership');
    await page.waitForTimeout(300);
    await page.click('button:has-text("新增价格")');
    await page.waitForSelector('#price-mask.show');
    await page.selectOption('#pf-plan', 'Pro');
    await page.selectOption('#pf-cycle', 'perpetual');
    const monthsDisabled = await page.evaluate(() => document.getElementById('pf-months').disabled);
    const monthsVal = await page.inputValue('#pf-months');
    ok(monthsDisabled === true && monthsVal === '0',
      'E21.1 选「永久」后月数自动置 0 并禁用', { monthsDisabled, monthsVal });
    const prevTxt = await page.textContent('#pf-preview');
    ok(/永久/.test(prevTxt), 'E21.2 预览说明这是永久会员（不按月折算）', prevTxt);
    await page.fill('#pf-price', '128');
    await page.fill('#pf-label', '永久');
    await page.click('#price-mask button:has-text("保存")');
    await page.waitForFunction(() => {
      var t = document.getElementById('pr-msg');
      return t && t.textContent.indexOf('已保存价格') >= 0;
    }, { timeout: 6000 });
    const prTxtPerp = await page.textContent('#pr-table tbody');
    ok(prTxtPerp.includes('永久'), 'E21.3 价格表出现「永久」条目', prTxtPerp.slice(0, 120));
    const plansPerp = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/api/plans`)).text()));
    const perpItem = plansPerp.priceItems.filter((i) => i.cycle === 'perpetual')[0];
    ok(!!perpItem && perpItem.price === 128, 'E21.4 /api/plans 下发永久价 ¥128（插件档位卡据此显示）', perpItem);

    // 下永久订单（模拟插件传 cycle=perpetual）→ 拿带尾数的实付金额
    await req('POST', '/api/auth/register', { email: 'perpatest@test.local', password: 'pw12345678' });
    const ptok = (await req('POST', '/api/auth/login',
      { email: 'perpatest@test.local', password: 'pw12345678' })).json.token;
    const porder = (await req('POST', '/api/orders', { plan: 'Pro', cycle: 'perpetual' }, ptok)).json.order;
    ok(porder.perpetual === true && porder.tailCents >= 1, 'E21.5 永久订单带唯一尾数', porder);

    await page.click('#tab-membership');
    await page.waitForTimeout(400);
    const ordTxt = await page.textContent('#mb-order-table tbody');
    ok(ordTxt.includes('永久'), 'E21.6 订单表显示「永久」');
    ok(ordTxt.includes('尾数'), 'E21.7 订单表标出专属尾数');

    // 对账：先预览
    const amtTxt = String(porder.amountText).replace('¥', '');
    await page.click('button:has-text("对账导入")');
    await page.waitForSelector('#reconcile-mask.show');
    await page.fill('#rc-text', amtTxt + '\n999.99');
    await page.click('button:has-text("预览匹配")');
    await page.waitForFunction(() => {
      var t = document.getElementById('rc-msg');
      return t && /预览/.test(t.textContent);
    }, { timeout: 6000 });
    const rcMsg1 = await page.textContent('#rc-msg');
    ok(/命中 1/.test(rcMsg1), 'E21.8 预览命中 1 笔', rcMsg1);
    ok(/无对应 1/.test(rcMsg1), 'E21.9 对不上的金额标为「无对应订单」', rcMsg1);
    eq(await page.locator('#rc-table tbody tr').count(), 2, 'E21.10 预览列出 2 条流水');
    const rcRowTxt = await page.textContent('#rc-table tbody');
    ok(rcRowTxt.includes('perpatest@test.local'), 'E21.11 预览显示对应用户邮箱');
    const beforeFulfill = (await req('GET', '/api/admin/orders')).json.orders.find((o) => o.id === porder.id);
    eq(beforeFulfill.status, 'pending', 'E21.12 预览不改数据（订单仍未核销）');

    await page.click('#rc-apply-btn');
    await page.waitForFunction(() => {
      var t = document.getElementById('rc-msg');
      return t && /已核销/.test(t.textContent);
    }, { timeout: 8000 });
    const afterFulfill = (await req('GET', '/api/admin/orders')).json.orders.find((o) => o.id === porder.id);
    eq(afterFulfill.status, 'fulfilled', 'E21.13 确认后订单已核销开通');
    const pme = (await req('GET', '/api/auth/me', null, ptok)).json.user;
    eq(pme.membership.perpetual, true, 'E21.14 用户成为永久会员');
    eq(pme.membership.expiresAt, null, 'E21.15 永久会员无到期日');
    await page.click('#reconcile-mask button:has-text("关闭")');
    await page.waitForTimeout(200);

    /* ---- 服务端 1.4.4：审计日志标签页（放在流程末尾，此时已积累多种管理操作） ---- */
    await page.click('#tab-audit');
    await page.waitForSelector('#audit-table tbody tr', { timeout: 5000 });
    const auditRows = await page.locator('#audit-table tbody tr').count();
    ok(auditRows >= 6, 'E20.1 审计页列出记录（核销/改价/套餐配置等）', auditRows);
    const auditTxt = await page.textContent('#audit-table tbody');
    ok(auditTxt.indexOf('127.0.0.1') >= 0, 'E20.2 审计行含来源 IP', auditTxt.slice(0, 140));
    ok(/成功|失败/.test(auditTxt), 'E20.3 每行标了结果');
    ok(auditTxt.indexOf('核销') >= 0, 'E20.4 有核销订单的记录');
    const actOpts = await page.evaluate(() => document.getElementById('a-action').options.length);
    ok(actOpts > 5, 'E20.5 操作类型下拉被填充', actOpts);
    const statTxt = await page.textContent('#a-stat');
    ok(/日志体积/.test(statTxt), 'E20.6 显示日志体积与上限', statTxt);

    // 筛选：只看核销
    await page.selectOption('#a-action', 'order.fulfill');
    await page.click('button:has-text("应用筛选")');
    await page.waitForTimeout(400);
    const filtered = await page.locator('#audit-table tbody tr').count();
    ok(filtered === 1 && filtered < auditRows, 'E20.7 按动作筛选只剩核销记录', { auditRows, filtered });
    await page.selectOption('#a-action', '');
    await page.click('button:has-text("应用筛选")');
    await page.waitForTimeout(400);

    const dl2 = page.waitForEvent('download', { timeout: 8000 });
    await page.click('button:has-text("导出 CSV")');
    const auditDl = await dl2;
    ok(/^paperpilot-audit-\d{4}-\d{2}-\d{2}\.csv$/.test(auditDl.suggestedFilename()),
      'E20.8 审计 CSV 文件名规范', auditDl.suggestedFilename());
    const auditCsv = fs.readFileSync(await auditDl.path(), 'utf8');
    ok(auditCsv.indexOf('时间,操作,动作代码') > 0, 'E20.9 审计 CSV 表头正确',
      auditCsv.split(/\r?\n/)[0].slice(0, 60));
    ok(auditCsv.indexOf('order.fulfill') > 0, 'E20.10 审计 CSV 含核销记录');
    ok(auditCsv.indexOf('sk-') < 0 && auditCsv.indexOf('$2b$') < 0,
      'E20.11 审计 CSV 不含密钥或密码散列片段');

    const SHOT_AUDIT = path.join(os.tmpdir(), 'pp-admin-audit.png');
    await page.screenshot({ path: SHOT_AUDIT, fullPage: true });
    ok(true, 'E20.12 审计页截图: ' + SHOT_AUDIT);

    await page.click('#tab-membership');
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT, fullPage: true });
    ok(true, 'E11 screenshot: ' + SHOT);

    ok(jsErrors.length === 0, 'E12 页面无 JS 报错', jsErrors.slice(0, 3));
    ok(badRequests.length === 0, 'E13 页面无失败请求（4xx/5xx）', badRequests.slice(0, 3));
  } catch (e) {
    fails.push('异常中断：' + (e && e.stack || e));
  } finally {
    await browser.close();
    server.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  console.log('\nadmin.html 会员管理 E2E：' + pass + ' 项通过，' + fails.length + ' 项失败');
  if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
  console.log('  ✓ 全部通过');
})();
