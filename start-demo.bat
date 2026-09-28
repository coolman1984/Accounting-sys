@echo off
REM Mizan demo - the Samsung Electronics Egypt factory sample company, on port 4810.
REM Its data lives in data-demo\ ; your own company in data\ is never touched.
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist data-demo\mizan.db call npm run demo || (echo. & echo Building the demo failed - see the messages above. & pause & exit /b 1)
call npm run build || (echo. & echo Build failed - see the messages above. & pause & exit /b 1)
set MIZAN_DATA_DIR=%~dp0data-demo
set MIZAN_PORT=4810
call npm start
pause
