<#
.SYNOPSIS
Download the BEA data for one analysis: BEA's public files and the BEA Data API replies.
(Windows PowerShell counterpart of download_bea.sh.)

.DESCRIPTION
- Downloads every file listed in this script into the folder that holds it.
- When some files come from the API, it asks for your BEA API key (hidden input), or uses
  $env:BEA_API_KEY when it is set. The key is never shown, saved, or put on a command line, and it is
  removed from each API reply before the reply is saved (BEA repeats the key in every reply).
- Run it again after an interruption: files already downloaded are skipped.
- Needs nothing beyond Windows PowerShell 5.1 (built into Windows 10 and 11) or PowerShell 7.

Get a free key at https://apps.bea.gov/API/signup/ (BEA emails it; click the activation link first).

.PARAMETER NoPause
Do not wait for Enter before closing the window.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\download_bea.ps1
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

$PauseSeconds = 1                               # between API calls: BEA allows 100 a minute per key

# The files to download, one per line: "bulk NAME URL" (public, no key) or "api NAME URL" (the key is
# added when the script runs). Do not edit them by hand.
$FileList = @'
@FILES@
'@

$Here = $PSScriptRoot
if (-not $Here) { $Here = (Get-Location).Path }

# Keep the window open when the script was started with "Run with PowerShell".
function Finish([int]$Code) {
    $script:Key = $null
    if (-not $NoPause -and -not [Console]::IsInputRedirected) {
        Write-Host ''
        [void](Read-Host -Prompt 'Press Enter to close')
    }
    exit $Code
}

function Fail([string]$Message) {
    Write-Host ''
    Write-Host "ERROR: $Message" -ForegroundColor Red
    Finish 1
}

$Files = @()
foreach ($line in ($FileList -split "`r?`n")) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Count -eq 3) { $Files += [pscustomobject]@{ Kind = $parts[0]; Name = $parts[1]; Url = $parts[2] } }
}
if ($Files.Count -eq 0) { Fail 'The file list is missing from this script.' }

# ---------------------------------------------------------------------------- API key (only when needed)
$Key = ''
if (@($Files | Where-Object { $_.Kind -eq 'api' }).Count -gt 0) {
    $Key = $env:BEA_API_KEY
    if ($Key) {
        Write-Host 'Using the BEA API key in $env:BEA_API_KEY.'
    } elseif ([Console]::IsInputRedirected) {
        $Key = [Console]::In.ReadLine()
    } else {
        $secure = Read-Host -Prompt 'Paste your BEA API key (input is hidden), then press Enter' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        Remove-Variable secure
    }
    if ($null -eq $Key) { $Key = '' }
    $Key = $Key -replace '\s', ''
    if (-not $Key) { Fail 'No key entered. Get one at https://apps.bea.gov/API/signup/' }
}

# The reply with the key removed: the key itself, any 36-character key, and the echoed USERID.
function Remove-Key([string]$Text) {
    if ($script:Key) { $Text = $Text.Replace($script:Key, '[REDACTED]') }
    $Text = $Text -replace '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}', '[REDACTED]'
    return ($Text -replace '(?i)("ParameterName"\s*:\s*"USERID"\s*,\s*"ParameterValue"\s*:\s*")[^"]*', '$1[REDACTED]')
}

function Get-ApiError([string]$Text) {
    $m = [regex]::Match($Text, '"APIErrorCode"\s*:\s*"?([0-9]+)')
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

# ---------------------------------------------------------------------------- downloads
$utf8 = New-Object Text.UTF8Encoding($false)
$saved = @(); $warn = @()
$total = $Files.Count
for ($i = 0; $i -lt $total; $i++) {
    $f = $Files[$i]
    $dest = Join-Path $Here $f.Name
    $n = $i + 1
    if ((Test-Path -LiteralPath $dest) -and (Get-Item -LiteralPath $dest).Length -gt 0 -and
        -not (Select-String -LiteralPath $dest -Pattern '"APIErrorCode"' -SimpleMatch -Quiet)) {
        Write-Host "[$n/$total] $($f.Name): already downloaded, skipped."
        $saved += $dest; continue
    }

    if ($f.Kind -eq 'bulk') {
        Write-Host "[$n/$total] Downloading $($f.Name) (public file, no key) ..."
        $part = "$dest.part"
        for ($try = 1; ; $try++) {
            try {
                Invoke-WebRequest -Uri $f.Url -OutFile $part -UseBasicParsing
                break
            } catch {
                if ($try -ge 3) {
                    Remove-Item -LiteralPath $part -ErrorAction SilentlyContinue
                    Fail "The download of $($f.Name) failed ($($_.Exception.Message)). Check the connection and run this script again (finished files are kept)."
                }
                Start-Sleep -Seconds (10 * $try)
            }
        }
        Move-Item -LiteralPath $part -Destination $dest -Force
        $saved += $dest; continue
    }

    Write-Host "[$n/$total] Requesting $($f.Name) from the BEA API ..."
    $uri = "$($f.Url)&UserID=$([Uri]::EscapeDataString($Key))"
    $text = $null; $code = 0
    for ($try = 1; ; $try++) {
        try {
            $resp = Invoke-WebRequest -Uri $uri -UseBasicParsing
            $code = [int]$resp.StatusCode
            $text = $utf8.GetString($resp.RawContentStream.ToArray())
            break
        } catch {
            $code = 0
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            if ($code -eq 429) {
                Fail 'BEA has blocked the key for about an hour (HTTP 429: too many requests). Wait an hour, then run this script again; it continues where it stopped. Retrying sooner makes the block longer.'
            }
            if (($code -eq 0 -or $code -ge 500) -and $try -lt 4) {
                Start-Sleep -Seconds (10 * $try)
                continue
            }
            if ($code -eq 0) {
                Fail "Could not reach BEA (apps.bea.gov): $(Remove-Key $_.Exception.Message) Check the internet connection, VPN and proxy, then run this script again (finished files are kept)."
            }
            $text = [string]$_.ErrorDetails.Message
            break
        }
    }
    $err = Get-ApiError $text
    if ($err -eq '1' -or $err -eq '3' -or $err -eq '4') {
        Fail "BEA rejected the API key (error $err). Check that it is typed correctly and that you clicked the activation link in BEA's email: https://apps.bea.gov/API/signup/"
    }
    if (($code -lt 200 -or $code -ge 300) -and -not $err) {
        Fail "BEA replied with HTTP $code for $($f.Name). Run this script again later; if it happens again, tell the analyst."
    }
    [IO.File]::WriteAllText("$dest.part", (Remove-Key $text), $utf8)
    Move-Item -LiteralPath "$dest.part" -Destination $dest -Force
    if ($err) { $warn += "$($f.Name) (BEA error $err)" }
    $saved += $dest
    Start-Sleep -Seconds $PauseSeconds
}
$Key = $null

Write-Host ''
if ($warn.Count -gt 0) {
    Write-Host 'BEA answered some requests with an error. Upload those files anyway; the analyst will fix the request:' -ForegroundColor Yellow
    foreach ($w in $warn) { Write-Host "  $w" }
    Write-Host ''
}
Write-Host 'Done. Upload these files to the chat (do not unzip or edit them):' -ForegroundColor Green
foreach ($s in $saved) { Write-Host "  $s" }
Finish 0
