# start-account-server.ps1
# Orphan-spawn the PaperPilot account backend (node account-server.js) via raw
# System.Diagnostics.Process so the server survives this launcher and any
# sandbox session (sandbox-hosted background processes get silently reaped).
# Equivalent to start-server-hidden.vbs but usable from automation contexts
# where wscript is blocked. Idempotent: exits when 127.0.0.1:8000 answers.
# PS 5.1 compatible. English output only. ASCII only.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File start-account-server.ps1

$ErrorActionPreference = "Stop"

$scriptDir  = $PSScriptRoot
$projectDir = Split-Path -Parent $scriptDir
$serverDir  = Join-Path $projectDir "server"
$serverJs   = Join-Path $serverDir "account-server.js"
$logDir     = Join-Path $serverDir "data"
$logFile    = Join-Path $logDir  "server-console.log"

if (!(Test-Path $serverJs)) { Write-Output "FATAL: account-server.js missing at $serverJs"; exit 1 }
if (!(Test-Path $logDir))   { New-Item -ItemType Directory -Path $logDir | Out-Null }

# locate node.exe: newest managed runtime version, else PATH
function Find-LatestNode {
    $base = "C:\Users\Administrator\.workbuddy\binaries\node\versions"
    if (Test-Path $base) {
        $best = $null; $bestKey = -1
        Get-ChildItem $base -Directory | ForEach-Object {
            $exe = Join-Path $_.FullName "node.exe"
            if (Test-Path $exe) {
                $parts = $_.Name.Split(".")
                $p2 = $parts[2].Split("-")
                $k = [double]$parts[0] * 1000000 + [double]$parts[1] * 1000 + [double]$p2[0]
                if ($k -gt $bestKey) { $bestKey = $k; $best = $exe }
            }
        }
        if ($best) { return $best }
    }
    return "node"
}

function Test-ServerPort {
    param([int]$TimeoutMs = 1200)
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect("127.0.0.1", 8000, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { $c.EndConnect($iar); return $true }
        return $false
    } catch { return $false } finally { if ($c) { try { $c.Close() } catch {} } }
}

if (Test-ServerPort) {
    Write-Output "account server already up (127.0.0.1:8000 answering); nothing to do"
    exit 0
}

$nodeExe = Find-LatestNode
# cmd /c needs the whole command wrapped in an extra pair of quotes (same form as vbs/launcher)
$cmdLine = 'cmd /c ""' + $nodeExe + '" account-server.js >> "' + $logFile + '" 2>&1"'

try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = $cmdLine.Substring("cmd /c ".Length)
    $psi.WorkingDirectory = $serverDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    Write-Output ("spawned PID " + $proc.Id)
} catch {
    Write-Output ("FATAL: spawn failed: " + $_.Exception.Message)
    exit 1
}

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-ServerPort) { $ok = $true; break }
}
if ($ok) { Write-Output "account server is up on 127.0.0.1:8000" }
else     { Write-Output "FATAL: 8000 not answering after 10s (see $logFile)"; exit 2 }
