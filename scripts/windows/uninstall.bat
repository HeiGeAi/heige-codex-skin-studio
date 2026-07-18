@echo off
setlocal
REM ASCII-only: Chinese messages are printed by PowerShell (UTF-8). Do not put CJK in this file.
set "HEIGE_SHOW_PAUSE_HINT=1"
set "HEIGE_PAUSE_HINT_STYLE=uninstall"
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "HEIGE_EXIT=%ERRORLEVEL%"
if not "%HEIGE_EXIT%"=="0" (
  if /I not "%HEIGE_NO_PAUSE%"=="1" pause
  exit /b %HEIGE_EXIT%
)
if /I not "%HEIGE_NO_PAUSE%"=="1" pause
exit /b 0