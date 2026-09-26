@echo off
REM Mizan - build (first run) and start the server for this computer and the local network.
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist apps\web\dist\index.html call npm run build
if not exist apps\server\dist\main.js call npm run build
call npm start
pause
