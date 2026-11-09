# Betium node launcher (Node.js version) - Windows (PowerShell)
#
# Asks for the public URL of YOUR node and starts it together with the default
# bootstrap peer. Run it by double-clicking run.bat, or:  powershell -ExecutionPolicy Bypass -File run.ps1
# Override the bootstrap peer:  $env:BETIUM_BOOTSTRAP = 'https://other.node'

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$Bootstrap = if ($env:BETIUM_BOOTSTRAP) { $env:BETIUM_BOOTSTRAP } else { 'https://crypto.bullettsocial.space' }
$UrlFile = '.betium_url'
$Port = if ($env:PORT) { $env:PORT } else { '5000' }

Write-Host "[*] Detected: Windows   (the node listens on port $Port by default)"

# ---- prerequisites -----------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '[-] Node.js is not installed. Install Node.js 22.13 or newer: https://nodejs.org' -ForegroundColor Red
    exit 1
}
$nodeVer = [version]((node -v).Trim().TrimStart('v'))
if ($nodeVer -lt [version]'22.13.0') {
    Write-Host "[-] Node.js v$nodeVer is too old. Betium needs v22.13 or newer." -ForegroundColor Red
    exit 1
}

# ---- ask for this node's public URL ----------------------------------------
$saved = ''
if (Test-Path $UrlFile) { $saved = ((Get-Content $UrlFile -TotalCount 1) | Out-String).Trim() }

Write-Host ''
Write-Host 'Betium node launcher'
Write-Host 'Enter the public URL where other nodes can reach THIS node, for example'
Write-Host '  https://mynode.example.com   or   http://203.0.113.5:5000'
Write-Host ''

$MyUrl = $null
while (-not $MyUrl) {
    if ($saved) {
        $in = Read-Host "Your node URL [$saved]"
        if (-not $in) { $in = $saved }
    } else {
        $in = Read-Host 'Your node URL'
    }
    if ($null -eq $in) { Write-Host '[-] No input, exiting.' -ForegroundColor Red; exit 1 }
    $in = ($in -replace '\s', '').TrimEnd('/')
    if ($in -match '^https?://[^/]+$') { $MyUrl = $in }
    else { Write-Host '[-] Not a valid URL. It must start with http:// or https:// and have no path.' -ForegroundColor Red }
}

$hostName = (($MyUrl -replace '^https?://', '') -replace '^.*@', '' -replace ':\d+$', '').ToLower()
if ($hostName -match '^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)') {
    Write-Host "[!] $hostName is a local/private address. Your node will still download and verify" -ForegroundColor Yellow
    Write-Host '    the whole chain, but other nodes cannot find or reach it.' -ForegroundColor Yellow
}

Set-Content -Path $UrlFile -Value $MyUrl

# ---- optional: Windows Firewall ---------------------------------------------
$ruleName = 'Betium node'
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    $ans = Read-Host "Allow other computers to connect (open Windows Firewall port $Port)? [y/N]"
    if ($ans -match '^[Yy]') {
        $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        if ($isAdmin) {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
            Write-Host "[+] Firewall port $Port opened."
        } else {
            Write-Host '[!] Run this script as Administrator (right-click -> Run as administrator) to open the port.' -ForegroundColor Yellow
        }
    }
}
Write-Host '[*] For a public https:// address on Windows, use a Cloudflare Tunnel, or run the Linux version'
Write-Host '    (run.sh) on a server or in WSL, which can set up nginx/Apache with SSL automatically.'

# A node cannot use itself as its own bootstrap peer.
if ($MyUrl.ToLower() -eq $Bootstrap.TrimEnd('/').ToLower()) {
    $nodeArgs = @($MyUrl)
    Write-Host '[*] This is the bootstrap node itself - starting without a bootstrap peer.'
} else {
    $nodeArgs = @($MyUrl, $Bootstrap)
}

Write-Host "[*] Launching: node node.js $($nodeArgs -join ' ')"
Write-Host '[*] Running in this window (Ctrl-C to stop).'
& node node.js @nodeArgs
