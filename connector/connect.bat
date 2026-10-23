@echo off
title SmartPrint Windows Shop Connector
chcp 65001 >nul
cd /d "%~dp0"
echo ========================================================
echo   SmartPrint Windows Shop Printer Connector
echo ========================================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-wizard.ps1" %*
if %ERRORLEVEL% neq 0 (
  echo.
  echo [Notice] Connector exited with code %ERRORLEVEL%.
  pause
)
