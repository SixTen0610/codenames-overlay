@echo off
title Codenames Bot
echo.
echo  ================================================
echo   CODENAMES BOT — Starting up...
echo  ================================================
echo.

cd /d "%~dp0"

:: Check Node is installed
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

:: Install dependencies if needed
if not exist "node_modules\puppeteer" (
    echo  Installing dependencies...
    set PUPPETEER_SKIP_DOWNLOAD=true
    npm install
    echo.
)

:: Open control panel in default browser after 2 seconds
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:7842"

:: Start the bot
echo  Control panel will open at http://localhost:7842
echo  Press Ctrl+C to stop the bot
echo.
node bot.js

pause
