@echo off
title SCDP - Servidor
color 0A

echo.
echo  Encerrando processos Node anteriores...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo  Iniciando servidor SCDP...
echo.
echo  Acesse: http://localhost:3001
echo.
echo  NAO feche esta janela!
echo  Para parar: pressione Ctrl+C
echo.

pushd "%~dp0backend"
npx nodemon server.js

echo.
echo  Servidor encerrado.
pause
