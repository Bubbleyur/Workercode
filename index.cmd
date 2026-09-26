@echo off
:: Big Pickle launcher — Windows double-click entrypoint
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install it from https://nodejs.org and re-run.
  pause
  exit /b 1
)
node index.js %*