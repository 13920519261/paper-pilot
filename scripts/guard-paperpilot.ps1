# guard-paperpilot.ps1
# Watchdog for the PaperPilot account backend + public tunnel on this host.
# Scheduled task "PaperPilotGuard" invokes this every minute (user-level task,
# no elevation needed - the services themselves run in the user session).
#
#   pass 1: account server (127.0.0.1:8000, node account-server.js)
#           -> resurrect via scripts/start-account-server.ps1 (idempotent).
#              Honors server/data/stopped-account.flag (set by launcher
#              "stop" button / manual stop) - a flagged stop stays stopped.
#   pass 2: paperpilot tunnel (metrics 127.0.0.1:20250, pp.xinglintools.top
#           -> 127.0.0.1:8000) -> resurrect via ~/.cloudflared/start-tunnel-orphan.ps1.
#              Honors ~/.cloudflared/stopped-paperpilot.flag if present.
#
# Idempotent: each pass is a silent no-op while its port answers.
# Log: server/data/guard.log (rotated at 2MB).
# PS 5.1 compatible. English output only (runs from a scheduled task).

$ErrorActionPreference = "Continue"

$scriptDir = $PSScriptRoot
$serverDir = Join-Path (Split-Path -Parent $scriptDir) "server"
$dataDir   = Join-Path $serverDir "data"
$logFile   = Join-Path $dataDir "guard.log"
$cfDir     = Join-Path $env:USERPROFILE ".cloudflared"

function Write-Log {
    param([string]$Msg)
    try {
        if (!(Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
        if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 2MB) {
            Remove-Item $logFile -Force -ErrorAction SilentlyContinue
        }
        Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Msg) -Encoding UTF8
    } catch {}
}

function Test-Port {
    param([int]$Port, [int]$TimeoutMs = 2000)
    $c = $null
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
        if ($iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { $c.EndConnect($iar); return $true }
        return $false
    } catch { return $false } finally { if ($c) { try { $c.Close() } catch {} } }
}

# ---------- pass 1: account server (8000) ----------
try {
    if (Test-Port 8000) {
        # healthy - silent no-op
    } elseif (Test-Path (Join-Path $dataDir "stopped-account.flag")) {
        # intentionally stopped - leave it down (launcher Start clears the flag)
    } else {
        Write-Log "account server (8000) down, resurrecting..."
        # locate node.exe (newest managed runtime version)
        $nodeExe = "C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-5\node.exe"
        if (!(Test-Path $nodeExe)) {
            $base = "C:\Users\Administrator\.workbuddy\binaries\node\versions"
            if (Test-Path $base) {
                $best = Get-ChildItem $base -Directory | Sort-Object Name -Descending | Select-Object -First 1
                if ($best) { $nodeExe = Join-Path $best.FullName "node.exe" }
            }
        }
        if (!(Test-Path $nodeExe)) {
            Write-Log "FATAL: node.exe not found"
        } else {
            # raw Process.Start on node.exe - no cmd.exe quoting games, no stdio
            # redirection needed (the server writes its own log file since v1.2)
            $psi = New-Object System.Diagnostics.ProcessStartInfo
            $psi.FileName = $nodeExe
            $psi.Arguments = "account-server.js"
            $psi.WorkingDirectory = $serverDir
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            [void][System.Diagnostics.Process]::Start($psi)
            Start-Sleep -Seconds 12
            if (Test-Port 8000) { Write-Log "account server back up" }
            else { Write-Log "FATAL: account server did not come up (see server-console.log)" }
        }
    }
} catch { Write-Log ("pass1 error: " + $_.Exception.Message) }

# ---------- pass 2: paperpilot tunnel (metrics 20250) ----------
try {
    if (Test-Port 20250) {
        # healthy
    } elseif (Test-Path (Join-Path $cfDir "stopped-paperpilot.flag")) {
        # intentionally stopped
    } else {
        Write-Log "paperpilot tunnel (20250) down, resurrecting..."
        $vbs = Join-Path $cfDir "cloudflared-run-paperpilot-hidden.vbs"
        if (Test-Path $vbs) {
            & wscript.exe $vbs
            Start-Sleep -Seconds 15
            if (Test-Port 20250) { Write-Log "paperpilot tunnel back up" }
            else { Write-Log "FATAL: paperpilot tunnel did not come up (see ~/.cloudflared/logs)" }
        } else {
            Write-Log "FATAL: cloudflared-run-paperpilot-hidden.vbs missing in .cloudflared"
        }
    }
} catch { Write-Log ("pass2 error: " + $_.Exception.Message) }
