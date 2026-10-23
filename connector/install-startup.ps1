$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'SmartPrintConnector\settings.xml'))) { throw 'Run setup.ps1 first.' }
$connectorScript = Join-Path $PSScriptRoot 'start.ps1'
$connectorUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$connectorAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -File "' + $connectorScript + '"')
$connectorTrigger = New-ScheduledTaskTrigger -AtLogOn -User $connectorUser
$connectorPrincipal = New-ScheduledTaskPrincipal -UserId $connectorUser -LogonType Interactive -RunLevel Limited
$connectorSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SmartPrint Connector' -Action $connectorAction -Trigger $connectorTrigger -Principal $connectorPrincipal -Settings $connectorSettings -Description 'Print paid SmartPrint jobs for the paired shop after this Windows user signs in.' -Force | Out-Null
Write-Output 'Connector will start after this Windows user signs in. Keep Docker Desktop running and the PC awake.'
