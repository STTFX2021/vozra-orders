@echo off
REM ============================================================
REM  VERIFICAR.bat  —  comprobacion completa de Vozra PID
REM
REM  Se puede ejecutar con DOBLE CLIC. Se situa solo en su propia
REM  carpeta, asi que da igual desde donde se lance y da igual si
REM  la consola es cmd o PowerShell.
REM
REM  Motivo: "cd /d" no existe en PowerShell. Cuando el cd fallaba,
REM  todo se ejecutaba en C:\WINDOWS\system32 y salian errores de
REM  "not a git repository" o "Cannot find module" que no tenian
REM  nada que ver con el codigo.
REM ============================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo  CARPETA: %CD%
echo ============================================================
echo.

echo --- SINTAXIS (lo primero: un fichero roto tumba el backend) ---
call node --check marta-llm.service.js                 || goto :error
call node --check elevenlabs-llm.routes.js             || goto :error
call node --check kitchen-ticket-builder.service.js    || goto :error
call node --check customer-store.js                    || goto :error
call node --check order-call-session.store.js          || goto :error
echo  OK: sintaxis correcta en los 5 ficheros criticos
echo.

echo --- SUITE COMPLETA ---
call npm.cmd test
echo.

echo --- ESTADO DE GIT ---
call git status --short
echo.
echo HEAD local  :
call git rev-parse HEAD
echo origin/main :
call git rev-parse origin/main
echo.

echo --- COMMIT DESPLEGADO EN PRODUCCION ---
call curl -s https://vozra-orders-production.up.railway.app/health
echo.
echo.

echo ============================================================
echo  FIN. Copia toda esta salida y pegasela a Claude.
echo ============================================================
pause
exit /b 0

:error
echo.
echo ############################################################
echo  ERROR DE SINTAXIS. NO despliegues: el backend no arrancaria.
echo ############################################################
pause
exit /b 1
