@echo off
setlocal enabledelayedexpansion
title SmartPrint Windows Print Connector
echo ============================================================
echo        SmartPrint Windows Shop Print Connector Launcher      
echo ============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [Error] Node.js is not found in PATH.
    echo Please install Node.js from https://nodejs.org and re-run.
    pause
    exit /b 1
)

if not exist "%LOCALAPPDATA%\SmartPrintConnector" (
    mkdir "%LOCALAPPDATA%\SmartPrintConnector"
)

echo Starting SmartPrint Windows Shop Connector...
echo Server: %SMARTPRINT_URL%
echo.

node --env-file-if-exists=.env connector\index.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [Notice] Connector exited with code %ERRORLEVEL%.
    echo Please verify SMARTPRINT_URL and SMARTPRINT_DEVICE_TOKEN in .env or settings.json.
    pause
)
