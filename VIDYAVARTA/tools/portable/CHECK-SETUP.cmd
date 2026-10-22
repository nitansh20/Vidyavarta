@echo off
setlocal
cd /d "%~dp0"
title VidyaVarta - Setup Check
echo VidyaVarta installation check
echo ============================
where node
echo.
node --version
echo.
node check.cjs
echo.
pause
endlocal
