$ErrorActionPreference = 'Stop'
$connectorRoot = Join-Path $env:LOCALAPPDATA 'SmartPrintConnector'
New-Item -ItemType Directory -Path $connectorRoot -Force | Out-Null
$appUrl = Read-Host 'SmartPrint HTTPS URL'
$printerName = Read-Host 'Exact Windows printer name'
$sumatraPath = Read-Host 'Full path to SumatraPDF.exe'
if (-not (Test-Path -LiteralPath $sumatraPath -PathType Leaf)) { throw 'SumatraPDF was not found.' }
if (-not (Get-Printer -Name $printerName -ErrorAction SilentlyContinue)) { throw 'Windows printer was not found.' }
$deviceToken = Read-Host 'Device token from SmartPrint > Printers' -AsSecureString
$processorSecret = Read-Host 'PROCESSOR_SECRET used for the local Docker processor' -AsSecureString
[pscustomobject]@{ Url=$appUrl; Printer=$printerName; Sumatra=$sumatraPath; DeviceToken=$deviceToken; ProcessorSecret=$processorSecret } | Export-Clixml -LiteralPath (Join-Path $connectorRoot 'settings.xml')
Write-Output 'Settings saved using Windows user-bound credential encryption. Run start.ps1 as this same user.'
