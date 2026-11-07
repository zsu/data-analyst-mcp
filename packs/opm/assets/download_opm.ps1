<#
.SYNOPSIS
Download the OPM Federal Workforce Data files for this analysis into the folder that holds this script.
(Windows PowerShell counterpart of download_opm.sh.)

.DESCRIPTION
- The request is built into this script (written by the data-analyst skill; do not edit it).
- It lists the files OPM publishes now (data.opm.gov, no account or key), picks the months the request
  asks for, and saves each one as <dataset>_<YYYYMM>_<version>.parquet.
- Employment files are 26-75 MB each; accession and separation files are under 4 MB.
- Needs nothing beyond Windows PowerShell 5.1 or PowerShell 7. Run it again after an interruption:
  files already saved are kept.

.PARAMETER NoPause
Do not wait for Enter before closing the window.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\download_opm.ps1
#>
[CmdletBinding()]
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'        # Invoke-WebRequest is very slow with the progress bar
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$Api = 'https://data.opm.gov/api/v1/files'
if ($env:OPM_API_BASE) { $Api = $env:OPM_API_BASE.TrimEnd('/') }

# The request. Columns, tab-separated: dataset, then either
#   periods  YYYYMM,...  (or "latest")           the listed months
#   range    FROM|first  TO|latest  MONTHS        every month from FROM to TO in MONTHS (1-12)
#   pin      YYYYMM  VERSION                      use this version of one month instead of the current one
$Rules = @'
@RULES@
'@

$Here = $PSScriptRoot
if (-not $Here) { $Here = (Get-Location).Path }

function Finish([int]$Code) {
    if (-not $NoPause -and -not [Console]::IsInputRedirected) {
        Write-Host ''
        [void](Read-Host -Prompt 'Press Enter to close')
    }
    exit $Code
}

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    Finish 1
}

$rows = @(foreach ($line in ($Rules -split "`r?`n")) {
    if (-not $line.Trim()) { continue }
    $c = $line -split "`t"
    [pscustomobject]@{ Ds = $c[0]; Kind = $c[1]; A = $c[2]; B = $c[3]; C = $c[4] }
})
$saved = @(); $failed = 0; $missing = @()
foreach ($ds in @($rows | ForEach-Object { $_.Ds } | Sort-Object -Unique)) {
    Write-Host "Listing the $ds files..."
    try {
        $reply = Invoke-RestMethod -Uri "$Api/$($ds)?current=true" -UseBasicParsing -UserAgent 'data-analyst/1.0'
        if ($reply -is [string]) { $reply = $reply | ConvertFrom-Json }     # served without a JSON content type
        $list = @($reply | ForEach-Object { $_ })
    } catch {
        Fail "Could not list the $ds files at $Api ($($_.Exception.Message)). Check the connection, VPN and proxy, then run again."
    }
    $avail = @{}
    foreach ($f in $list) {
        if ([string]$f.filename -match "^$($ds)_(\d{6})_(\d+)$") { $avail[$Matches[1]] = $Matches[2] }
    }
    if ($avail.Count -eq 0) { Fail "OPM listed no $ds files. Run again later." }
    $periods = @($avail.Keys | Sort-Object)
    $first = $periods[0]; $latest = $periods[-1]
    $want = @()
    foreach ($r in @($rows | Where-Object { $_.Ds -eq $ds })) {
        if ($r.Kind -eq 'periods') {
            foreach ($p in $r.A.Split(',')) {
                if ($p -eq 'latest') { $p = $latest }
                if ($avail.ContainsKey($p)) { $want += $p } else { $missing += "$ds $p" }
            }
        } elseif ($r.Kind -eq 'range') {
            $lo = $r.A; $hi = $r.B
            if ($lo -eq 'first') { $lo = $first }
            if ($hi -eq 'latest') { $hi = $latest }
            $months = @($r.C.Split(',') | ForEach-Object { [int]$_ })
            foreach ($p in $periods) {
                if ($p -ge $lo -and $p -le $hi -and $months -contains [int]$p.Substring(4, 2)) { $want += $p }
            }
        }
    }
    foreach ($p in @($want | Sort-Object -Unique)) {
        $v = $avail[$p]
        $pin = @($rows | Where-Object { $_.Ds -eq $ds -and $_.Kind -eq 'pin' -and $_.A -eq $p })
        if ($pin.Count -gt 0) { $v = $pin[0].B }
        $name = "$($ds)_$($p)_$($v).parquet"
        $dest = Join-Path $Here $name
        if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -gt 0) {
            Write-Host "already saved: $name"; $saved += $dest; continue
        }
        Write-Host "Downloading $name ..."
        try {
            Invoke-WebRequest -Uri "$Api/$ds/$($p.Substring(0, 4))/$($p.Substring(4, 2))/$v/download" -OutFile "$dest.part" `
                -UseBasicParsing -UserAgent 'data-analyst/1.0'
            Move-Item -LiteralPath "$dest.part" -Destination $dest -Force
            $saved += $dest
        } catch {
            if (Test-Path -LiteralPath "$dest.part") { Remove-Item -LiteralPath "$dest.part" -Force }
            Write-Host "FAILED $name ($($_.Exception.Message))" -ForegroundColor Red
            $failed++
        }
    }
}

Write-Host ''
if ($missing.Count -gt 0) { Write-Host "Not published by OPM (skipped): $($missing -join ', ')" }
if ($saved.Count -gt 0) {
    Write-Host 'Done. Upload these files to the chat (zip them first if they are large; do not rename them):' -ForegroundColor Green
    foreach ($f in $saved) { Write-Host "  $f" }
}
if ($failed -gt 0) { Write-Host "$failed file(s) failed: run this script again." -ForegroundColor Red; Finish 1 }
Finish 0
