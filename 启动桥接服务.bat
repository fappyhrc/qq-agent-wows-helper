@echo off
rem wows-helper bridge launcher - double-click this file.
rem ASCII-only on purpose (cmd.exe renders non-ASCII in .bat files unreliably).
rem
rem It runs bridge\start-bridge.ps1 with ExecutionPolicy Bypass:
rem   - installs Hikari-core-v2 + playwright chromium on first run (takes a few minutes)
rem   - asks for the yuyuko API credential (you may skip and fill it in the QQ Agent UI later)
rem   - keeps the bridge running in this window; close the window to stop it

setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bridge\start-bridge.ps1" %*
set EXITCODE=%ERRORLEVEL%
echo.
echo Bridge stopped (exit code %EXITCODE%).
pause
endlocal
