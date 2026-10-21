@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo  ===  VEGA-Music-AI: сборка и обновление  ===
echo  Треки, настройки и логи сохраняются, пересобирается только программа.
echo.

tasklist /FI "IMAGENAME eq VEGA-Music-AI.exe" 2>nul | find /I "VEGA-Music-AI.exe" >nul
if not errorlevel 1 goto running
goto checks

:running
echo  [!] VEGA-Music-AI сейчас запущен. Закройте его и запустите setup_app.bat снова.
echo.
pause
exit /b 1

:checks
where node >nul 2>nul
if errorlevel 1 goto nonode
for /f "delims=" %%v in ('node -v') do echo  Node.js %%v

echo.
echo  [1/4] Загружаю компоненты. Первый раз около 250 МБ, дальше быстро...
call npm install --no-audit --no-fund
if errorlevel 1 goto installfail

echo.
echo  [2/4] Проверяю ядро: тесты...
call npm test > "%TEMP%\vega-music-ai-tests.log" 2>&1
if errorlevel 1 goto testfail
echo  Тесты пройдены.

echo.
echo  [3/4] Собираю VEGA-Music-AI.exe...
call npm run dist
if errorlevel 1 goto buildfail

set "EXE=%~dp0release\win-unpacked\VEGA-Music-AI.exe"
if not exist "%EXE%" goto noexe

echo.
echo  [4/4] Создаю ярлыки на рабочем столе и в меню Пуск...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w=New-Object -ComObject WScript.Shell; foreach($d in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) { $s=$w.CreateShortcut((Join-Path $d 'VEGA-Music-AI.lnk')); $s.TargetPath=$env:EXE; $s.WorkingDirectory=(Split-Path $env:EXE); $s.IconLocation=$env:EXE+',0'; $s.Description='VEGA-Music-AI - AI song generator'; $s.Save() }"

echo.
echo  Готово! VEGA-Music-AI запускается ярлыком на рабочем столе, из меню Пуск или файлом VEGA-Music-AI.bat.
echo  После правок в коде просто запустите setup_app.bat ещё раз - сборка обновится.
echo  Запускаю...
start "" "%EXE%"
timeout /t 3 >nul
endlocal
exit /b 0

:nonode
echo  [!] Не найден Node.js.
echo      Установите Node.js LTS: https://nodejs.org/  или командой:  winget install OpenJS.NodeJS.LTS
echo      Затем закройте это окно и запустите setup_app.bat ещё раз.
echo.
pause
exit /b 1

:installfail
echo.
echo  [!] Не удалось загрузить компоненты. Проверьте интернет и запустите setup_app.bat снова.
pause
exit /b 1

:testfail
echo.
echo  [!] Тесты не прошли, сборка остановлена. Последние строки журнала:
echo.
powershell -NoProfile -Command "Get-Content -Tail 40 -Encoding UTF8 (Join-Path $env:TEMP 'vega-music-ai-tests.log')"
echo.
echo  Полный журнал: %TEMP%\vega-music-ai-tests.log
pause
exit /b 1

:buildfail
echo.
echo  [!] Ошибка сборки. Текст ошибки выше.
pause
exit /b 1

:noexe
echo.
echo  [!] Не найден "%EXE%".
pause
exit /b 1
