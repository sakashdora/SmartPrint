$ErrorActionPreference = 'Stop'
$connectorMutex = [System.Threading.Mutex]::new($false, 'Local\SmartPrintConnector')
if (-not $connectorMutex.WaitOne(0)) { $connectorMutex.Dispose(); throw 'SmartPrint Connector is already running for this Windows user.' }
try {
$connectorConfig = Import-Clixml -LiteralPath (Join-Path $env:LOCALAPPDATA 'SmartPrintConnector\settings.xml')
$env:SMARTPRINT_URL = $connectorConfig.Url
$env:SMARTPRINT_PRINTER = $connectorConfig.Printer
$env:SUMATRA_PATH = $connectorConfig.Sumatra
$env:SMARTPRINT_DEVICE_TOKEN = [System.Net.NetworkCredential]::new('', $connectorConfig.DeviceToken).Password
$env:PROCESSOR_SECRET = [System.Net.NetworkCredential]::new('', $connectorConfig.ProcessorSecret).Password
& node (Join-Path $PSScriptRoot 'index.js')
if ($LASTEXITCODE -ne 0) { throw 'Connector exited. Check the configuration and restart.' }
} finally {
  Remove-Item Env:SMARTPRINT_DEVICE_TOKEN, Env:PROCESSOR_SECRET -ErrorAction SilentlyContinue
  $connectorMutex.ReleaseMutex()
  $connectorMutex.Dispose()
}
