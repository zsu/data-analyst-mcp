<#
.SYNOPSIS
Download the files for this analysis into the folder that holds this script. (Windows PowerShell
counterpart of @STEM@.sh.)

.DESCRIPTION
- The requests are built into this script (written by the data-analyst skill; do not edit them).
- Files that need an API key: the script uses the key's environment variable when it is set, otherwise
  asks for the key with hidden input (press Enter to skip those files). The key is never shown or saved.
- Needs nothing beyond Windows PowerShell 5.1 (built into Windows 10 and 11) or PowerShell 7.
- At the end it prints the files to upload to the chat.

.PARAMETER NoPause
Do not wait for Enter before closing the window.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\@STEM@.ps1
#>
[CmdletBinding()]
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'        # Invoke-WebRequest is very slow with the progress bar
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

# Values the requests need. Columns, tab-separated: variable, kind (secret = an API key, asked with
# hidden input; plain = asked with visible input), where to get it.
$Values = @'
@VALUES@
'@

# The requests. Columns, tab-separated ("-" = empty): file, method, optional (1 = may fail), key
# variable, key placement (query, header, body or none), header or body field name, header prefix,
# other variables (comma-separated), URL, JSON body.
$Items = @'
@ITEMS@
'@

$Here = $PSScriptRoot
if (-not $Here) { $Here = (Get-Location).Path }

# Keep the window open when the script was started with "Run with PowerShell".
function Finish([int]$Code) {
    $script:Vals = $null
    if (-not $NoPause -and -not [Console]::IsInputRedirected) {
        Write-Host ''
        [void](Read-Host -Prompt 'Press Enter to close')
    }
    exit $Code
}

function Lines([string]$Text) { $Text -split "`r?`n" | Where-Object { $_.Trim() } }

# ---------------------------------------------------------------------------- keys and other values
$Vals = @{}
foreach ($line in (Lines $Values)) {
    $var, $kind, $where = $line -split "`t", 3
    $v = [Environment]::GetEnvironmentVariable($var)
    if ($v) {
        Write-Host "Using `$env:$var."
    } elseif ([Console]::IsInputRedirected) {
        $v = [Console]::In.ReadLine()
    } elseif ($kind -eq 'secret') {
        Write-Host "Some files need your $var ($where). Press Enter to skip them."
        $secure = Read-Host -Prompt "$var (input is hidden)" -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $v = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
        Remove-Variable secure
    } else {
        $v = Read-Host -Prompt "$var ($where)"
    }
    if ($null -eq $v) { $v = '' }
    if ($kind -eq 'secret') { $v = $v -replace '\s', '' } else { $v = $v.Trim() }
    $Vals[$var] = $v
}

function Get-Code($Err) {
    if ($Err.Exception.Response) { return [int]$Err.Exception.Response.StatusCode }
    return 0
}

# ---------------------------------------------------------------------------- download
$saved = @(); $failed = 0; $skipped = 0
foreach ($line in (Lines $Items)) {
    $f = @($line -split "`t", 10 | ForEach-Object { if ($_ -eq '-') { '' } else { $_ } })
    $file, $method, $optional, $kvar, $place, $kname, $kprefix, $extras, $url, $body = $f
    $key = ''
    if ($kvar) {
        $key = $Vals[$kvar]
        if (-not $key) { Write-Host "skipped (needs $kvar): $file"; $skipped++; continue }
    }
    $miss = ''
    if ($extras) {
        foreach ($x in $extras.Split(',')) {
            if (-not $Vals[$x]) { $miss = $x; break }
            $url = $url.Replace("{$x}", $Vals[$x])
        }
    }
    if ($miss) { Write-Host "skipped (needs $miss): $file"; $skipped++; continue }
    if ($place -eq 'query') { $url = $url.Replace('{API_KEY}', $key) }

    $params = @{ Uri = $url; Method = $method; UseBasicParsing = $true; UserAgent = 'data-analyst/1.0'
                 OutFile = (Join-Path $Here "$file.part") }
    if ($place -eq 'header') {
        $params.Headers = @{ $kname = "$kprefix$key" }
        $params.MaximumRedirection = 0          # a redirect would carry the key header to another host
    }
    if ($body) {
        if ($place -eq 'body') { $body = $body.Replace('{API_KEY}', ($key -replace '\\', '\\' -replace '"', '\"')) }
        $params.Body = [Text.Encoding]::UTF8.GetBytes($body)
        $params.ContentType = 'application/json'
    }
    $code = 0; $msg = ''; $ok = $false
    for ($try = 1; $try -le 4; $try++) {
        try {
            Invoke-WebRequest @params
            $ok = $true
            break
        } catch {
            $code = Get-Code $_
            $msg = [string]$_.ErrorDetails.Message
            if (-not $msg) { $msg = $_.Exception.Message }
            if ($try -lt 4 -and ($code -eq 0 -or $code -eq 429 -or $code -ge 500)) { Start-Sleep -Seconds (10 * $try); continue }
            break
        }
    }
    $part = Join-Path $Here "$file.part"
    $dest = Join-Path $Here $file
    if ($ok) {
        Move-Item -LiteralPath $part -Destination $dest -Force
        $saved += $dest
        Write-Host "saved $file"
    } else {
        if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
        if ($key) { $msg = $msg.Replace($key, '[KEY]') }
        if ($msg.Length -gt 300) { $msg = $msg.Substring(0, 300) }
        if ($optional -eq '1') {
            Write-Host "not available (optional, HTTP $code): $file"
        } elseif ($code -eq 0) {
            Write-Host "FAILED $($file): could not reach the server ($msg) Check the connection, VPN and proxy." -ForegroundColor Red
            $failed++
        } else {
            Write-Host "FAILED $($file): HTTP $code $msg" -ForegroundColor Red
            $failed++
        }
    }
}

Write-Host ''
if ($saved.Count -gt 0) {
    Write-Host 'Done. Upload these files to the chat (do not rename or edit them):' -ForegroundColor Green
    foreach ($p in $saved) { Write-Host "  $p" }
}
if ($skipped -gt 0) { Write-Host "$skipped file(s) skipped: run again and enter the value asked for." }
if ($failed -gt 0) {
    Write-Host "$failed file(s) failed: send the messages above to the analyst." -ForegroundColor Red
    Finish 1
}
Finish 0
