@echo off
rem Double-click to build the CoiMapper exporter mod and install it into Captain of Industry.
setlocal
cd /d "%~dp0"
set "SRC=mod\CoiMapper.Exporter"
set "OUT=%SRC%\bin\Release"
set "DST=%APPDATA%\Captain of Industry\Mods\CoiMapper"

echo Building CoiMapper.Exporter (Release)...
dotnet build "%SRC%" -c Release -nologo
if errorlevel 1 goto :fail

echo.
echo Installing to "%DST%"...
if not exist "%DST%" mkdir "%DST%"
copy /y "%OUT%\CoiMapper.Exporter.dll" "%DST%\" >nul || goto :copyfail
copy /y "%OUT%\manifest.json" "%DST%\" >nul || goto :copyfail
if exist "%SRC%\thumbnail.png" copy /y "%SRC%\thumbnail.png" "%DST%\" >nul

echo.
echo Done. Installed:
dir /b "%DST%"
echo.
pause
exit /b 0

:copyfail
echo.
echo Copy failed. If the game is running, close it (the DLL may be locked) and try again.
:fail
echo.
echo Build or install FAILED. See the output above.
pause
exit /b 1
