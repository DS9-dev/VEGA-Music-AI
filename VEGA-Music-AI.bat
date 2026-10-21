@echo off
rem Запуск VEGA-Music-AI двойным щелчком. Если программа ещё не собрана - запускается сборка.
cd /d "%~dp0"
if exist "release\win-unpacked\VEGA-Music-AI.exe" goto run
call setup_app.bat
exit /b

:run
start "" "release\win-unpacked\VEGA-Music-AI.exe"
