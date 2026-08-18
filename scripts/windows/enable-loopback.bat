@echo off
setlocal
REM ASCII-only: Chinese messages are printed by PowerShell (UTF-8). Do not put CJK in this file.
set "HEIGE_SHOW_PAUSE_HINT=1"
set "HEIGE_PAUSE_HINT_STYLE=loopback"
net session >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
  powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath '%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe' -Verb RunAs -Wait -ArgumentList '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%~dp0enable-loopback.ps1\" -Add'"
  set "HEIGE_EXIT=%ERRORLEVEL%"
  if not "%HEIGE_EXIT%"=="0" (
    if /I not "%HEIGE_NO_PAUSE%"=="1" pause
    exit /b %HEIGE_EXIT%
  )
  if /I not "%HEIGE_NO_PAUSE%"=="1" pause
  exit /b 0
)
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0enable-loopback.ps1" -Add %*
set "HEIGE_EXIT=%ERRORLEVEL%"
if not "%HEIGE_EXIT%"=="0" (
  if /I not "%HEIGE_NO_PAUSE%"=="1" pause
  exit /b %HEIGE_EXIT%
)
if /I not "%HEIGE_NO_PAUSE%"=="1" pause
exit /b 0