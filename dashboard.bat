@echo off
cd /d "%~dp0"
echo Starting dashboard...
echo.
node --import tsx/esm --env-file=.env src/cli.ts dashboard
echo.
echo Dashboard stopped.
pause
