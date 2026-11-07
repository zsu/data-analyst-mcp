<#
.SYNOPSIS
Download the FRED files for one data-analyst request into the folder that holds this script.

.DESCRIPTION
Files marked key, bearer or group come from the FRED API and need your own free FRED API key
(https://fredaccount.stlouisfed.org/apikeys). The script uses $env:FRED_API_KEY when it is set,
otherwise asks for it with hidden input; press Enter to skip those files. The key is never printed
and never written into the saved files.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME\Downloads\download_fred.ps1"
#>
[CmdletBinding()]
param([switch]$NoPause)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# file <TAB> kind <TAB> pages <TAB> url <TAB> then_file <TAB> then_url   ("-" = empty, pages 0 = unpaged)
# kind: plain (no key), key (key in the query), bearer (FRED API v2, key in a header, paged),
# group (GeoFRED series group; its fields fill the __GROUP_*__ placeholders of then_url)
$manifest = @'
@MANIFEST@
'@
$items = $manifest -split "`n" | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_ } | ForEach-Object {
    $f = $_ -split "`t"
    [pscustomobject]@{ File = $f[0]; Kind = $f[1]; Pages = [int]$f[2]; Url = $f[3]; ThenFile = $f[4]; ThenUrl = $f[5] }
}

$key = $env:FRED_API_KEY
if (-not $key -and ($items | Where-Object { $_.Kind -ne 'plain' })) {
    Write-Host 'Some files need a FRED API key (https://fredaccount.stlouisfed.org/apikeys). Press Enter to skip them.'
    if ([Console]::IsInputRedirected) { $key = [Console]::In.ReadLine() }
    else {
        $secure = Read-Host -Prompt 'FRED API key (hidden)' -AsSecureString
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
}
if ($null -eq $key) { $key = '' }
$key = $key -replace '\s', ''

$utf8 = New-Object System.Text.UTF8Encoding($false)
$saved = New-Object System.Collections.ArrayList

# Download one keyed file, wrap it with the request URL (placeholder, not the key) and save it.
# Returns the reply text, or $null when the request failed.
function Save-Keyed([string]$file, [string]$url, [bool]$bearer) {
    try {
        if ($bearer) {
            $r = Invoke-WebRequest -UseBasicParsing -UserAgent 'data-analyst/1.0' -Uri $url `
                -Headers @{ Authorization = "Bearer $key" }
        } else {
            $r = Invoke-WebRequest -UseBasicParsing -UserAgent 'data-analyst/1.0' -Uri ($url.Replace('__FRED_KEY__', $key))
        }
    } catch {
        $msg = "$($_.Exception.Message) $($_.ErrorDetails.Message)"
        if ($key) { $msg = $msg.Replace($key, '[KEY]') }
        Write-Host "${file}: download failed ($msg)"
        return $null
    }
    $text = $utf8.GetString($r.RawContentStream.ToArray())
    $wrapped = '{"request": "' + $url + '", "response": ' + $text + '}'
    $dest = Join-Path $here $file
    [IO.File]::WriteAllText($dest, $wrapped, $utf8)
    [void]$saved.Add($dest)
    Write-Host "saved $file"
    return $text
}

foreach ($it in $items) {
    if ($it.Kind -eq 'plain') {
        $dest = Join-Path $here $it.File
        try {
            Invoke-WebRequest -UseBasicParsing -UserAgent 'data-analyst/1.0' -Uri $it.Url -OutFile $dest
            [void]$saved.Add($dest)
            Write-Host "saved $($it.File)"
        } catch { Write-Host "$($it.File): download failed ($($_.Exception.Message))" }
        Start-Sleep -Milliseconds 600
        continue
    }
    if (-not $key) { Write-Host "skipped (needs a key): $($it.File)"; continue }
    switch ($it.Kind) {
        'key' { [void](Save-Keyed $it.File $it.Url $false) }
        'bearer' {
            # FRED API v2 release/observations: follow next_cursor up to Pages pages
            $n = 1; $u = $it.Url; $f = $it.File
            while ($true) {
                $body = Save-Keyed $f $u $true
                if ($null -eq $body -or $body -notmatch '"has_more"\s*:\s*true') { break }
                if ($body -notmatch '"next_cursor"\s*:\s*"([^"]*)"' -or $n -ge $it.Pages) { break }
                $n++
                $u = $it.Url + '&next_cursor=' + [Uri]::EscapeDataString($Matches[1])
                $f = $it.File -replace '\.json$', ('__p{0:D2}.json' -f $n)
                Start-Sleep -Milliseconds 600
            }
        }
        'group' {
            # GeoFRED: the series group first, then the cross-section it names
            $body = Save-Keyed $it.File $it.Url $false
            if ($null -ne $body) {
                $g = (ConvertFrom-Json $body).series_group
                $u = $it.ThenUrl
                foreach ($k in 'series_group', 'region_type', 'season', 'units', 'frequency', 'max_date') {
                    $v = "$($g.$k)"
                    if ($k -eq 'frequency') { $v = $v.Substring(0, [Math]::Min(1, $v.Length)).ToLower() }
                    $u = $u.Replace('__GROUP_' + $k.ToUpper() + '__', [Uri]::EscapeDataString($v))
                }
                Start-Sleep -Milliseconds 600
                [void](Save-Keyed $it.ThenFile $u $false)
            }
        }
    }
    Start-Sleep -Milliseconds 600
}
$key = $null
Write-Host ''
Write-Host 'Done. Upload these files to the chat:'
$saved | ForEach-Object { Write-Host "  $_" }
if (-not $NoPause -and -not [Console]::IsInputRedirected) { Read-Host 'Press Enter to close' | Out-Null }
