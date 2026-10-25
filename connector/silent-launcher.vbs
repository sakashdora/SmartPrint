' SmartPrint Silent Background Connector Launcher
' Runs the Node.js connector completely hidden with no popup terminal window
Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Get the directory of this script (SmartPrint\connector)
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoDir = fso.GetParentFolderName(scriptDir)

' Set working directory to repository root
WshShell.CurrentDirectory = repoDir

' Execute node connector/index.js completely hidden (window style 0, do not wait)
command = "node.exe """ & scriptDir & "\index.js"""
WshShell.Run command, 0, False
