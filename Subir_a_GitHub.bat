@echo off
title Subiendo Scanner a GitHub Pages...
color 0A
cd /d "%~dp0"
echo ====================================================
echo   SUBIENDO SCANNER OB A GITHUB PAGES (100%% GRATIS)
echo ====================================================
echo.
git add .
git commit -m "Update Binance OB Scanner"
git push -u origin main
echo.
echo ====================================================
echo   SUBIDA COMPLETADA CON EXITO
echo ====================================================
pause
