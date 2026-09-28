@echo off
REM Mizan - build and start the server for this computer and the local network.
REM It builds on every start, so code pulled since the last run is never served from an old build.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run build || (echo. & echo Build failed - see the messages above. & pause & exit /b 1)
call npm start
pause
