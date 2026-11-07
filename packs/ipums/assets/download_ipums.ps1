<#
.SYNOPSIS
Download an IPUMS extract with the IPUMS API: submit it, wait for it, and download the data file and
the codebook. (Windows PowerShell counterpart of download_ipums.sh.)

.DESCRIPTION
- Asks for your IPUMS API key (hidden input), or uses $env:IPUMS_API_KEY when it is set.
  The key is never shown, saved, or put on a command line.
- Submits the extract defined in this file, waits until IPUMS has built it (minutes for CPS, NHIS or MEPS, up to
  about 30 minutes for multi-year ACS), and downloads the data file (.csv.gz) and the DDI codebook
  (.xml) into the folder that holds this script.
- Run it again after an interruption: it continues with the same extract instead of submitting
  a new one. -Number overrides that number; -New submits a new extract.
- Needs nothing beyond Windows PowerShell 5.1 (built into Windows 10 and 11) or PowerShell 7.

Get a key at https://account.ipums.org/api_keys (the account must be registered for @COLLECTION_UPPER@).

.PARAMETER Number
An extract number that was already submitted. Skips the submission.

.PARAMETER New
Submit a new extract, even when one was already submitted (for example after its files expired).

.PARAMETER NoPause
Do not wait for Enter before closing the window.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File .\download_ipums.ps1
#>
[CmdletBinding()]
param(
    [string]$Number,
    [switch]$New,
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'        # Invoke-WebRequest is very slow with the progress bar
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$Collection = '@COLLECTION@'
$BakedNumber = '@NUMBER@'
$SpecId = '@SPEC_ID@'                           # names the saved-number file, so another extract's file is ignored
$Api = 'https://api.ipums.org'
if ($env:IPUMS_API_BASE) { $Api = $env:IPUMS_API_BASE.TrimEnd('/') }
$PollSeconds = 15
$MaxWait = 14400                                # 4 hours

# The extract definition (the request body for the IPUMS API). Do not edit it by hand.
$SpecJson = @'
@SPEC_JSON@
'@

$Here = $PSScriptRoot
if (-not $Here) { $Here = (Get-Location).Path }
$NumberFile = Join-Path $Here "extract_number_$($Collection)_$($SpecId).txt"
$NewCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -New"

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

# ---------------------------------------------------------------------------- API key
$Key = $env:IPUMS_API_KEY
if ($Key) {
    Write-Host 'Using the IPUMS API key in $env:IPUMS_API_KEY.'
} elseif ([Console]::IsInputRedirected) {
    $Key = [Console]::In.ReadLine()
} else {
    $secure = Read-Host -Prompt 'Paste your IPUMS API key (input is hidden), then press Enter' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $Key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    Remove-Variable secure
}
if ($null -eq $Key) { $Key = '' }
$Key = $Key -replace '\s', ''
if (-not $Key) { Fail 'No key entered. Get one at https://account.ipums.org/api_keys' }

# ---------------------------------------------------------------------------- HTTP helper
# Calls the IPUMS API and returns the parsed JSON reply. Retries network errors, 429 and 5xx;
# stops with a clear message on any other error. $What names the step for error messages.
function Invoke-Ipums([string]$Method, [string]$Uri, [string]$What, [string]$Body) {
    for ($try = 1; ; $try++) {
        $params = @{ Method = $Method; Uri = $Uri; Headers = @{ Authorization = $script:Key } }
        if ($Body) {
            $params.Body = [Text.Encoding]::UTF8.GetBytes($Body)
            $params.ContentType = 'application/json'
        }
        try {
            return (Invoke-RestMethod @params)
        } catch {
            $code = 0
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            $reply = $_.ErrorDetails.Message
            if (($code -eq 0 -or $code -eq 429 -or $code -ge 500) -and $try -lt 5) {
                Start-Sleep -Seconds (10 * $try)
                continue
            }
            if ($code -eq 0) {
                Fail "Could not reach IPUMS ($Api): $($_.Exception.Message) Check the internet connection, VPN and proxy, then run this script again."
            }
            if ($code -eq 401 -or $code -eq 403) {
                Fail "IPUMS rejected the API key (HTTP $code). Check the key, and that your account is registered for $($Collection.ToUpper()) at https://account.ipums.org/api_keys"
            }
            if ($code -eq 404 -and $Method -eq 'GET') {
                Fail "IPUMS has no $Collection extract number $script:Number for this account. Check the number; to submit a new extract instead, run: $NewCommand"
            }
            Write-Host ''
            Write-Host "IPUMS replied (HTTP $code):"
            Write-Host $reply
            Fail "$What failed. Send the reply above to the analyst. Do not change the extract by hand."
        }
    }
}

# Downloads a file under the name IPUMS gave it, into the script's folder. Returns the path.
function Save-IpumsFile([string]$Url) {
    $name = [Uri]::UnescapeDataString(([Uri]$Url).Segments[-1])
    $dest = Join-Path $Here $name
    Write-Host "Downloading $name ..."
    try {
        Invoke-WebRequest -Uri $Url -Headers @{ Authorization = $script:Key } -OutFile $dest -UseBasicParsing
    } catch {
        Fail "The download of $name failed ($($_.Exception.Message)). Run this script again (it reuses extract $script:Number)."
    }
    return $dest
}

# ---------------------------------------------------------------------------- 1. submit (or reuse a number)
if ($New) {
    $Number = ''
} else {
    if (-not $Number -and (Test-Path -LiteralPath $NumberFile)) {
        $Number = ((Get-Content -LiteralPath $NumberFile -Raw) -replace '[^0-9]', '')
        if ($Number) { Write-Host "Continuing with extract $Number (saved in $NumberFile by an earlier run)." }
    }
    if (-not $Number) { $Number = $BakedNumber }
}
if ($Number) {
    if ($Number -notmatch '^[0-9]+$') { Fail "The extract number must be a whole number, not '$Number'." }
    Write-Host "Using $Collection extract $Number (already submitted)."
} else {
    # for the curl steps: always this extract's definition
    $specFile = Join-Path $Here 'extract_spec.json'
    try { [IO.File]::WriteAllText($specFile, $SpecJson + "`n", (New-Object Text.UTF8Encoding($false))) } catch { }
    Write-Host "Submitting the extract to IPUMS ($Collection)..."
    $reply = Invoke-Ipums 'POST' "$Api/extracts?collection=$Collection&version=2" 'Submitting the extract' $SpecJson
    $Number = [string]$reply.number
    if (-not $Number) { Fail 'IPUMS accepted the request but sent no extract number.' }
    try { Set-Content -LiteralPath $NumberFile -Value $Number -Encoding Ascii } catch { }
    Write-Host "Submitted: $Collection extract $Number."
}

# ---------------------------------------------------------------------------- 2. wait until it is built
Write-Host "Waiting for IPUMS to build the extract (checked every $PollSeconds seconds; Ctrl+C is safe, run again to continue)."
$clock = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
    $info = Invoke-Ipums 'GET' "$Api/extracts/$($Number)?collection=$Collection&version=2" 'Checking the extract status'
    $status = [string]$info.status
    $elapsed = [int]$clock.Elapsed.TotalSeconds
    $line = "`r  status: {0,-10} ({1} min {2:00} s)" -f $(if ($status) { $status } else { 'unknown' }), [int][Math]::Floor($elapsed / 60), ($elapsed % 60)
    Write-Host $line -NoNewline
    if ($status -eq 'completed') { Write-Host ''; break }
    if ($status -eq 'failed' -or $status -eq 'canceled') {
        Write-Host ''
        Write-Host 'IPUMS replied:'
        Write-Host ($info | ConvertTo-Json -Depth 20)
        Fail "The extract $status. Send the reply above to the analyst. Do not resubmit or change it by hand."
    }
    if ($elapsed -ge $MaxWait) {
        Fail "Still not ready after $($MaxWait / 3600) hours. Run this script again later: it continues with extract $Number."
    }
    Start-Sleep -Seconds $PollSeconds
}

# ---------------------------------------------------------------------------- 3. download the two files
$links = $info.downloadLinks
$dataUrl = $null; $ddiUrl = $null; $dataSha = $null
if ($links) {
    if ($links.data) { $dataUrl = $links.data.url; $dataSha = $links.data.sha256 }
    if ($links.ddiCodebook) { $ddiUrl = $links.ddiCodebook.url }
}
if (-not $dataUrl -or -not $ddiUrl) {
    Fail "Extract $Number is complete but has no download links: IPUMS deletes extract files after about 72 hours. To submit a new extract, run: $NewCommand"
}

$dataFile = Save-IpumsFile $dataUrl
$ddiFile = Save-IpumsFile $ddiUrl

if ($dataSha) {
    $sum = (Get-FileHash -LiteralPath $dataFile -Algorithm SHA256).Hash
    if ($sum -ne $dataSha) { Fail 'The data file is damaged (checksum mismatch). Delete it and run this script again.' }
    Write-Host 'Checksum OK.'
}

Write-Host ''
Write-Host 'Done. Upload these two files to the chat (do not unzip or edit them):' -ForegroundColor Green
Write-Host "  $dataFile"
Write-Host "  $ddiFile"
Finish 0
