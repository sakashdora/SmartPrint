@echo off
setlocal enabledelayedexpansion
title SmartPrint Windows Connector - Auto-Start Setup
echo ============================================================
echo   SmartPrint Background Service Windows Auto-Start Setup
echo ============================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "REPO_DIR=%SCRIPT_DIR%..\"
for %%i in ("%REPO_DIR%") do set "REPO_DIR=%%~fi"
set "VBS_PATH=%REPO_DIR%\connector\silent-launcher.vbs"

if not exist "%VBS_PATH%" (
    echo [Error] Cannot find silent-launcher.vbs at "%VBS_PATH%".
    pause
    exit /b 1
)

echo Configuring Windows Task Scheduler to start SmartPrint Connector
echo silently in the background on user logon...
echo.

schtasks /create /tn "SmartPrintShopConnector" /tr "wscript.exe \"%VBS_PATH%\"" /sc onlogon /f /rl HIGHEST >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [Success] Scheduled task "SmartPrintShopConnector" registered successfully!
    echo The SmartPrint connector will now start automatically whenever Windows logs in.
    echo It runs invisibly in the background with no terminal window.
    echo.
    echo To verify or test start now:
    echo   schtasks /run /tn "SmartPrintShopConnector"
    echo.
    echo To remove in future:
    echo   schtasks /delete /tn "SmartPrintShopConnector" /f
) else (
    echo [Notice] Elevated task creation requires administrator privileges.
    echo Falling back to Windows Startup Folder...
    set "STARTUP_VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SmartPrintConnector.vbs"
    copy /y "%VBS_PATH%" "!STARTUP_VBS!" >nul
    if %ERRORLEVEL% EQU 0 (
        echo [Success] Installed background launcher into Windows Startup folder:
        echo   "!STARTUP_VBS!"
        echo It will automatically start silently on logon.
    ) else (
        echo [Error] Could not write to Startup folder.
    )
)

echo.
pause
