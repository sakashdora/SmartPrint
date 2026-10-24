@echo off
title SmartPrint Windows Print Connector
echo ============================================================
echo        SmartPrint Windows Shop Print Connector Launcher      
echo ============================================================
echo.
echo Connecting local Windows printers to your SmartPrint cloud service...
echo.

if not exist "%LOCALAPPDATA%\SmartPrintConnector" (
    mkdir "%LOCALAPPDATA%\SmartPrintConnector"
)

node connector\index.js

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [Notice] Connector exited with code %ERRORLEVEL%.
    echo Please verify SMARTPRINT_URL and SMARTPRINT_DEVICE_TOKEN.
    pause
)
