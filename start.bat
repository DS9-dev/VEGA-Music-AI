@echo off
chcp 65001 >nul
rem Режим разработки: запуск из исходников без сборки exe.
title VEGA-Music-AI (dev)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist "node_modules\electron" goto run
echo.
echo  Первый запуск: загружаю компоненты, 1-3 минуты...
echo.
call npm install --no-audit --no-fund
if errorlevel 1 goto installfail

:run
call npm start
if errorlevel 1 pause
exit /b 0

:nonode
echo.
echo  [!] Не найден Node.js. Установите Node.js LTS: https://nodejs.org/
echo.
pause
exit /b 1

:installfail
echo.
echo  [!] Не удалось загрузить компоненты. Проверьте интернет и запустите снова.
pause
exit /b 1
