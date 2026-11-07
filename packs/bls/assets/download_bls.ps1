<#
.SYNOPSIS
Download BLS time series with the BLS Public Data API: send the requests built into this script and
save the replies as response_*.json next to it. (Windows PowerShell counterpart of download_bls.sh.)

.DESCRIPTION
- Needs no other file: the requests are inside this script.
- When the requests need a BLS registration key (API v2), uses $env:BLS_API_KEY when it is set and
  otherwise asks for the key (hidden input). The key is only sent to api.bls.gov: it is never shown,
  saved, or put on a command line. With a key set, keyless requests also go through API v2.
- Saves response_01.json, response_02.json, ... next to this script, each with the request it answers
  (without the key), and prints their full paths at the end.
- Needs nothing beyond Windows PowerShell 5.1 (built into Windows 10 and 11) or PowerShell 7.

Get a free key at https://data.bls.gov/registrationEngine/ (BLS emails it within minutes).

.PARAMETER NoPause
Do not wait for Enter before closing the window.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\download_bls.ps1"
#>
[CmdletBinding()]
param(
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'        # Invoke-WebRequest is very slow with the progress bar
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$Here = $PSScriptRoot
if (-not $Here) { $Here = (Get-Location).Path }
$Utf8 = New-Object Text.UTF8Encoding($false)
$Key = $null
$Req = $null

# Keep the window open when the script was started with "Run with PowerShell".
function Finish([int]$Code) {
    $script:Key = $null
    if ($script:Req) { Remove-Item -LiteralPath $script:Req -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not $NoPause -and -not [Console]::IsInputRedirected) {
        Write-Host ''
        [void](Read-Host -Prompt 'Press Enter to close')
    }
    exit $Code
}

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "ERROR: $(Hide-Key $Message)" -ForegroundColor Red
    Finish 1
}

# BLS repeats a rejected key in its error message: never let it reach the screen or a file.
function Hide-Key([string]$Text) {
    if ($script:Key -and $Text) { return $Text.Replace($script:Key, '[REDACTED]') }
    return $Text
}

# ---------------------------------------------------------------------------- the requests
# manifest.json and query_NN.json are built into this script; they go to a temporary folder that is
# removed when the script ends.
$Embedded = [ordered]@{}
# @QUERIES@
$Req = Join-Path ([IO.Path]::GetTempPath()) ('download_bls.' + [IO.Path]::GetRandomFileName())
[void](New-Item -ItemType Directory -Path $Req)
foreach ($name in $Embedded.Keys) { [IO.File]::WriteAllText((Join-Path $Req $name), $Embedded[$name], $Utf8) }
$manifestFile = Join-Path $Req 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestFile)) {
    Fail "This script has no requests built in. Use the download_bls.ps1 from the analyst's download files."
}
$Manifest = [IO.File]::ReadAllText($manifestFile, $Utf8) | ConvertFrom-Json
$Queries = @(Get-ChildItem -LiteralPath $Req -Filter 'query_*.json' | Sort-Object Name)
if ($Queries.Count -eq 0) { Fail "This script has no requests built in. Use the download_bls.ps1 from the analyst's download files." }
$Bodies = @()
foreach ($q in $Queries) { $Bodies += ,([IO.File]::ReadAllText($q.FullName, $Utf8) | ConvertFrom-Json) }

$needKey = ($Manifest.api_version -eq 'v2')
foreach ($b in $Bodies) { if ($b.PSObject.Properties['registrationkey']) { $needKey = $true } }

# ---------------------------------------------------------------------------- API key
$Key = $env:BLS_API_KEY
if ($Key) {
    Write-Host 'Using the BLS key in $env:BLS_API_KEY.'
} elseif ($needKey) {
    Write-Host 'These requests need a free BLS registration key (https://data.bls.gov/registrationEngine/).'
    if ([Console]::IsInputRedirected) {
        $Key = [Console]::In.ReadLine()
    } else {
        $secure = Read-Host -Prompt 'Paste your BLS key (input is hidden), then press Enter' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        Remove-Variable secure
    }
}
if ($null -eq $Key) { $Key = '' }
$Key = $Key -replace '\s', ''
if ($needKey -and -not $Key) { Fail 'No key entered. Get one at https://data.bls.gov/registrationEngine/' }

$Version = 'v1'
if ($Key -and $Manifest.urls.v2) { $Version = 'v2' }
$Url = [string]$Manifest.urls.$Version
Write-Host "Sending $($Queries.Count) request(s) to BLS API $Version ..."

# ---------------------------------------------------------------------------- send each request
$Saved = @()
for ($i = 0; $i -lt $Queries.Count; $i++) {
    $q = $Queries[$i]
    $body = $Bodies[$i]
    $body.PSObject.Properties.Remove('registrationkey')
    if ($Version -eq 'v2' -and $Manifest.v2_options) {
        foreach ($p in $Manifest.v2_options.PSObject.Properties) {
            $body | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force
        }
    }
    $requestJson = $body | ConvertTo-Json -Depth 10 -Compress     # the request without the key
    $body | Add-Member -NotePropertyName 'registrationkey' -NotePropertyValue $Key -Force
    if ($Version -ne 'v2') { $body.PSObject.Properties.Remove('registrationkey') }
    $sendJson = $body | ConvertTo-Json -Depth 10 -Compress        # in memory only
    $body.PSObject.Properties.Remove('registrationkey')

    try {
        $resp = Invoke-WebRequest -Uri $Url -Method Post -Body $Utf8.GetBytes($sendJson) `
            -ContentType 'application/json' -UserAgent 'data-analyst/1.0' -UseBasicParsing -TimeoutSec 120
    } catch {
        Fail "$($q.Name): the request to api.bls.gov failed ($($_.Exception.Message)). Check the internet connection, VPN and proxy, then run this script again."
    }
    $sendJson = $null
    $text = $Utf8.GetString($resp.RawContentStream.ToArray()).Trim()
    try { $reply = $text | ConvertFrom-Json } catch { $reply = $null }
    if ($null -eq $reply -or -not $text.EndsWith('}') -or $reply.PSObject.Properties.Count -eq 0) {
        Fail "$($q.Name): BLS did not answer with JSON. The reply began: $($text.Substring(0, [Math]::Min(200, $text.Length)))"
    }
    # Keep the reply exactly as BLS sent it and add the request it answers, like download_bls.sh.
    $text = $text.Substring(0, $text.LastIndexOf('}')).TrimEnd() + ",`n `"_request`": " + $requestJson + "`n}"
    $dest = Join-Path $Here ($q.Name -replace '^query_', 'response_')
    [IO.File]::WriteAllText($dest, (Hide-Key $text) + "`n", $Utf8)
    $Saved += $dest
    $msg = Hide-Key ((@($reply.message) | Where-Object { $_ }) -join '; ')
    if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
    Write-Host "$(Split-Path -Leaf $dest) $($reply.status) $msg"
    if ($i -lt $Queries.Count - 1) { Start-Sleep -Milliseconds 500 }
}

Write-Host ''
Write-Host 'Done. Upload these files to the chat (do not edit them):' -ForegroundColor Green
foreach ($p in $Saved) { Write-Host "  $p" }
Finish 0
