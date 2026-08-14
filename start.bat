@echo off
REM PulseChat - one-click start for Windows
REM 1) Install Node.js from https://nodejs.org (LTS) if you don't have it
REM 2) Double-click this file
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies (one time)...
  call npm install --omit=dev
)
echo.
echo   PulseChat starting - open http://localhost:3000 in your browser
echo   Phone on the same Wi-Fi? Open http://%COMPUTERNAME%:3000 or your PC's IP
echo   Press Ctrl+C to stop
echo.
node server/index.js
pause
