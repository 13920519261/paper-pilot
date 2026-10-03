#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""launcher.ps1 × account-server.js 接线一致性静态扫描（0.23.0）

目的：GUI 无法在无人环境里真实点击，所以用静态检查兜住三类「点了没反应」的静默失败：
  1. launcher 里调用的函数/按钮处理器是否真的定义了（含 Show-MembershipManager 是否挂到主界面）
  2. launcher 调用的每一个 /api/admin/* 接口，服务端路由里是否真的存在
  3. 会员管理对话框里用到的控件变量是否都在同一函数内先创建后使用

用法：python scripts/check-wiring.py     （在仓库根目录）
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PS1 = os.path.join(ROOT, "scripts", "launcher.ps1")
SRV = os.path.join(ROOT, "server", "account-server.js")
ADMIN_HTML = os.path.join(ROOT, "server", "public", "admin.html")

ps = io.open(PS1, encoding="utf-8").read()
srv = io.open(SRV, encoding="utf-8").read()
html = io.open(ADMIN_HTML, encoding="utf-8").read()

problems = []
passes = []


def ok(cond, label):
    (passes if cond else problems).append(label)
    return cond


# ---------- 1. 函数定义 vs 调用 ----------
# 注意：本文件里的自定义函数**大量是嵌套在对话框函数内部的**（带缩进），
# 所以必须匹配行首可带空白的 function，而不是 ^function。
defs = set(re.findall(r"(?m)^[ \t]*function\s+([A-Za-z][\w-]*)", ps))

# 系统 cmdlet 白名单：只列本文件真正用到的，避免把内置命令误判成「未定义函数」
CMDLETS = {
    "Get-ChildItem", "Get-CimInstance", "Get-Date", "Get-Item", "Get-ItemProperty",
    "Get-NetTCPConnection", "Get-Process", "Invoke-Item", "Invoke-RestMethod",
    "New-Item", "New-Object", "Set-Content", "Set-ItemProperty",
    "Start-Sleep", "Stop-Process", "Test-Path",
}

called = set(re.findall(
    r"\b(Show-[A-Za-z]\w*|Refresh-[A-Za-z]\w*|Get-[A-Za-z]\w*|Set-[A-Za-z]\w*|"
    r"New-[A-Za-z]\w*|Start-[A-Za-z]\w*|Stop-[A-Za-z]\w*|Update-[A-Za-z]\w*|"
    r"Format-[A-Za-z]\w*|Invoke-[A-Za-z]\w*|Require-[A-Za-z]\w*|Hide-[A-Za-z]\w*|"
    r"Exit-[A-Za-z]\w*|Test-[A-Za-z]\w*|Resolve-[A-Za-z]\w*)\b", ps))
missing = sorted(c for c in called if c not in defs and c not in CMDLETS)
ok(not missing, "1.1 launcher 调用的自定义函数均已定义 → 缺失: %s" % (missing or "无"))

for must in ["Show-MembershipManager", "Refresh-Membership", "New-MbBtn", "Show-PriceForm",
             "Get-MembershipText", "Get-OrderStatusText", "Get-CodeStatusText", "Format-Dt",
             "Get-PriceRangeText"]:
    ok(must in defs, "1.2 新函数已定义: %s" % must)

ok("价格与周期" in ps, "1.2b launcher 有「价格与周期」标签页")
ok("/api/admin/prices" in ps, "1.2c launcher 调用了价格表接口")

ok("Show-MembershipManager" in re.findall(r"New-Btn\s+\$grpUser\s+'[^']*'\s+\d+\s+\d+\s+\d+\s+\{\s*([A-Za-z]\w*)", ps) or
   bool(re.search(r"New-Btn\s+\$grpUser[^\n]*\{\s*Show-MembershipManager\s*\}", ps)),
   "1.3 主界面「账号管理」分组挂了会员管理入口")

# ---------- 2. launcher 调的接口 vs 服务端路由 ----------
calls = set()
for m in re.finditer(r"Invoke-AdminApi\s+'(\w+)'\s+([^)]*)", ps):
    method, rest = m.group(1), m.group(2)
    path = re.search(r"'([^']*?(?:/api/[^']*|/api/admin[^']*))'", rest)
    if not path:
        path = re.search(r"\('([^']+)'", rest)
    if not path:
        continue
    raw = path.group(1)
    # 把 '(\'/api/admin/users/\' + $u.id + \'/membership\')' 这类拼接归一成模式
    norm = re.sub(r"'\s*\+\s*[^+']+?\+\s*'", "*", raw)
    norm = re.sub(r"\$\w+", "*", norm)
    norm = re.sub(r"\*+", "*", norm)
    calls.add((method.upper(), norm))

ok(bool(calls), "2.1 扫描到 Invoke-AdminApi 调用 %d 处" % len(calls))

# 服务端路由：取出所有 url === '...' / regex 匹配
routes = set()
for m in re.finditer(r"url\s*===\s*'([^']+)'", srv):
    routes.add(m.group(1))
for m in re.finditer(r"url\.match\((/[^)]*/)", srv):
    pat = m.group(1).replace("\\", "")
    routes.add(pat)
for m in re.finditer(r"url\.startsWith\('([^']+)'\)", srv):
    routes.add(m.group(1) + "*")

for method, norm in sorted(calls):
    # 查询串不参与路由匹配（调用方可能把 '?limit=…' 拼进路径）
    norm = norm.split("?")[0]
    seg = norm.split("/api/")[-1]
    probe = "*" + seg
    hit = any(seg in r or (r.endswith("*") and seg.startswith(r[:-1])) or
              re.sub(r"\(\[\^/\]\+\)|\[a-zA-Z0-9-\]\+|[^\\]*", "*", r).replace("*", "") and
              re.sub(r"[^/]+", "*", r) == norm for r in routes)
    # 更宽松的兜底：把路由里的正则段也替换成 *
    loose = any(re.sub(r"\(\?:[^)]*\)|\[[^\]]*\][+*?]?|[^/]+", "*", r) == norm for r in routes)
    ok(hit or loose, "2.2 服务端存在该路由: %s %s" % (method, norm))

for must in ["/api/admin/membership", "/api/admin/codes", "/api/admin/orders",
             "/api/admin/users", "/api/admin/prices"]:
    ok(must in srv, "2.3 服务端含路由前缀 %s" % must)
ok("fulfill" in srv and "membership" in srv, "2.4 服务端含核销与会员开通逻辑")
ok("upsertPriceItem" in srv and "priceItemOut" in srv, "2.5 服务端接入价格表模块")
ok("priority" in srv and "effectiveFrom" in srv, "2.6 服务端支持优先级与生效时段")

# ---------- 3. admin.html 与 launcher 的口径一致 ----------
ok('id="tab-membership"' in html, "3.1 Web 管理页有「会员管理」标签")
ok("loadMembership" in html and "fulfillOrder" in html and "createCodes" in html,
   "3.2 Web 管理页含会员管理核心函数")
ok("grantMembership" in html, "3.3 Web 管理页含用户开通/续期")
ok("openPriceForm" in html and "savePrice" in html and "loadPrices" in html,
   "3.3b Web 管理页含价格表 CRUD")
ok('id="pr-table"' in html and 'id="price-mask"' in html and 'id="pf-cycle"' in html,
   "3.3c Web 管理页有价格表与编辑弹窗")
ok("Team" not in html, "3.4 Web 管理页已去掉 Team 档（只保留 Free/Pro）")
ok("'Team'" not in ps, "3.5 launcher 已去掉 Team 档")

# ---------- 4. 会员对话框控件变量先建后用 ----------
mblock = ps[ps.index("function Show-MembershipManager"):]
mblock = mblock[:mblock.index("\nfunction ", 10)] if "\nfunction " in mblock[10:] else mblock
used = set(re.findall(r"\$(lvO|lvC|lvP|lblTop|selCodePlan|txtCode\w*|txtFreeLimit|txtProLimit|txtProPrice|txtPay\w*|lblPrice)\b", mblock))
built = set()
for v in ["lvO", "lvC", "lvP", "lblTop", "selCodePlan", "txtCodeMonths", "txtCodeCount", "txtCodeNote",
          "txtFreeLimit", "txtProLimit", "txtProPrice", "txtPayChannel", "txtPayQr", "txtPayText",
          "txtPayNote", "lblPrice"]:
    if re.search(r"\$%s\s*=" % v, mblock):
        built.add(v)
unbuilt = sorted(used - built)
ok(not unbuilt, "4.1 会员对话框控件均已创建 → 未创建: %s" % (unbuilt or "无"))

# ---------- 5. Show-PriceForm 的控件先建后用 ----------
pblock = ps[ps.index("function Show-PriceForm"):]
pblock = pblock[:pblock.index("\nfunction ", 10)] if "\nfunction " in pblock[10:] else pblock
pused = set(re.findall(r"\$(selPlan|selCycle|txtMonths|txtPrice|txtLabel|txtPrio|txtNote|dtFrom|dtTo|chkEnabled|lblPer|lblMsg)\b", pblock))
pbuilt = set(v for v in pused if re.search(r"\$%s\s*=" % v, pblock))
ok(not (pused - pbuilt), "5.1 价格表单控件均已创建 → 未创建: %s" % (sorted(pused - pbuilt) or "无"))
ok("$script:mbCycles" in pblock and "$script:mbPricePlans" in pblock,
   "5.2 价格表单读取脚本级周期/等级数据（跨作用域用 $script:）")

# ---------- 6. 运维三件套接线（1.4.2）----------
LIBS = os.path.join(ROOT, "server", "lib")
lib_src = {}
for fname in ["backup.js", "alerts.js", "lockout.js"]:
    p = os.path.join(LIBS, fname)
    exists = os.path.exists(p)
    ok(exists, "6.1 存在 server/lib/%s" % fname)
    lib_src[fname] = io.open(p, encoding="utf-8").read() if exists else ""

for fname, fns in [("backup.js", ["snapshot", "restore", "prune", "list", "policy"]),
                   ("alerts.js", ["backlogOf", "shouldAlert", "record"]),
                   ("lockout.js", ["registerFailure", "durationFor"])]:
    for fn in fns:
        ok(re.search(r"function %s\b" % fn, lib_src[fname]) is not None,
           "6.2 %s 定义 %s()" % (fname, fn))

for must in ["/api/admin/backups", "/api/admin/alerts", "/unlock"]:
    ok(must in srv, "6.3 服务端含运维路由 %s" % must)
ok("backlogCount" in srv and "snapshots" in srv and "lastSnapshotAt" in srv,
   "6.4 health 暴露积压与快照观测字段")
ok("preflight" in io.open(os.path.join(ROOT, "scripts", "preflight.py"), encoding="utf-8").read(),
   "6.5 存在 scripts/preflight.py")

# ---------- 6b. 管理操作审计（服务端 1.4.4）----------
AUDIT_LIB = os.path.join(ROOT, "server", "lib", "audit.js")
ok(os.path.exists(AUDIT_LIB), "6b.1 存在 server/lib/audit.js")
audit_src = io.open(AUDIT_LIB, encoding="utf-8").read() if os.path.exists(AUDIT_LIB) else ""
for fn in ["entry", "redact", "append", "list", "stats", "labelOf"]:
    ok(re.search(r"(function %s\b|const %s\s*=)" % (fn, fn), audit_src) is not None,
       "6b.2 audit.js 定义 %s()" % fn)
ok("SECRET_KEY" in audit_src and "***" in audit_src, "6b.3 audit.js 有密钥脱敏")
ok("/api/admin/audit" in srv, "6b.4 服务端有审计查询路由")
audit_calls = len(re.findall(r"auditLog\(req,", srv))
ok(audit_calls >= 20, "6b.5 管理写操作已接审计（%d 处）" % audit_calls)
for a in ["'user.delete'", "'order.fulfill'", "'price.update'", "'backup.restore'", "'membership.config'"]:
    ok(a in srv, "6b.6 覆盖动作 %s" % a)
ok("auditBytes" in srv, "6b.7 health 暴露审计日志体积")

# 三方 UI 都要能看审计：Web 管理页 + 启动器
ok('id="tab-audit"' in html and 'id="pane-audit"' in html, "6b.8 Web 管理页有审计标签页与面板")
ok("loadAudit" in html and "exportAuditCSV" in html, "6b.9 Web 管理页有加载与导出审计")
ok('id="audit-table"' in html and 'id="a-action"' in html and 'id="a-target"' in html,
   "6b.10 Web 管理页审计表格与筛选控件齐备")
for fn in ["Refresh-Audit", "Get-AuditText", "Format-Bytes", "ConvertTo-ShortJson"]:
    ok(fn in defs, "6b.11 launcher 定义 %s" % fn)
ok("Refresh-Audit" in ps and "/api/admin/audit" in ps, "6b.12 launcher 审计页调用审计接口")
ok(re.search(r"\$pgAudit\s*=", ps) is not None and "审计日志" in ps, "6b.13 launcher 有审计标签页")

# ---------- 9. 永久会员 + 收款流水对账（服务端 1.4.5 / 插件 0.24.5）----------
RC_LIB = os.path.join(ROOT, "server", "lib", "reconcile.js")
ok(os.path.exists(RC_LIB), "9.1 存在 server/lib/reconcile.js")
rc_src = io.open(RC_LIB, encoding="utf-8").read() if os.path.exists(RC_LIB) else ""
for fn in ["parseLine", "parseEntries", "matchPayments", "summarize"]:
    ok(re.search(r"function %s\b" % fn, rc_src) is not None, "9.2 reconcile.js 定义 %s()" % fn)
ok("/api/admin/reconcile" in srv, "9.3 服务端有对账路由")
ok("auditLog(req, 'order.reconcile'" in srv, "9.4 对账核销写审计")
ok("'order.reconcile'" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"), encoding="utf-8").read(),
   "9.5 audit.js 动作表含 order.reconcile")
# 动作中文名跨语言两份，必须同步（MEMORY 里记的纪律）
ok("'order.reconcile'" in ps, "9.6 launcher 的 Get-AuditText 也含 order.reconcile")

MEM_JS = os.path.join(ROOT, "server", "lib", "membership.js")
mem = io.open(MEM_JS, encoding="utf-8").read()
ok("const PERPETUAL = 'perpetual'" in mem, "9.7 membership 定义永久周期常量")
ok("function assignTail" in mem, "9.8 membership 有尾数分配")
ok("function amountCentsOf" in mem, "9.9 membership 有分位金额换算（旧订单兼容）")
ok("perpetual" in mem and "monthsLabel" in mem, "9.10 membership 永久语义（时长文案 / 授予不降级）")

# 后台 Web：永久周期 + 对账面板
for must in ['id="reconcile-mask"', 'id="rc-text"', 'id="rc-table"', 'id="rc-apply-btn"',
             'id="gm-perpetual"']:
    ok(must in html, "9.11 admin.html 含 %s" % must)
for fn in ["openReconcile", "runReconcile", "applyReconcile", "onGrantPerpetual"]:
    ok(("function %s" % fn) in html, "9.12 admin.html 定义 %s()" % fn)
ok("'perpetual'" in html, "9.13 admin.html 价格表单识别永久周期")

# 启动器：对账入口 + 永久周期
ok("Show-ReconcileDialog" in defs, "9.14 launcher 定义 Show-ReconcileDialog")
ok("Get-ReconcileStatusText" in defs, "9.15 launcher 定义 Get-ReconcileStatusText")
ok("对账导入" in ps and "/api/admin/reconcile" in ps, "9.16 launcher 订单页有对账入口并调用接口")
ok("'perpetual'" in ps, "9.17 launcher 价格表单识别永久周期")

# 插件：下单传周期 + 尾数提示 + 永久显示（本节位置在 7/8 之前，直接读文件避免依赖顺序）
_acct_src = io.open(os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js"),
                    encoding="utf-8").read()
_pa_src = io.open(os.path.join(ROOT, "chrome", "content", "prefs-account.js"), encoding="utf-8").read()
ok("async createOrder(plan, months, cycle, couponCode)" in _acct_src,
   "9.18 插件 createOrder 支持周期参数与券码")
ok("perpetual" in _acct_src, "9.19 插件 account.js 读取 perpetual")
ok("tailCents" in _pa_src, "9.20 插件支付面板提示专属尾数")
ok("永久" in _pa_src, "9.21 插件显示「永久」相关文案")

# ---------- 7. 插件设置面板：引用的元素 id 是否真的存在于 prefs.xhtml ----------
# 这类失误的表现就是「点了没反应」——JS 里 $("pp-xxx") 拿到 null，静默什么都不做。
PREFS_JS = os.path.join(ROOT, "chrome", "content", "prefs-account.js")
PREFS_XHTML = os.path.join(ROOT, "chrome", "content", "prefs.xhtml")
prefs_js = io.open(PREFS_JS, encoding="utf-8").read()
prefs_xhtml = io.open(PREFS_XHTML, encoding="utf-8").read()
xhtml_ids = set(re.findall(r'id="([A-Za-z0-9_-]+)"', prefs_xhtml))
# 由 JS 动态创建（el() 里带 id）的元素不算缺失
dyn_ids = set(re.findall(r'el\(\s*"[a-z]+"\s*,\s*\{[^}]*id:\s*"([A-Za-z0-9_-]+)"', prefs_js))
used_ids = set(re.findall(r'\$\("([A-Za-z0-9_-]+)"\)', prefs_js))
used_ids |= set(re.findall(r'bind\("([A-Za-z0-9_-]+)"', prefs_js))
used_ids |= set(re.findall(r'mbSetMsg\("([A-Za-z0-9_-]+)"', prefs_js))
missing_ids = sorted(i for i in used_ids if i not in xhtml_ids and i not in dyn_ids)
ok(not missing_ids, "7.1 prefs-account.js 引用的元素 id 都存在于 prefs.xhtml → 缺失: %s" % (missing_ids or "无"))

for must in ["pp-mb-renew", "pp-mb-usage", "pp-mb-options", "pp-mb-order"]:
    ok(must in xhtml_ids, "7.2 prefs.xhtml 含会员元素 #%s" % must)

# ---------- 8. 0.24.4：价格表 / 到期提醒 / 用量趋势 跨模块接线 ----------
ACCOUNT_JS = os.path.join(ROOT, "chrome", "content", "scripts", "ai", "account.js")
MAIN_JS = os.path.join(ROOT, "chrome", "content", "scripts", "main.js")
PREFS_DEFAULTS = os.path.join(ROOT, "prefs.js")
acct = io.open(ACCOUNT_JS, encoding="utf-8").read()
mainjs = io.open(MAIN_JS, encoding="utf-8").read()
prefsdef = io.open(PREFS_DEFAULTS, encoding="utf-8").read()

for fn in ["renewalReminder()", "lastPurchasedMonths()", "usage()"]:
    ok(fn in acct, "8.1 account.js 定义 %s" % fn)
for k in ["priceItems", "upcoming"]:
    ok(k in acct, "8.2 account.js plans() 下发 %s" % k)
    ok(k in prefs_js, "8.3 prefs-account.js 使用 %s" % k)
ok("renewalReminder" in prefs_js and "lastPurchasedMonths" in prefs_js,
   "8.4 prefs-account.js 使用到期提醒与上次周期")
ok("_checkRenewal" in mainjs and "renewPromptShownFor" in mainjs,
   "8.5 main.js 启动时检查到期提醒")
ok("renewPromptShownFor" in prefsdef, "8.6 prefs.js 有 renewPromptShownFor 默认值")
ok("usageDays" in srv and "usageDaily" in srv, "8.7 服务端实现按日用量与后台下发")
ok("exportUsageCSV" in html, "8.8 Web 管理页有用量 CSV 导出")

# ---------- 9. 1.4.6：优惠券 / 折扣码 ----------
COUPON_LIB = os.path.join(ROOT, "server", "lib", "coupon.js")
ok(os.path.exists(COUPON_LIB), "9.1 存在 server/lib/coupon.js")
coupon_src = io.open(COUPON_LIB, encoding="utf-8").read()
for fn in ["sanitizeCoupon", "stateOf", "computeDiscount", "quote",
           "reserveUse", "consumeUseByOrder", "releaseUseByOrder",
           "couponOut", "couponPublicOut", "createCoupons", "updateCoupon", "removeCoupon"]:
    # 有的是 function 声明、有的是 const 箭头函数 —— 两种形态都要认，否则满屏假失败
    _defined = (re.search(r"function %s\b" % fn, coupon_src) is not None
                or re.search(r"const %s\s*=" % fn, coupon_src) is not None)
    ok(_defined, "9.2 coupon.js 定义 %s()" % fn)
ok("require('./lib/coupon')" in srv, "9.3 服务端引入 coupon 模块")
for must in ["/api/admin/coupons", "/api/coupons/validate", "couponCode"]:
    ok(must in srv, "9.4 服务端含优惠券接线 %s" % must)
ok("quoteOrder" in srv, "9.5 服务端有试算 helper（与下单共用同一取价口径）")
ok("coupons" in srv and "couponsActive" in srv, "9.6 health 暴露优惠券观测字段")
# 订单生命周期必须联动券占用（否则限额会被乱点耗光 / 释放不掉）
for must in ["coupon.releaseUseByOrder", "coupon.consumeUseByOrder", "coupon.reserveUse"]:
    ok(must in srv or must in io.open(os.path.join(ROOT, "server", "lib", "membership.js"),
                                      encoding="utf-8").read(),
       "9.7 订单生命周期联动券占用：%s" % must)
ok("coupon.create" in io.open(os.path.join(ROOT, "server", "lib", "audit.js"),
                              encoding="utf-8").read(), "9.8 审计动作表含 coupon.*")
# 三处 UI
ok("tab-coupon" in html and "pane-coupon" in html and "openCouponForm" in html,
   "9.9 Web 管理页有优惠券标签页与弹窗")
ok("'优惠券'" in ps and "Show-CouponForm" in ps and "Refresh-Coupons" in ps,
   "9.10 启动器有优惠券标签页与对话框")
# 插件端：试算 + 下单带券 + 面板元素存在
ok("validateCoupon" in acct and "couponCode" in acct, "9.11 插件 account.js 支持试算与带券下单")
ok("createOrder(mbSel.plan, mbSel.months, mbSel.cycle," in prefs_js, "9.12 插件下单时传券码")
for eid in ["pp-mb-coupon", "pp-mb-coupon-btn", "pp-mb-quote"]:
    ok(('id="%s"' % eid) in io.open(os.path.join(ROOT, "chrome", "content", "prefs.xhtml"),
                                    encoding="utf-8").read(),
       "9.13 prefs.xhtml 存在优惠码元素 %s" % eid)
    ok(('"%s"' % eid) in prefs_js, "9.14 prefs-account.js 引用 %s" % eid)
ok("pp-mb-quote" in io.open(os.path.join(ROOT, "chrome", "content", "prefs.css"),
                            encoding="utf-8").read(), "9.15 prefs.css 有折后价样式")
# 折后金额的下限保护（不允许 100% 减免 → 免费请用激活码）
ok("MIN_PAYABLE_CENTS" in coupon_src and "MAX_PERCENT = 99" in coupon_src,
   "9.16 优惠券守住「折后至少 ¥1、最多 99%」的下限")
# ★ 尾数必须在**折后**金额上分配，否则「按金额唯一对账」在打折后会失效
mem_src = io.open(os.path.join(ROOT, "server", "lib", "membership.js"), encoding="utf-8").read()
ok("const baseCents = originalCents - discountCents;" in mem_src
   and "assignTail(doc, baseCents" in mem_src,
   "9.17 尾数在折后金额上分配（保住按金额唯一对账）")
# ---------- 输出 ----------
print("=" * 60)
for p in passes:
    print("  OK  " + p)
if problems:
    print("-" * 60)
    for p in problems:
        print("  !!  " + p)
print("=" * 60)
print("接线扫描：%d 通过 / %d 问题" % (len(passes), len(problems)))
sys.exit(1 if problems else 0)
