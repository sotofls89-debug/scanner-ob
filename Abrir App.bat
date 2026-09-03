@echo off
title SMC Bot — Binance Order Block Scanner
color 0A
cls
echo.
echo  ============================================================
echo   ⚡  SMC BOT — Binance USDT-M Futuros Scanner
echo  ============================================================
echo.
echo  Iniciando servidor local...
echo.

:: Ir a la carpeta del script
cd /d "%~dp0"

:: Verificar si Node.js está disponible
where node >nul 2>nul
if %errorlevel% == 0 (
    echo  ✅ Node.js detectado. Iniciando servidor y Proxy Binance...
    echo.
    echo  La app abrira en tu navegador en unos segundos.
    echo  Para cerrar el servidor, cierra esta ventana.
    echo.
    start "" "http://localhost:3000"
    node server.js
    goto :end
)

:: Verificar si Python 3 está disponible
where python >nul 2>nul
if %errorlevel% == 0 (
    echo  ✅ Python detectado. Usando http.server...
    echo.
    echo  La app abrirá en tu navegador en unos segundos.
    echo  Para cerrar el servidor, cierra esta ventana.
    echo.
    start "" "http://localhost:8080"
    python -m http.server 8080
    goto :end
)

:: Nada disponible
echo  ❌ No se encontró Node.js ni Python en tu PC.
echo.
echo  Instala Node.js desde:  https://nodejs.org  (recomendado)
echo  O Python desde:          https://python.org
echo.
pause
:end
