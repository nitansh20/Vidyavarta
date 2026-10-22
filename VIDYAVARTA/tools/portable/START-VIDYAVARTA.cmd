@echo off
setlocal
cd /d "%~dp0"
title VidyaVarta
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found. Install Node.js 24, then reopen this file.
  echo Download: https://nodejs.org/en/download
  echo No npm install is needed for this package.
  echo.
  pause
  exit /b 1
)
echo.
echo Starting VidyaVarta. Your browser will open automatically.
echo Keep this window open while the office is running.
echo.
node launcher.cjs
if errorlevel 1 (
  echo.
  echo Startup did not complete. Please share the error above.
  echo If the files are still inside the ZIP, use Extract All first.
  echo.
  pause
)
endlocal
