# ============================================================
# PaperPilot 后台 · 统一控制台 v1（WinForms GUI）
# 双击项目根目录"启动PaperPilot后台.bat"无窗拉起本脚本。
#
# 功能（对标心血管药物学习平台启动管理器，适配 PaperPilot 账号后台）：
#   1. 账号后台控制：启动 / 停止 / 重启 / 查看日志 / 状态灯（端口 8000 健康检测）
#   2. AI 模型通道管理：列表 / 新增 / 编辑 / 删除 / 设为活动 / 实测 / 🔍检测 / 📡拉取模型
#      （通道 = 官方网关上游池；Zotero 插件登录用户经 /v1 网关使用活动通道）
#   3. 账号管理：注册账号 / 用户列表 / 编辑套餐与有效期 / 重置密码 / 删除用户
#   4. 维护：开机自启（HKCU Run 键） / 数据目录 / 项目目录 / 浏览器管理页
#   5. 关闭窗口 = 最小化到系统托盘驻留；托盘右键「退出程序」为唯一真正退出
#
# 兼容 Windows PowerShell 5.1（勿用 PS7+ 语法：禁 ?? ?. 三元 && ||）。
# ============================================================
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic
try { [void][System.Windows.Forms.Application]::EnableVisualStyles() } catch {}

# DPI 感知（须在创建任何窗口前调用）
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class DpiAware{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[void][DpiAware]::SetProcessDPIAware()

# 单实例锁：重复双击直接提示并退出
$script:mutex = New-Object System.Threading.Mutex($false, 'PaperPilotLauncherMutex')
if (-not $script:mutex.WaitOne(0)) {
  [System.Windows.Forms.MessageBox]::Show('控制台已在运行（可能已最小化到系统托盘），请点击托盘图标恢复窗口。', 'PaperPilot 后台', 'OK', 'Information') | Out-Null
  exit
}

# ---------------- 配置 ----------------
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ServerDir   = Join-Path $ProjectRoot 'server'
$DataDir     = Join-Path $ServerDir 'data'
$ServerLog   = Join-Path $DataDir 'server-console.log'
$AdminPage   = 'http://127.0.0.1:8000/admin'
$Port        = 8000
$HealthUrl   = 'http://127.0.0.1:' + $Port + '/api/health'

# ---------------- node 路径：自动扫描最新版本 ----------------
function Resolve-NodeExe {
  $base = 'C:\Users\Administrator\.workbuddy\binaries\node\versions'
  try {
    $dirs = Get-ChildItem $base -Directory -ErrorAction Stop | Where-Object {
      Test-Path (Join-Path $_.FullName 'node.exe')
    } | Sort-Object {
      $k = 0
      if ($_.Name -match '^(\d+)\.(\d+)\.(\d+)') {
        $k = [int]$Matches[1] * 1000000 + [int]$Matches[2] * 1000 + [int]$Matches[3]
      }
      $k
    } -Descending
    if ($dirs -and $dirs.Count -gt 0) { return Join-Path $dirs[0].FullName 'node.exe' }
  } catch {}
  return 'node'
}
$NodeExe = Resolve-NodeExe

# ---------------- 进程/网络检测 ----------------
function Start-HiddenProcess($fileName, $arguments, $workDir) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $fileName
  $psi.Arguments = $arguments
  $psi.WorkingDirectory = $workDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  [System.Diagnostics.Process]::Start($psi) | Out-Null
}

function Get-PortOwnerPid {
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
  } catch {}
  return 0
}

# 兜底判定：命令行匹配（识别"进程在但端口未通"的启动窗口期/僵尸）
function Get-ServerProcess {
  try {
    $list = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
    return @($list | Where-Object {
      $_.CommandLine -and $_.CommandLine.IndexOf('account-server.js') -ge 0
    })
  } catch { return @() }
}

function Test-Health {
  try {
    $r = Invoke-RestMethod -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
    return ($null -ne $r -and $r.ok)
  } catch { return $false }
}

function Get-ProcName([int]$procId) {
  try { return (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { return '' }
}

function Get-ProcessStart([int]$procId) {
  try { return (Get-Process -Id $procId -ErrorAction Stop).StartTime } catch { return $null }
}

# 服务状态机：running（端口通且健康）/ degraded（端口通但健康不过且进程超 30 秒）
#             starting（启动窗口期）/ stopped
function Get-ServerState {
  $portPid = Get-PortOwnerPid
  if ($portPid -gt 0) {
    if (Test-Health) { return @{ State = 'running'; PortPid = $portPid } }
    $started = Get-ProcessStart $portPid
    $age = 999
    if ($started) { $age = ((Get-Date) - $started).TotalSeconds }
    if ($age -lt 30) { return @{ State = 'starting'; PortPid = $portPid } }
    return @{ State = 'degraded'; PortPid = $portPid }
  }
  if ((Get-ServerProcess).Count -gt 0) { return @{ State = 'starting'; PortPid = 0 } }
  return @{ State = 'stopped'; PortPid = 0 }
}

# ---------------- 后台启停 ----------------
function Start-Server {
  $portPid = Get-PortOwnerPid
  if ($portPid -gt 0) {
    $name = Get-ProcName $portPid
    if ($name -eq 'node') { return 'already' }
    return 'occupied:' + $name + ':' + $portPid
  }
  if ((Get-ServerProcess).Count -gt 0) { return 'starting' }
  try {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    if ((Test-Path $ServerLog) -and (Get-Item $ServerLog).Length -gt 20MB) {
      $rotName = 'server-console-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'
      Move-Item $ServerLog (Join-Path $DataDir $rotName) -Force -ErrorAction SilentlyContinue
    }
    $cmdArgs = '/c ""' + $NodeExe + '" account-server.js >> "' + $ServerLog + '" 2>&1"'
    Start-HiddenProcess 'cmd.exe' $cmdArgs $ServerDir
    return 'started'
  } catch {
    return 'error:' + $_.Exception.Message
  }
}

function Stop-Server {
  $killed = 0
  $portPid = Get-PortOwnerPid
  if ($portPid -gt 0) {
    try { Stop-Process -Id $portPid -Force -ErrorAction Stop; $killed++ } catch {}
  }
  foreach ($p in (Get-ServerProcess)) {
    if ($p.ProcessId -ne $portPid) {
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch {}
    }
  }
  return $killed
}

function Show-StartResult([string]$r) {
  if ($r -eq 'started') {
    $lblMsg.Text = '服务启动中，请稍候…'
    $script:pendingSince = Get-Date
    $script:timeoutNotified = $false
  } elseif ($r -eq 'already') {
    $lblMsg.Text = '后台服务已在运行'
  } elseif ($r -eq 'starting') {
    $lblMsg.Text = '服务正在启动中，请稍候…'
    $script:pendingSince = Get-Date
  } elseif ($r.StartsWith('occupied:')) {
    $rest = $r.Substring(9)
    $i = $rest.LastIndexOf(':')
    $occName = $rest.Substring(0, $i)
    $occPid = $rest.Substring($i + 1)
    [System.Windows.Forms.MessageBox]::Show(('端口 {0} 被 {1}（PID {2}）占用，请先关闭该程序再启动。' -f $Port, $occName, $occPid), '端口被占用', 'OK', 'Warning') | Out-Null
    $lblMsg.Text = '端口 ' + $Port + ' 被占用，未能启动'
  } elseif ($r.StartsWith('error:')) {
    $lblMsg.Text = '启动失败：' + $r.Substring(6)
  }
}

# ---------------- 管理 API 封装 ----------------
function Invoke-AdminApi([string]$method, [string]$path, $body) {
  $params = @{
    Method = $method
    Uri = ('http://127.0.0.1:' + $Port + $path)
    UseBasicParsing = $true
    TimeoutSec = 30
    ErrorAction = 'Stop'
  }
  if ($null -ne $body) {
    # PS5.1：字符串 Body 按 ContentType 的 charset 编码，必须显式 utf-8 否则中文昵称会乱码
    $params.ContentType = 'application/json; charset=utf-8'
    $params.Body = ($body | ConvertTo-Json -Compress -Depth 6)
  }
  return Invoke-RestMethod @params
}

# 从异常响应体里提取后端真实错误（4xx/5xx 时 Invoke-RestMethod 抛异常）
function Get-HttpErrorDetail($err) {
  try {
    $resp = $err.Exception.Response
    if ($resp) {
      $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $raw = $sr.ReadToEnd()
      $sr.Close()
      if ($raw) {
        try {
          $j = $raw | ConvertFrom-Json
          if ($j.error) { return $j.error }
          if ($j.message) { return $j.message }
        } catch {}
        if ($raw.Length -gt 120) { $raw = $raw.Substring(0, 120) }
        return $raw
      }
    }
  } catch {}
  return $err.Exception.Message
}

function Require-ServerRunning {
  if (Test-Health) { return $true }
  [System.Windows.Forms.MessageBox]::Show('账号后台服务未运行，请先在主窗口点击「启动后台」。', '服务未运行', 'OK', 'Warning') | Out-Null
  return $false
}

# ---------------- 品牌图标（优先用插件自带 icon.png，失败则自绘） ----------------
function New-FallbackIcon([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $s = $size / 64.0
  $bgPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $cr = 14 * $s
  $bgPath.AddArc(0, 0, (2 * $cr), (2 * $cr), 180, 90)
  $bgPath.AddArc(($size - 2 * $cr), 0, (2 * $cr), (2 * $cr), 270, 90)
  $bgPath.AddArc(($size - 2 * $cr), ($size - 2 * $cr), (2 * $cr), (2 * $cr), 0, 90)
  $bgPath.AddArc(0, ($size - 2 * $cr), (2 * $cr), (2 * $cr), 90, 90)
  $bgPath.CloseFigure()
  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(13, 21, 38))
  $g.FillPath($bgBrush, $bgPath)
  $font = New-Object System.Drawing.Font('Segoe UI', [float](30 * $s), [System.Drawing.FontStyle]::Bold)
  $br = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
  $rect = New-Object System.Drawing.RectangleF(0, (2 * $s), $size, $size)
  $g.DrawString('P', $font, $br, $rect, $sf)
  $dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(37, 99, 235))
  $g.FillEllipse($dotBrush, [float](46 * $s), [float](8 * $s), [float](9 * $s), [float](9 * $s))
  $dotBrush.Dispose(); $br.Dispose(); $font.Dispose(); $sf.Dispose()
  $bgBrush.Dispose(); $bgPath.Dispose(); $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$script:appIcon = $null
try {
  $iconPng = Join-Path $ProjectRoot 'chrome\content\icons\icon.png'
  if (Test-Path $iconPng) {
    $bmp = New-Object System.Drawing.Bitmap($iconPng)
    $script:appIcon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  }
} catch {}
if ($null -eq $script:appIcon) { $script:appIcon = New-FallbackIcon 32 }

# ---------------- 页面/目录打开 ----------------
function Open-Url([string]$url) {
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $url
    $psi.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
  } catch {}
}

# ============================================================
# 通道管理对话框（列表 + 新增/编辑/删除/切换/实测）
# ============================================================
$script:providerRows = @()

function Get-ProviderName([string]$pid_) {
  foreach ($p in $script:providerRows) { if ($p.id -eq $pid_) { return $p.name } }
  return '自定义'
}

function Show-ChannelManager {
  if (-not (Require-ServerRunning)) { return }

  # 预设目录（一次拉取，供表单复用）
  try { $script:providerRows = @(Invoke-AdminApi 'GET' '/api/admin/providers').providers }
  catch { $script:providerRows = @() }

  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = 'AI 模型通道管理（官方网关上游）'
  $dlg.ClientSize = New-Object System.Drawing.Size(568, 470)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = '通道 = 官方网关的上游：登录用户经 /v1 网关调用「活动通道」；auto 模型自动映射为通道默认模型。'
  $hint.ForeColor = [System.Drawing.Color]::DimGray
  $hint.SetBounds(12, 10, 544, 34)
  [void]$dlg.Controls.Add($hint)

  $lb = New-Object System.Windows.Forms.ListBox
  $lb.Font = New-Object System.Drawing.Font('Consolas', 9.5)
  $lb.HorizontalScrollbar = $true
  $lb.SetBounds(12, 46, 544, 250)
  $lb.IntegralHeight = $false
  [void]$dlg.Controls.Add($lb)

  $lblInfo = New-Object System.Windows.Forms.Label
  $lblInfo.Text = ''
  $lblInfo.ForeColor = [System.Drawing.Color]::DimGray
  $lblInfo.SetBounds(12, 300, 544, 20)
  [void]$dlg.Controls.Add($lblInfo)

  $script:cmRows = @()

  function New-DlgBtn($parent, [string]$text, [int]$x, [int]$y, [int]$w, $handler) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text
    $b.Location = New-Object System.Drawing.Point($x, $y)
    $b.Size = New-Object System.Drawing.Size($w, 30)
    $b.add_Click($handler)
    [void]$parent.Controls.Add($b)
    return $b
  }

  function Refresh-CmList {
    try {
      $r = Invoke-AdminApi 'GET' '/api/admin/channels'
      $script:cmRows = @($r.channels)
      $lb.Items.Clear()
      $i = 0
      foreach ($c in $r.channels) {
        $mark = '  '
        if ($c.id -eq $r.active) { $mark = '●' }
        $prov = Get-ProviderName $c.provider
        [void]$lb.Items.Add(('{0} {1,-22} [{2}] {3}  {4}' -f $mark, $c.name, $c.model, $c.apiKeyMasked, $prov))
        $i++
      }
      if ($r.channels.Count -eq 0) {
        $lblInfo.Text = '暂无通道——登录用户调用官方模型会收到 503，请先新增一条'
      } else {
        $act = ''
        foreach ($c in $r.channels) { if ($c.id -eq $r.active) { $act = $c.name + '（' + $c.model + '）' } }
        if ($act) { $lblInfo.Text = '活动通道：' + $act + ' · 共 ' + $r.channels.Count + ' 个' }
        else { $lblInfo.Text = '⚠ 未设置活动通道（官方调用将返回 503）· 共 ' + $r.channels.Count + ' 个' }
      }
    } catch {
      $lblInfo.Text = '加载失败：' + (Get-HttpErrorDetail $_)
    }
  }

  function Get-SelectedChannel {
    if ($lb.SelectedIndex -lt 0 -or $lb.SelectedIndex -ge $script:cmRows.Count) { return $null }
    return $script:cmRows[$lb.SelectedIndex]
  }

  $btnActivate = New-DlgBtn $dlg '设为活动' 12 330 104 {
    $c = Get-SelectedChannel
    if ($null -eq $c) { return }
    try {
      [void](Invoke-AdminApi 'PUT' '/api/admin/channels/active' @{ id = $c.id })
      $lblInfo.Text = '已切换活动通道：' + $c.name
      Refresh-CmList
    } catch { $lblInfo.Text = '切换失败：' + (Get-HttpErrorDetail $_) }
  }
  $btnTest = New-DlgBtn $dlg '实测' 124 330 104 {
    $c = Get-SelectedChannel
    if ($null -eq $c) { return }
    $lblInfo.Text = '正在实测「' + $c.name + '」，请稍候…'
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $r = Invoke-AdminApi 'POST' ('/api/admin/channels/' + $c.id + '/test') @{}
      if ($r.ok) {
        [System.Windows.Forms.MessageBox]::Show(('通道正常' + "`n" + '模型：' + $r.model + "`n" + '延迟：' + $r.latencyMs + 'ms' + "`n" + '应答：' + $r.reply), '实测通过', 'OK', 'Information') | Out-Null
        $lblInfo.Text = '实测通过（' + $r.latencyMs + 'ms）'
      } else {
        [System.Windows.Forms.MessageBox]::Show('调用失败：' + $r.error, '实测失败', 'OK', 'Warning') | Out-Null
        $lblInfo.Text = '实测失败'
      }
    } catch {
      [System.Windows.Forms.MessageBox]::Show('请求失败：' + (Get-HttpErrorDetail $_), '实测失败', 'OK', 'Warning') | Out-Null
      $lblInfo.Text = '实测请求失败'
    }
  }
  $btnEdit = New-DlgBtn $dlg '编辑' 236 330 104 {
    $c = Get-SelectedChannel
    if ($null -eq $c) { return }
    [void](Show-ChannelForm $c)
    Refresh-CmList
  }
  $btnDel = New-DlgBtn $dlg '删除' 348 330 104 {
    $c = Get-SelectedChannel
    if ($null -eq $c) { return }
    $r = [System.Windows.Forms.MessageBox]::Show('确定删除通道「' + $c.name + '」？删除后不可恢复。', '删除通道', 'YesNo', 'Question')
    if ($r -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'DELETE' ('/api/admin/channels/' + $c.id))
      $lblInfo.Text = '已删除：' + $c.name
      Refresh-CmList
    } catch { $lblInfo.Text = '删除失败：' + (Get-HttpErrorDetail $_) }
  }
  $btnClose = New-DlgBtn $dlg '关闭' 460 330 96 { $dlg.Close() }

  $btnAdd = New-DlgBtn $dlg '＋ 新增通道' 12 368 180 {
    [void](Show-ChannelForm $null)
    Refresh-CmList
  }
  $btnOpenPage = New-DlgBtn $dlg '在浏览器中管理' 200 368 180 { Open-Url $AdminPage }
  $btnRefresh = New-DlgBtn $dlg '刷新' 388 368 168 { Refresh-CmList }

  $tip = New-Object System.Windows.Forms.Label
  $tip.Text = "● = 活动通道。新增时可只填 API Key 后点「🔍 检测」自动识别厂商；编辑时 Key 留空 = 保持原密钥。"
  $tip.ForeColor = [System.Drawing.Color]::DimGray
  $tip.SetBounds(12, 408, 544, 40)
  [void]$dlg.Controls.Add($tip)

  Refresh-CmList
  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
  Update-ChannelLine
}

# ---------------- 通道 新增/编辑 表单 ----------------
function Show-ChannelForm($editing) {
  $isEdit = ($null -ne $editing)
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '新增通道'
  if ($isEdit) { $dlg.Text = '编辑通道：' + $editing.name }
  $dlg.ClientSize = New-Object System.Drawing.Size(560, 478)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  function New-FLabel($parent, [string]$text, [int]$x, [int]$y, [int]$w) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size = New-Object System.Drawing.Size($w, 18)
    [void]$parent.Controls.Add($l)
    return $l
  }
  function New-FInput($parent, [int]$x, [int]$y, [int]$w, [bool]$isPassword) {
    $t = New-Object System.Windows.Forms.TextBox
    if ($isPassword) { $t.UseSystemPasswordChar = $true }
    $t.Location = New-Object System.Drawing.Point($x, $y)
    $t.Size = New-Object System.Drawing.Size($w, 24)
    [void]$parent.Controls.Add($t)
    return $t
  }

  [void](New-FLabel $dlg '厂商预设（选择后自动填充地址与模型建议）' 12 12 400)
  $selProvider = New-Object System.Windows.Forms.ComboBox
  $selProvider.DropDownStyle = 'DropDownList'
  $selProvider.Location = New-Object System.Drawing.Point(12, 32)
  $selProvider.Size = New-Object System.Drawing.Size(536, 24)
  foreach ($p in $script:providerRows) { [void]$selProvider.Items.Add($p.name) }
  if ($script:providerRows.Count -eq 0) { [void]$selProvider.Items.Add('自定义 OpenAI 兼容接口') }
  [void]$dlg.Controls.Add($selProvider)

  [void](New-FLabel $dlg '通道 ID（小写字母/数字/连字符）' 12 64 260)
  $txtId = New-FInput $dlg 12 84 260 $false
  [void](New-FLabel $dlg '名称' 292 64 256)
  $txtName = New-FInput $dlg 292 84 256 $false

  [void](New-FLabel $dlg 'Base URL *（OpenAI 兼容 /v1）' 12 116 536)
  $txtBase = New-FInput $dlg 12 136 536 $false

  [void](New-FLabel $dlg 'API Key（编辑时留空 = 保持原密钥）' 12 168 260)
  $txtKey = New-FInput $dlg 12 188 260 $true
  [void](New-FLabel $dlg '默认模型（调用方传 auto 时使用）' 292 168 256)
  $txtModel = New-FInput $dlg 292 188 256 $false

  [void](New-FLabel $dlg '模型列表（逗号分隔，供 /v1/models 展示；可点「📡 拉取」自动填充）' 12 220 536)
  $txtModels = New-FInput $dlg 12 240 536 $false

  [void](New-FLabel $dlg 'extraBody（JSON，并入调用方请求体，可空）' 12 272 536)
  $txtExtra = New-FInput $dlg 12 292 536 $false

  [void](New-FLabel $dlg '探活超时 ms' 12 324 160)
  $numTimeout = New-Object System.Windows.Forms.NumericUpDown
  $numTimeout.Minimum = 2000; $numTimeout.Maximum = 120000; $numTimeout.Increment = 1000
  $numTimeout.Location = New-Object System.Drawing.Point(12, 344)
  $numTimeout.Size = New-Object System.Drawing.Size(120, 24)
  [void]$dlg.Controls.Add($numTimeout)

  $lblFMsg = New-Object System.Windows.Forms.Label
  $lblFMsg.Text = ''
  $lblFMsg.ForeColor = [System.Drawing.Color]::DimGray
  $lblFMsg.SetBounds(12, 442, 536, 30)
  [void]$dlg.Controls.Add($lblFMsg)

  # 预设联动：仅填充空字段（不覆盖已填内容）
  $selProvider.Add_SelectedIndexChanged({
    $p = $null
    foreach ($row in $script:providerRows) { if ($row.name -eq $selProvider.Text) { $p = $row; break } }
    if ($null -eq $p) { return }
    if (-not $txtBase.Text -and $p.baseUrl) { $txtBase.Text = $p.baseUrl }
    if (-not $txtName.Text) { $txtName.Text = $p.name }
    if (-not $txtId.Text -and $p.id -ne 'custom') { $txtId.Text = $p.id + '-main' }
    if (-not $txtModels.Text -and $p.models.Count -gt 0) { $txtModels.Text = ($p.models -join ', ') }
    if (-not $txtModel.Text -and $p.models.Count -gt 0) { $txtModel.Text = $p.models[0] }
    if (-not $txtExtra.Text -and $p.extraBody) { $txtExtra.Text = ($p.extraBody | ConvertTo-Json -Compress) }
  })

  if ($isEdit) {
    foreach ($p in $script:providerRows) { if ($p.id -eq $editing.provider) { $selProvider.Text = $p.name } }
    if (-not $selProvider.Text) { $selProvider.Text = '自定义 OpenAI 兼容接口'; [void]$selProvider.Items.Add('自定义 OpenAI 兼容接口') }
    $txtId.Text = $editing.id; $txtId.Enabled = $false
    $txtName.Text = $editing.name
    $txtBase.Text = $editing.baseUrl
    $txtModel.Text = $editing.model
    $txtModels.Text = ($editing.models -join ', ')
    if ($editing.extraBody) {
      $keys = @($editing.extraBody.PSObject.Properties.Name)
      if ($keys.Count -gt 0) { $txtExtra.Text = ($editing.extraBody | ConvertTo-Json -Compress) }
    }
    $numTimeout.Value = [Math]::Min([Math]::Max([int]$editing.timeoutMs, 2000), 120000)
    $lblFMsg.Text = '提示：API Key 留空则保持原密钥不变'
  } else {
    $numTimeout.Value = 12000
    if ($script:providerRows.Count -gt 0) { $selProvider.SelectedIndex = 0 }
  }

  $btnDetect = New-Object System.Windows.Forms.Button
  $btnDetect.Text = '🔍 检测（按密钥识别厂商）'
  $btnDetect.Location = New-Object System.Drawing.Point(12, 384)
  $btnDetect.Size = New-Object System.Drawing.Size(200, 30)
  $btnDetect.add_Click({
    if (-not $txtKey.Text.Trim()) { $lblFMsg.Text = '请先填写 API Key 再检测'; return }
    $lblFMsg.Text = '正在按密钥格式探测厂商…'
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $r = Invoke-AdminApi 'POST' '/api/admin/channels/detect' @{ apiKey = $txtKey.Text.Trim(); baseUrl = $txtBase.Text.Trim() }
      $p = $null
      foreach ($row in $script:providerRows) { if ($row.id -eq $r.provider) { $p = $row; break } }
      if ($p) { $selProvider.Text = $p.name }
      if ($r.provider -ne 'custom') { $txtId.Text = $r.provider + '-main' }
      $txtBase.Text = $r.baseUrl
      $txtModels.Text = ($r.models -join ', ')
      if (-not $txtModel.Text -and $r.models.Count -gt 0) { $txtModel.Text = $r.models[0] }
      $lblFMsg.Text = '✓ 识别为「' + $r.providerName + '」，拉到 ' + $r.models.Count + ' 个模型（' + $r.latencyMs + 'ms）'
      $lblFMsg.ForeColor = [System.Drawing.Color]::Green
    } catch {
      $d = Get-HttpErrorDetail $_
      try {
        # detect 失败也返回候选信息（400 带正文字段）；尽力预填
        $raw = $_.Exception.Response
        if ($raw) {
          $sr = New-Object System.IO.StreamReader($raw.GetResponseStream())
          $j = $sr.ReadToEnd() | ConvertFrom-Json
          $sr.Close()
          if ($j.provider -and $j.provider -ne 'custom') {
            foreach ($row in $script:providerRows) { if ($row.id -eq $j.provider) { $selProvider.Text = $row.name; $txtId.Text = $j.provider + '-main'; break } }
          }
        }
      } catch {}
      $lblFMsg.Text = '✗ ' + $d
      $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnDetect)

  $btnPull = New-Object System.Windows.Forms.Button
  $btnPull.Text = '📡 拉取上游模型'
  $btnPull.Location = New-Object System.Drawing.Point(222, 384)
  $btnPull.Size = New-Object System.Drawing.Size(160, 30)
  $btnPull.add_Click({
    if (-not $txtBase.Text.Trim()) { $lblFMsg.Text = '请先填写 Base URL'; return }
    $lblFMsg.Text = '正在拉取上游模型…'
    [System.Windows.Forms.Application]::DoEvents()
    try {
      $r = $null
      if ($isEdit) {
        $r = Invoke-AdminApi 'GET' ('/api/admin/channels/' + $editing.id + '/models')
      } else {
        $r = Invoke-AdminApi 'POST' '/api/admin/channels/detect' @{ apiKey = $txtKey.Text.Trim(); baseUrl = $txtBase.Text.Trim() }
      }
      $txtModels.Text = ($r.models -join ', ')
      if (-not $txtModel.Text -and $r.models.Count -gt 0) { $txtModel.Text = $r.models[0] }
      $lblFMsg.Text = '✓ 拉到 ' + $r.models.Count + ' 个模型（' + $r.latencyMs + 'ms）'
      $lblFMsg.ForeColor = [System.Drawing.Color]::Green
    } catch {
      $lblFMsg.Text = '✗ ' + (Get-HttpErrorDetail $_)
      $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnPull)

  $btnSave = New-Object System.Windows.Forms.Button
  $btnSave.Text = '保存'
  $btnSave.Location = New-Object System.Drawing.Point(392, 384)
  $btnSave.Size = New-Object System.Drawing.Size(74, 30)
  $btnSave.add_Click({
    $extra = @{}
    if ($txtExtra.Text.Trim()) {
      try { $extra = $txtExtra.Text.Trim() | ConvertFrom-Json }
      catch { $lblFMsg.Text = '✗ extraBody 不是合法 JSON'; $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick; return }
      if ($null -eq $extra) { $extra = @{} }
      if ($extra -is [System.Array]) { $lblFMsg.Text = '✗ extraBody 必须是 JSON 对象'; $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick; return }
    }
    $prov = ''
    foreach ($row in $script:providerRows) { if ($row.name -eq $selProvider.Text) { $prov = $row.id; break } }
    if (-not $prov) { $prov = 'custom' }
    $models = @()
    foreach ($m in ($txtModels.Text -split '[,，]')) {
      $t = $m.Trim()
      if ($t) { $models += $t }
    }
    $body = @{
      id = $txtId.Text.Trim()
      name = $txtName.Text.Trim()
      provider = $prov
      baseUrl = $txtBase.Text.Trim()
      apiKey = $txtKey.Text
      model = $txtModel.Text.Trim()
      models = $models
      extraBody = $extra
      timeoutMs = [int]$numTimeout.Value
    }
    try {
      if ($isEdit) {
        [void](Invoke-AdminApi 'PUT' ('/api/admin/channels/' + $editing.id) $body)
      } else {
        [void](Invoke-AdminApi 'POST' '/api/admin/channels' $body)
      }
      $dlg.Close()
    } catch {
      $lblFMsg.Text = '✗ ' + (Get-HttpErrorDetail $_)
      $lblFMsg.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnSave)

  $btnCancel = New-Object System.Windows.Forms.Button
  $btnCancel.Text = '取消'
  $btnCancel.Location = New-Object System.Drawing.Point(474, 384)
  $btnCancel.Size = New-Object System.Drawing.Size(74, 30)
  $btnCancel.add_Click({ $dlg.Close() })
  [void]$dlg.Controls.Add($btnCancel)

  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}

# ============================================================
# 账号管理对话框（注册 / 用户列表 / 编辑 / 重置密码 / 删除）
# ============================================================
function Show-RegisterUser {
  if (-not (Require-ServerRunning)) { return }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '注册新账号（登录 Zotero 插件用）'
  $dlg.ClientSize = New-Object System.Drawing.Size(420, 300)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  function New-RLabel([string]$text, [int]$y) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text; $l.Location = New-Object System.Drawing.Point(16, $y); $l.Size = New-Object System.Drawing.Size(120, 20)
    [void]$dlg.Controls.Add($l)
  }
  function New-RInput([int]$y, [int]$w, [bool]$isPassword) {
    $t = New-Object System.Windows.Forms.TextBox
    if ($isPassword) { $t.UseSystemPasswordChar = $true }
    $t.Location = New-Object System.Drawing.Point(140, $y); $t.Size = New-Object System.Drawing.Size($w, 24)
    [void]$dlg.Controls.Add($t)
    return $t
  }

  New-RLabel '邮箱 *' 16;  $txtEmail = New-RInput 14 260 $false
  New-RLabel '密码 *（≥8 位）' 46;  $txtPwd = New-RInput 44 260 $true
  New-RLabel '昵称' 76;  $txtNick = New-RInput 74 260 $false
  New-RLabel '套餐' 106
  $selPlan = New-Object System.Windows.Forms.ComboBox
  $selPlan.DropDownStyle = 'DropDownList'
  $selPlan.Location = New-Object System.Drawing.Point(140, 104)
  $selPlan.Size = New-Object System.Drawing.Size(120, 24)
  foreach ($p in @('Free', 'Pro', 'Team')) { [void]$selPlan.Items.Add($p) }
  $selPlan.SelectedIndex = 0
  [void]$dlg.Controls.Add($selPlan)
  New-RLabel '套餐有效期' 136
  $dtExpires = New-Object System.Windows.Forms.DateTimePicker
  $dtExpires.Format = 'Short'; $dtExpires.ShowCheckBox = $true; $dtExpires.Checked = $false
  $dtExpires.Location = New-Object System.Drawing.Point(140, 134)
  $dtExpires.Size = New-Object System.Drawing.Size(140, 24)
  [void]$dlg.Controls.Add($dtExpires)

  $lblMsg2 = New-Object System.Windows.Forms.Label
  $lblMsg2.Text = ''
  $lblMsg2.ForeColor = [System.Drawing.Color]::DimGray
  $lblMsg2.SetBounds(16, 168, 388, 60)
  [void]$dlg.Controls.Add($lblMsg2)

  $btnOk = New-Object System.Windows.Forms.Button
  $btnOk.Text = '注册'
  $btnOk.Location = New-Object System.Drawing.Point(220, 240)
  $btnOk.Size = New-Object System.Drawing.Size(88, 32)
  $btnOk.add_Click({
    if (-not $txtEmail.Text.Trim() -or $txtPwd.Text.Length -lt 8) {
      $lblMsg2.Text = '请填写邮箱，且密码至少 8 位'
      $lblMsg2.ForeColor = [System.Drawing.Color]::Firebrick
      return
    }
    $exp = $null
    if ($dtExpires.Checked) { $exp = $dtExpires.Value.ToString('yyyy-MM-dd') }
    try {
      [void](Invoke-AdminApi 'POST' '/api/admin/users' @{
        email = $txtEmail.Text.Trim(); password = $txtPwd.Text
        nickname = $txtNick.Text.Trim(); plan = $selPlan.Text; expiresAt = $exp
      })
      [System.Windows.Forms.MessageBox]::Show('已注册 ' + $txtEmail.Text.Trim() + "`n" + '可在 Zotero：设置 → PaperPilot 中登录使用。', '注册成功', 'OK', 'Information') | Out-Null
      $dlg.Close()
    } catch {
      $lblMsg2.Text = '注册失败：' + (Get-HttpErrorDetail $_)
      $lblMsg2.ForeColor = [System.Drawing.Color]::Firebrick
    }
  })
  [void]$dlg.Controls.Add($btnOk)

  $btnNo = New-Object System.Windows.Forms.Button
  $btnNo.Text = '取消'
  $btnNo.Location = New-Object System.Drawing.Point(316, 240)
  $btnNo.Size = New-Object System.Drawing.Size(88, 32)
  $btnNo.add_Click({ $dlg.Close() })
  [void]$dlg.Controls.Add($btnNo)

  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}

function Show-UserList {
  if (-not (Require-ServerRunning)) { return }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '账号列表'
  $dlg.ClientSize = New-Object System.Drawing.Size(720, 420)
  $dlg.StartPosition = 'CenterParent'
  $dlg.FormBorderStyle = 'FixedSingle'
  $dlg.MaximizeBox = $false
  $dlg.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dlg.Icon = $script:appIcon

  $lv = New-Object System.Windows.Forms.ListView
  $lv.View = 'Details'; $lv.FullRowSelect = $true; $lv.HideSelection = $false
  $lv.Location = New-Object System.Drawing.Point(12, 12)
  $lv.Size = New-Object System.Drawing.Size(696, 320)
  [void]$lv.Columns.Add('邮箱', 190)
  [void]$lv.Columns.Add('昵称', 100)
  [void]$lv.Columns.Add('套餐', 60)
  [void]$lv.Columns.Add('今日用量', 90)
  [void]$lv.Columns.Add('套餐有效期', 100)
  [void]$lv.Columns.Add('最近登录', 130)
  [void]$dlg.Controls.Add($lv)

  $script:ulRows = @()
  function Refresh-UserList {
    try {
      $r = Invoke-AdminApi 'GET' '/api/admin/users'
      $script:ulRows = @($r.users)
      $lv.Items.Clear()
      foreach ($u in $r.users) {
        $it = New-Object System.Windows.Forms.ListViewItem([string]$u.email)
        [void]$it.SubItems.Add([string]($u.nickname))
        [void]$it.SubItems.Add([string]($u.plan))
        [void]$it.SubItems.Add(($u.dailyUsed.ToString() + ' / ' + $u.dailyLimit.ToString()))
        [void]$it.SubItems.Add($(if ($u.expiresAt) { ([string]$u.expiresAt).Substring(0, 10) } else { '永久' }))
        $last = '从未'
        if ($u.lastLoginAt) { $last = ([string]$u.lastLoginAt).Replace('T', ' ').Substring(0, 16) }
        [void]$it.SubItems.Add($last)
        [void]$lv.Items.Add($it)
      }
    } catch {
      [System.Windows.Forms.MessageBox]::Show('加载失败：' + (Get-HttpErrorDetail $_), '错误', 'OK', 'Warning') | Out-Null
    }
  }

  function New-UBtn([string]$text, [int]$x, [int]$w, $handler) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, 344); $b.Size = New-Object System.Drawing.Size($w, 30)
    $b.add_Click($handler)
    [void]$dlg.Controls.Add($b)
  }

  New-UBtn '编辑（套餐/有效期）' 12 150 {
    if ($lv.SelectedItems.Count -eq 0) { return }
    $u = $script:ulRows[$lv.SelectedItems[0].Index]
    $ed = New-Object System.Windows.Forms.Form
    $ed.Text = '编辑用户：' + $u.email
    $ed.ClientSize = New-Object System.Drawing.Size(380, 210)
    $ed.StartPosition = 'CenterParent'
    $ed.FormBorderStyle = 'FixedSingle'
    $ed.MaximizeBox = $false
    $ed.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $ed.Icon = $script:appIcon
    $l1 = New-Object System.Windows.Forms.Label; $l1.Text = '昵称'; $l1.SetBounds(16, 16, 80, 20); [void]$ed.Controls.Add($l1)
    $t1 = New-Object System.Windows.Forms.TextBox; $t1.Text = [string]$u.nickname; $t1.SetBounds(100, 14, 250, 24); [void]$ed.Controls.Add($t1)
    $l2 = New-Object System.Windows.Forms.Label; $l2.Text = '套餐'; $l2.SetBounds(16, 48, 80, 20); [void]$ed.Controls.Add($l2)
    $cb = New-Object System.Windows.Forms.ComboBox; $cb.DropDownStyle = 'DropDownList'
    foreach ($p in @('Free', 'Pro', 'Team')) { [void]$cb.Items.Add($p) }
    $cb.SelectedItem = [string]$u.planRaw
    if (-not $cb.SelectedItem) { $cb.SelectedIndex = 0 }
    $cb.SetBounds(100, 46, 120, 24); [void]$ed.Controls.Add($cb)
    $l3 = New-Object System.Windows.Forms.Label; $l3.Text = '套餐有效期'; $l3.SetBounds(16, 80, 90, 20); [void]$ed.Controls.Add($l3)
    $dt = New-Object System.Windows.Forms.DateTimePicker
    $dt.Format = 'Short'; $dt.ShowCheckBox = $true
    if ($u.expiresAt) { $dt.Checked = $true; $dt.Value = [datetime]([string]$u.expiresAt).Substring(0, 10) } else { $dt.Checked = $false }
    $dt.SetBounds(110, 78, 140, 24); [void]$ed.Controls.Add($dt)
    $bOk = New-Object System.Windows.Forms.Button; $bOk.Text = '保存'
    $bOk.SetBounds(180, 140, 84, 30)
    $bOk.add_Click({
      try {
        $exp = $null
        if ($dt.Checked) { $exp = $dt.Value.ToString('yyyy-MM-dd') }
        [void](Invoke-AdminApi 'PUT' ('/api/admin/users/' + $u.id) @{ nickname = $t1.Text.Trim(); plan = $cb.Text; expiresAt = $exp })
        $ed.Close(); Refresh-UserList
      } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '保存失败', 'OK', 'Warning') | Out-Null }
    })
    [void]$ed.Controls.Add($bOk)
    $bNo = New-Object System.Windows.Forms.Button; $bNo.Text = '取消'
    $bNo.SetBounds(272, 140, 84, 30); $bNo.add_Click({ $ed.Close() })
    [void]$ed.Controls.Add($bNo)
    [void]$ed.ShowDialog($dlg)
    $ed.Dispose()
  }
  New-UBtn '重置密码' 172 110 {
    if ($lv.SelectedItems.Count -eq 0) { return }
    $u = $script:ulRows[$lv.SelectedItems[0].Index]
    $pw = [Microsoft.VisualBasic.Interaction]::InputBox('为 ' + $u.email + ' 设置新密码（≥8 位，将吊销其全部登录会话）：', '重置密码', '')
    if (-not $pw) { return }
    try {
      [void](Invoke-AdminApi 'POST' ('/api/admin/users/' + $u.id + '/password') @{ password = $pw })
      [System.Windows.Forms.MessageBox]::Show('密码已重置，该用户既有登录已全部吊销。', '成功', 'OK', 'Information') | Out-Null
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '失败', 'OK', 'Warning') | Out-Null }
  }
  New-UBtn '删除用户' 292 110 {
    if ($lv.SelectedItems.Count -eq 0) { return }
    $u = $script:ulRows[$lv.SelectedItems[0].Index]
    $r = [System.Windows.Forms.MessageBox]::Show('确定删除用户 ' + $u.email + '？其全部登录会话将被吊销。', '删除用户', 'YesNo', 'Question')
    if ($r -ne 'Yes') { return }
    try {
      [void](Invoke-AdminApi 'DELETE' ('/api/admin/users/' + $u.id))
      Refresh-UserList
    } catch { [System.Windows.Forms.MessageBox]::Show((Get-HttpErrorDetail $_), '失败', 'OK', 'Warning') | Out-Null }
  }
  New-UBtn '注册新账号' 412 130 { [void](Show-RegisterUser); Refresh-UserList }
  New-UBtn '刷新' 552 60 { Refresh-UserList }
  New-UBtn '关闭' 620 88 { $dlg.Close() }

  Refresh-UserList
  [void]$dlg.ShowDialog($form)
  $dlg.Dispose()
}

# ---------------- 开机自启（HKCU Run 键） ----------------
$script:RunKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:RunKeyName = 'PaperPilotAccountServer'
function Get-StartupEnabled {
  try {
    $p = Get-ItemProperty -Path $script:RunKeyPath -ErrorAction Stop
    return [bool]($p.$script:RunKeyName)
  } catch { return $false }
}
function Set-Startup([bool]$enable) {
  if ($enable) {
    Set-ItemProperty -Path $script:RunKeyPath -Name $script:RunKeyName -Value (Join-Path $PSScriptRoot 'start-server-hidden.vbs')
  } else {
    Remove-ItemProperty -Path $script:RunKeyPath -Name $script:RunKeyName -ErrorAction SilentlyContinue
  }
}

# ---------------- 主界面 ----------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'PaperPilot 后台 · 控制台'
$form.ClientSize = New-Object System.Drawing.Size(472, 648)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.MinimizeBox = $true
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.Icon = $script:appIcon

$script:tickCount = 0
$script:pendingSince = $null
$script:timeoutNotified = $false

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = 'PaperPilot 账号后台'
$lblTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 14, [System.Drawing.FontStyle]::Bold)
$lblTitle.TextAlign = 'MiddleCenter'
$lblTitle.SetBounds(0, 10, 472, 30)

$lblSub = New-Object System.Windows.Forms.Label
$lblSub.Text = '账号 · 官方模型网关 · AI 模型通道 —— 一站式控制台'
$lblSub.ForeColor = [System.Drawing.Color]::DimGray
$lblSub.TextAlign = 'MiddleCenter'
$lblSub.SetBounds(0, 40, 472, 18)

$lampSvc = New-Object System.Windows.Forms.Label
$lampSvc.Text = '●'
$lampSvc.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12)
$lampSvc.ForeColor = [System.Drawing.Color]::Gray
$lampSvc.TextAlign = 'MiddleCenter'
$lampSvc.SetBounds(16, 60, 22, 24)

$lblSvc = New-Object System.Windows.Forms.Label
$lblSvc.Text = '正在检测后台状态…'
$lblSvc.SetBounds(42, 63, 416, 20)

function New-Group([string]$text, [int]$y, [int]$h) {
  $g = New-Object System.Windows.Forms.GroupBox
  $g.Text = $text
  $g.Location = New-Object System.Drawing.Point(14, $y)
  $g.Size = New-Object System.Drawing.Size(444, $h)
  $form.Controls.Add($g)
  return $g
}
function New-Btn($parent, [string]$text, [int]$x, [int]$y, [int]$w, $handler) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, 30)
  $b.add_Click($handler)
  $parent.Controls.Add($b)
  return $b
}

foreach ($c in @($lblTitle, $lblSub, $lampSvc, $lblSvc)) { [void]$form.Controls.Add($c) }

# 分组 1：账号后台控制
$grpCtl = New-Group '账号后台控制（端口 8000，插件默认对接地址）' 96 92
$btnStart = New-Btn $grpCtl '启动后台' 10 26 98 {
  $r = Start-Server
  Show-StartResult $r
  Update-All
}
$btnStop = New-Btn $grpCtl '停止后台' 116 26 98 {
  $n = Stop-Server
  if ($n -gt 0) { $lblMsg.Text = '已停止账号后台服务' } else { $lblMsg.Text = '后台未在运行' }
  Update-All
}
$btnRestart = New-Btn $grpCtl '重启后台' 222 26 98 {
  [void](Stop-Server)
  Start-Sleep -Seconds 1
  $r = Start-Server
  Show-StartResult $r
  Update-All
}
$btnLog = New-Btn $grpCtl '查看服务日志' 328 26 104 {
  if (Test-Path $ServerLog) { Invoke-Item $ServerLog }
  else { [System.Windows.Forms.MessageBox]::Show('暂无日志文件（服务经本控制台启动后才会产生）', '提示') | Out-Null }
}
$lblCtlTip = New-Object System.Windows.Forms.Label
$lblCtlTip.Text = '服务数据：server\data\（users.json / channels.json / 日志）· 关闭控制台不影响已启动的服务'
$lblCtlTip.ForeColor = [System.Drawing.Color]::DimGray
$lblCtlTip.SetBounds(10, 64, 424, 20)
[void]$grpCtl.Controls.Add($lblCtlTip)

# 分组 2：AI 模型通道
$grpLlm = New-Group 'AI 模型通道（官方网关上游）' 196 110
$lblLlm = New-Object System.Windows.Forms.Label
$lblLlm.Text = '检测中…'
$lblLlm.Location = New-Object System.Drawing.Point(10, 22)
$lblLlm.Size = New-Object System.Drawing.Size(424, 36)
[void]$grpLlm.Controls.Add($lblLlm)
$btnChMgr = New-Btn $grpLlm '通道管理（增/删/切换/实测）' 10 64 208 { Show-ChannelManager }
$btnChPage = New-Btn $grpLlm '打开浏览器管理页' 226 64 208 {
  if (-not (Require-ServerRunning)) { return }
  Open-Url $AdminPage
}

# 分组 3：账号管理
$grpUser = New-Group '账号管理' 314 62
$btnReg = New-Btn $grpUser '注册账号' 10 24 208 { Show-RegisterUser }
$btnUsers = New-Btn $grpUser '用户列表（套餐/密码/删除）' 226 24 208 { Show-UserList }

# 分组 4：维护
$grpOps = New-Group '维护' 384 94
$btnStartup = New-Btn $grpOps '开机自启：…' 10 24 118 {
  $new = -not (Get-StartupEnabled)
  Set-Startup $new
  $btnStartup.Text = '开机自启：' + $(if ($new) { '开' } else { '关' })
  if ($new) { $state = '已开启：重启电脑后账号后台将自动启动' } else { $state = '已关闭' }
  [System.Windows.Forms.MessageBox]::Show($state, '开机自启', 'OK', 'Information') | Out-Null
}
$btnData = New-Btn $grpOps '数据目录' 142 24 98 {
  if (Test-Path $DataDir) { Invoke-Item $DataDir }
  else { $lblMsg.Text = '数据目录尚未创建（启动服务后自动生成）' }
}
$btnProj = New-Btn $grpOps '项目目录' 248 24 98 { Invoke-Item $ProjectRoot }
$btnXpi = New-Btn $grpOps '安装包' 354 24 80 {
  $xpi = Get-ChildItem (Join-Path $ProjectRoot 'dist') -Filter '*.xpi' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($xpi) {
    $r = [System.Windows.Forms.MessageBox]::Show('最新安装包：' + $xpi.Name + "`n`n在 Zotero 中安装：工具 → 附加组件 → 齿轮 → Install Add-on From File…`n是否现在打开所在文件夹？", '插件安装包', 'YesNo', 'Information')
    if ($r -eq 'Yes') { Invoke-Item $xpi.DirectoryName }
  } else { $lblMsg.Text = 'dist 目录下暂无 .xpi 安装包' }
}
$lblOpsTip = New-Object System.Windows.Forms.Label
$lblOpsTip.Text = "登录用户经 /v1 网关调用活动通道；未登录插件仍可用自己的通道。`n关闭窗口=最小化到托盘；「退出程序」才会结束控制台（不影响已启动的服务）"
$lblOpsTip.Location = New-Object System.Drawing.Point(10, 62)
$lblOpsTip.Size = New-Object System.Drawing.Size(424, 28)
$lblOpsTip.ForeColor = [System.Drawing.Color]::DimGray
[void]$grpOps.Controls.Add($lblOpsTip)

# 底部操作
$btnTray = New-Btn $form '最小化到托盘' 14 584 150 { Hide-ToTray }
$btnTray.Height = 32
$btnExit = New-Btn $form '退出程序' 174 584 110 { Exit-App }
$btnExit.Height = 32

$lblMsg = New-Object System.Windows.Forms.Label
$lblMsg.Text = ''
$lblMsg.ForeColor = [System.Drawing.Color]::DimGray
$lblMsg.TextAlign = 'MiddleLeft'
$lblMsg.SetBounds(16, 622, 440, 20)
[void]$form.Controls.Add($lblMsg)

# ---------------- 状态刷新 ----------------
$green  = [System.Drawing.Color]::FromArgb(0x0F, 0x6E, 0x56)
$red    = [System.Drawing.Color]::FromArgb(0xA3, 0x2D, 0x2D)
$yellow = [System.Drawing.Color]::FromArgb(0xB8, 0x86, 0x0B)
$orange = [System.Drawing.Color]::FromArgb(0xC4, 0x5A, 0x1B)

function Format-Uptime([datetime]$started) {
  $span = (Get-Date) - $started
  if ($span.TotalHours -ge 1) { return ('{0}小时{1}分' -f [int]$span.TotalHours, $span.Minutes) }
  if ($span.TotalMinutes -ge 1) { return ('{0}分{1}秒' -f $span.Minutes, $span.Seconds) }
  return ('{0}秒' -f [int]$span.TotalSeconds)
}

function Update-ServiceStatus {
  $st = Get-ServerState
  if ($st.State -eq 'running') {
    $lampSvc.ForeColor = $green
    $up = ''
    $started = Get-ProcessStart $st.PortPid
    if ($started) { $up = '，已运行 ' + (Format-Uptime $started) }
    $lblSvc.Text = '运行中（PID ' + $st.PortPid + $up + '）'
    $btnStart.Enabled = $false
    $btnStop.Enabled = $true
    $btnRestart.Enabled = $true
    $script:timeoutNotified = $false
  } elseif ($st.State -eq 'degraded') {
    $lampSvc.ForeColor = $orange
    $lblSvc.Text = '服务异常：端口在听但健康检查不过（建议重启）'
    $btnStart.Enabled = $false
    $btnStop.Enabled = $true
    $btnRestart.Enabled = $true
  } elseif ($st.State -eq 'starting') {
    $lampSvc.ForeColor = $yellow
    $lblSvc.Text = '服务启动中，等待端口 ' + $Port + ' 就绪…'
    $btnStart.Enabled = $false
    $btnStop.Enabled = $true
    $btnRestart.Enabled = $true
    if ($script:pendingSince -and ((Get-Date) - $script:pendingSince).TotalSeconds -gt 40 -and -not $script:timeoutNotified) {
      $script:timeoutNotified = $true
      $lblMsg.Text = '启动耗时较长，若持续无响应请查 server\data\server-console.log'
    }
  } else {
    $lampSvc.ForeColor = $red
    $lblSvc.Text = '未运行'
    $btnStart.Enabled = $true
    $btnStop.Enabled = $false
    $btnRestart.Enabled = $false
  }
}

function Update-ChannelLine {
  try {
    $r = Invoke-AdminApi 'GET' '/api/admin/channels'
    $n = @($r.channels).Count
    $act = $null
    foreach ($c in @($r.channels)) { if ($c.id -eq $r.active) { $act = $c; break } }
    if ($act) {
      $lblLlm.Text = '活动通道：' + $act.name + '（' + $act.model + '）· 共 ' + $n + ' 个'
      $lblLlm.ForeColor = $green
    } elseif ($n -gt 0) {
      $lblLlm.Text = '⚠ 未设置活动通道（官方调用将返回 503）· 共 ' + $n + ' 个'
      $lblLlm.ForeColor = $orange
    } else {
      $lblLlm.Text = '暂无通道——请在「通道管理」中新增上游（如 DeepSeek / 通义 / 本地网关）'
      $lblLlm.ForeColor = $orange
    }
  } catch {
    $lblLlm.Text = '后台未连接（启动服务后可管理模型通道）'
    $lblLlm.ForeColor = [System.Drawing.Color]::Gray
  }
}

function Update-All {
  $script:tickCount++
  Update-ServiceStatus
  if ($script:tickCount % 5 -eq 1) { Update-ChannelLine }
}

# ---------------- 系统托盘 ----------------
$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $script:appIcon
$tray.Text = 'PaperPilot 后台 · 控制台'
$tray.Visible = $false

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miShow = $menu.Items.Add('显示主窗口')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miStart = $menu.Items.Add('启动后台')
$miStop = $menu.Items.Add('停止后台')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miExit = $menu.Items.Add('退出程序')
$tray.ContextMenuStrip = $menu

$script:trayTipShown = $false
$script:allowExit = $false

function Hide-ToTray {
  $form.WindowState = 'Minimized'
  $form.Hide()
  $tray.Visible = $true
  if (-not $script:trayTipShown) {
    $script:trayTipShown = $true
    $tray.ShowBalloonTip(2000, 'PaperPilot 后台', '控制台已最小化到系统托盘继续运行，点击托盘图标恢复窗口。', 'Info')
  }
}

function Show-MainWindow {
  $form.Show()
  $form.WindowState = 'Normal'
  $form.Activate()
  $form.BringToFront()
  $tray.Visible = $false
}

function Exit-App {
  $script:allowExit = $true
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  $form.Close()
}

$miShow.add_Click({ Show-MainWindow })
$miStart.add_Click({
  $r = Start-Server
  Show-StartResult $r
  Update-All
})
$miStop.add_Click({
  [void](Stop-Server)
  Update-All
})
$miExit.add_Click({ Exit-App })

$tray.add_MouseClick({
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-MainWindow }
})

# 关闭（X）= 最小化到托盘驻留；「退出程序」是唯一真正退出入口
$form.add_FormClosing({
  param($s, $e)
  if (-not $script:allowExit) {
    $e.Cancel = $true
    Hide-ToTray
  }
})

$form.add_Resize({
  if ($form.WindowState -eq 'Minimized') { Hide-ToTray }
})

$form.add_Shown({
  Update-All
  $btnStartup.Text = '开机自启：' + $(if (Get-StartupEnabled) { '开' } else { '关' })
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({
  try { Update-All } catch {}
})
$timer.Start()

[void][System.Windows.Forms.Application]::Run($form)
$timer.Stop()
$form.Dispose()
try { $script:mutex.ReleaseMutex() } catch {}
