$vbsPath = (Resolve-Path "$PSScriptRoot\..\connector\silent-launcher.vbs").Path
Write-Host "Target script: $vbsPath"

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbsPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName 'SmartPrintConnector' -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "SmartPrintConnector scheduled task registered successfully!"
