@echo off
title SmartPrint Windows Connector - Persistent Background Service Setup
echo ============================================================
echo   SmartPrint Windows Connector - Background Service Setup   
echo ============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [Error] Node.js is not found in PATH.
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

set SCRIPT_DIR=%~dp0..
set NODE_EXE=node.exe
for /f "tokens=*" %%i in ('where node') do (
    set NODE_EXE=%%i
    goto :found_node
)
:found_node

echo Registering SmartPrintConnector Scheduled Task for current user...
schtasks /create /tn "SmartPrintConnector" /tr "\"%NODE_EXE%\" --env-file-if-exists=\"%SCRIPT_DIR%\.env\" \"%SCRIPT_DIR%\connector\index.js\"" /sc onlogon /rl limited /f

if %ERRORLEVEL% EQU 0 (
    echo.
    echo [Success] SmartPrintConnector is registered to start automatically on Windows logon.
    echo Starting the task now...
    schtasks /run /tn "SmartPrintConnector"
    echo.
    echo The SmartPrint connector is now running in the background.
    echo You can check logs anytime at: %%LOCALAPPDATA%%\SmartPrintConnector\connector.log
) else (
    echo.
    echo [Warning] Could not create scheduled task. You can still use start-connector.bat directly.
)

pause
