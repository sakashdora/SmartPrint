# SmartPrint Shop Connector Interactive Setup Wizard
param(
    [string]$Url = $env:SMARTPRINT_URL,
    [string]$Token = $env:SMARTPRINT_DEVICE_TOKEN,
    [string]$Printer = $env:SMARTPRINT_PRINTER
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "      SmartPrint · Automated Shop Printer Connector        " -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

$connectorRoot = Join-Path $env:LOCALAPPDATA 'SmartPrintConnector'
if (-not (Test-Path $connectorRoot)) {
    New-Item -ItemType Directory -Path $connectorRoot -Force | Out-Null
}
$settingsFile = Join-Path $connectorRoot 'settings.json'

$savedSettings = @{}
if (Test-Path $settingsFile) {
    try {
        $savedSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
    } catch {}
}

# 1. Server URL
if (-not $Url) {
    $defaultUrl = if ($savedSettings.Url) { $savedSettings.Url } else { 'http://localhost:3000' }
    $inputUrl = Read-Host "Enter SmartPrint Server URL [Default: $defaultUrl]"
    $Url = if ([string]::IsNullOrWhiteSpace($inputUrl)) { $defaultUrl } else { $inputUrl.Trim() }
}
$Url = $Url.TrimEnd('/')
$env:SMARTPRINT_URL = $Url
Write-Host "✓ Server URL: $Url" -ForegroundColor Green

# 2. Enumerate Printers
Write-Host "`nScanning installed Windows printers (WiFi & Wired)..." -ForegroundColor Yellow
$printerObjects = try {
    @(Get-Printer | Where-Object { $_.Name -notmatch 'Fax|OneNote|Microsoft XPS' })
} catch {
    @(Get-CimInstance Win32_Printer | Where-Object { $_.Name -notmatch 'Fax|OneNote|Microsoft XPS' })
}
if ($printerObjects.Count -eq 0) {
    $printerObjects = try { @(Get-Printer) } catch { @(Get-CimInstance Win32_Printer) }
}

$installedPrinters = @($printerObjects | Select-Object -ExpandProperty Name)

if (-not $Printer) {
    $defaultObj = try {
        $regDef = ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows' -ErrorAction SilentlyContinue).Device -split ',')[0]
        $printerObjects | Where-Object { $_.Name -eq $regDef } | Select-Object -First 1
    } catch { $null }
    if (-not $defaultObj) {
        $defaultObj = $printerObjects | Where-Object { $_.Default -eq $true } | Select-Object -First 1
    }
    if ($savedSettings.Printer -and ($installedPrinters -contains $savedSettings.Printer)) {
        $defaultPrinter = $savedSettings.Printer
    } elseif ($defaultObj) {
        $defaultPrinter = $defaultObj.Name
    } else {
        $defaultPrinter = $installedPrinters[0]
    }

    Write-Host "`nDetected Printers (WiFi & Wired):" -ForegroundColor Cyan
    for ($i = 0; $i -lt $printerObjects.Count; $i++) {
        $p = $printerObjects[$i]
        $port = [string]$p.PortName
        $typeTag = if ($port -match '^USB|^DOT4|^LPT') {
            "[🔌 Wired USB]"
        } elseif ($port -match '^WSD|^TCP|^IP_' -or $port -match '\d+\.\d+\.\d+\.\d+' -or $p.Network) {
            "[📶 WiFi / Wireless Network]"
        } else {
            "[📄 Virtual/Spooler]"
        }
        $recTag = if ($p.Name -eq $defaultPrinter) { " (Recommended Default)" } else { "" }
        Write-Host "  [$($i + 1)] $($p.Name) $typeTag · Port: $port$recTag"
    }

    $selection = Read-Host "`nSelect your printer [1-$($installedPrinters.Count), Enter for default: $defaultPrinter]"
    if ([string]::IsNullOrWhiteSpace($selection)) {
        $Printer = $defaultPrinter
    } elseif ($selection -match '^\d+$' -and [int]$selection -ge 1 -and [int]$selection -le $installedPrinters.Count) {
        $Printer = $installedPrinters[[int]$selection - 1]
    } else {
        $Printer = $selection.Trim()
    }
}
$env:SMARTPRINT_PRINTER = $Printer
Write-Host "✓ Selected Printer: $Printer" -ForegroundColor Green

# 3. Device Pairing Token
if (-not $Token) {
    $defaultToken = if ($savedSettings.Token) { $savedSettings.Token } else { '' }
    if ($defaultToken) {
        $masked = $defaultToken.Substring(0, [Math]::Min(8, $defaultToken.Length)) + '...'
        $inputToken = Read-Host "Device Token [Enter to keep existing: $masked]"
        $Token = if ([string]::IsNullOrWhiteSpace($inputToken)) { $defaultToken } else { $inputToken.Trim() }
    } else {
        Write-Host "`nGet your Device Token from SmartPrint Web Dashboard > Printers." -ForegroundColor Yellow
        $Token = Read-Host "Paste Device Token"
    }
}
$env:SMARTPRINT_DEVICE_TOKEN = $Token.Trim()
Write-Host "✓ Device Token configured." -ForegroundColor Green

# 4. SumatraPDF Engine Auto-Setup
Write-Host "`nChecking PDF printing engine..." -ForegroundColor Yellow
$sumatraExe = Join-Path $connectorRoot 'SumatraPDF.exe'
if (-not (Test-Path $sumatraExe)) {
    # Check standard installations
    $stdPaths = @(
        'C:\Program Files\SumatraPDF\SumatraPDF.exe',
        'C:\Program Files (x86)\SumatraPDF\SumatraPDF.exe'
    )
    foreach ($p in $stdPaths) {
        if (Test-Path $p) {
            $sumatraExe = $p
            break
        }
    }
}

if (-not (Test-Path $sumatraExe)) {
    Write-Host "Downloading portable SumatraPDF reader (silent, ~8 MB)..." -ForegroundColor Cyan
    $zipPath = Join-Path $connectorRoot 'sumatra_tmp.zip'
    try {
        & curl.exe -s -L -o $zipPath 'https://files.sumatrapdfreader.org/software/sumatrapdf/rel/3.5.2/SumatraPDF-3.5.2-64.zip'
        Expand-Archive -LiteralPath $zipPath -DestinationPath $connectorRoot -Force
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        $extractedExe = Get-ChildItem -Path $connectorRoot -Filter 'SumatraPDF*.exe' | Select-Object -First 1
        if ($extractedExe -and $extractedExe.FullName -ne $sumatraExe) {
            Copy-Item -Path $extractedExe.FullName -Destination $sumatraExe -Force
        }
    } catch {
        Write-Warning "Could not download portable SumatraPDF. Will fallback to native Windows spooler printing."
    }
}

if (Test-Path $sumatraExe) {
    $env:SUMATRA_PATH = $sumatraExe
    Write-Host "✓ Print Engine: SumatraPDF ($sumatraExe)" -ForegroundColor Green
} else {
    Write-Host "✓ Print Engine: Native Windows Print Spooler" -ForegroundColor Green
}

# 5. Save settings for future 1-click runs
$configObj = @{
    Url = $Url
    Printer = $Printer
    Token = $Token
    Sumatra = if (Test-Path $sumatraExe) { $sumatraExe } else { '' }
    LastUpdated = (Get-Date).ToString("o")
}
[System.IO.File]::WriteAllText($settingsFile, ($configObj | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
Write-Host "`n✓ Configuration saved to $settingsFile" -ForegroundColor Cyan

# 6. Test Server Connection
Write-Host "`nConnecting to SmartPrint server at $Url..." -ForegroundColor Yellow
try {
    $health = Invoke-RestMethod -Uri "$Url/api/health" -Method Get -TimeoutSec 10
    Write-Host "✓ Server is reachable (mode: $($health.mode))" -ForegroundColor Green
} catch {
    Write-Warning "Server at $Url did not respond. Check if the server is running."
}

# 7. Launch Connector
Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "  Starting SmartPrint Background Connector..." -ForegroundColor White
Write-Host "  Press Ctrl+C to stop at any time." -ForegroundColor DarkGray
Write-Host "============================================================`n" -ForegroundColor Cyan

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$indexJs = Join-Path $scriptRoot 'index.js'
& node $indexJs
