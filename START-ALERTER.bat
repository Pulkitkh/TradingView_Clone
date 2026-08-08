@echo off
REM ===================================================================
REM   NSE + BSE Order Alerter  --  one-click launcher
REM
REM   Double-click this file. It will:
REM     1. check Node.js is installed
REM     2. install dependencies (first run only)
REM     3. install the browser engine used to reach the exchanges
REM     4. post the most recent order to your Telegram group
REM     5. keep running 24/7, restarting itself if it ever stops
REM
REM   Close this window to stop the alerter.
REM ===================================================================

title Order Alerter - NSE + BSE
cd /d "%~dp0"
color 0B

echo.
echo  ============================================
echo    NSE + BSE  ORDER ALERTER
echo  ============================================
echo.

REM ---- 1. Node.js present? -------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  color 0C
  echo  [X] Node.js is not installed.
  echo.
  echo      Download the LTS version from  https://nodejs.org
  echo      Install it, then double-click this file again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo  [OK] Node.js %%v

REM ---- 2. config present? --------------------------------------------------
if not exist "server\.env" (
  color 0C
  echo.
  echo  [X] server\.env is missing - the bot credentials live there.
  echo.
  echo      Create the file  server\.env  containing:
  echo.
  echo         TELEGRAM_BOT_TOKEN=your_bot_token
  echo         TELEGRAM_CHAT_ID=-1001234567890
  echo.
  pause
  exit /b 1
)
echo  [OK] Config found

REM ---- 3. dependencies (first run only) ------------------------------------
if not exist "server\node_modules" (
  echo.
  echo  [..] First run - installing dependencies. This takes a few minutes.
  call npm install --prefix server --no-audit --no-fund
  if errorlevel 1 (
    color 0C
    echo  [X] Dependency install failed. Check your internet connection.
    pause
    exit /b 1
  )
)
echo  [OK] Dependencies ready

REM ---- 4. browser engine (needed to get past exchange bot protection) ------
if not exist "%USERPROFILE%\AppData\Local\ms-playwright" (
  echo.
  echo  [..] Installing browser engine ^(one time, ~150 MB^)...
  call npm --prefix server exec playwright install chromium
)
echo  [OK] Browser engine ready

REM ---- 5. run forever ------------------------------------------------------
echo.
echo  ============================================
echo    STARTING - posting the latest order now
echo    then watching NSE + BSE continuously.
echo.
echo    Leave this window open. Close it to stop.
echo  ============================================
echo.

set ALERT_POST_LAST_ON_START=true

:runloop
node --env-file=server\.env server\alerter.js
echo.
echo  [!] Alerter stopped at %date% %time% - restarting in 15 seconds...
echo      ^(logs are in  logs\alerter.log^)
timeout /t 15 /nobreak >nul
REM Only the first launch announces itself; restarts stay quiet.
set ALERT_POST_LAST_ON_START=false
goto runloop
