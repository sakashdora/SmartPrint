<#
  Makes the SmartPrint agent start at Windows sign-in and restart if it stops.

  Run in PowerShell (normal user, no administrator needed) from the repository folder:
      .\scripts\install-agent-task.ps1                      # install and start
      .\scripts\install-agent-task.ps1 -Portal 17640        # also serve the outage printing page on port 17640
      .\scripts\install-agent-task.ps1 -Remove              # stop and remove

  The task runs `node agent\launcher.js` as YOU, so the agent's credential (protected with Windows DPAPI for your user)
  keeps working. It does not touch the older shop connector. Enrol the agent first:
      node agent\index.js enroll --url https://your-server --code THE-CODE
#>
param([int]$Portal = 0, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'SmartPrintAgent'
if ($Remove) {
  Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the $name task."
  return
}
$node = (Get-Command node -ErrorAction Stop).Source
$launcher = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'agent\launcher.js'
if (-not (Test-Path $launcher)) { throw "Cannot find $launcher" }
$arguments = "`"$launcher`""
if ($Portal -gt 0) { $arguments += " --portal $Portal" }
$action = New-ScheduledTaskAction -Execute $node -Argument $arguments -WorkingDirectory (Split-Path (Split-Path $launcher))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "Installed and started the $name task for $env:USERNAME. It starts at every sign-in and restarts if it stops."
