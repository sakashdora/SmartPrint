# Keeps the SmartPrint connector running on this shop PC: starts it at sign-in and checks every
# 2 minutes (also on battery, also after the laptop wakes from sleep). The connector exits at once when
# another copy is already running, so the frequent check is harmless. Current user only, no admin.
$ErrorActionPreference = 'Stop'
$launcher = (Resolve-Path (Join-Path $PSScriptRoot '..\connector\silent-launcher.vbs')).Path
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`"" -WorkingDirectory (Split-Path (Split-Path $launcher))
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$every2Min = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'SmartPrintConnector' -Description 'Keeps the SmartPrint print connector running.' -Action $action -Trigger $atLogon, $every2Min -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName 'SmartPrintConnector'
Write-Host 'SmartPrint connector will start at sign-in and is checked every 2 minutes.'
Write-Host "Log: $env:LOCALAPPDATA\SmartPrintConnector\connector.log"
