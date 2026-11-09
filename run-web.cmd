@echo off
rem Double-click to start the coi-mapper web app (npm run web).
cd /d "%~dp0"
if not exist "web\node_modules" (
  echo Installing web dependencies...
  call npm --prefix web install || goto :fail
)
call npm run web
if errorlevel 1 goto :fail
exit /b 0
:fail
echo.
echo Something went wrong. See the output above.
pause
exit /b 1
