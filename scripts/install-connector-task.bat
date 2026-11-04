@echo off
title SmartPrint Windows Connector - Keep Running Setup
echo ============================================================
echo   SmartPrint Windows Connector - Keep Running Setup
echo ============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [Error] Node.js is not found in PATH.
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)

rem Starts the connector at sign-in and checks every 2 minutes, so it comes back by itself after the
rem laptop sleeps or the connector is closed. Current user only; no administrator rights needed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-connector-task.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [Warning] Could not create the scheduled task. You can still use start-connector.bat directly.
)
echo.
pause
