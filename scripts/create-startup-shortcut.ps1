$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder "SmartPrintConnector.lnk"
$repoDir = (Resolve-Path "$PSScriptRoot\..").Path
$vbsPath = Join-Path $repoDir "connector\silent-launcher.vbs"

$wshShell = New-Object -ComObject WScript.Shell
$shortcut = $wshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "wscript.exe"
$shortcut.Arguments = "`"$vbsPath`""
$shortcut.WorkingDirectory = $repoDir
$shortcut.Description = "SmartPrint Silent Background Print Connector"
$shortcut.Save()

Write-Host "Created silent startup shortcut at: $shortcutPath"
Write-Host "Target: wscript.exe `"$vbsPath`""
