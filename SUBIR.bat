@echo off
REM ============================================================
REM  SUBIR.bat - prueba, verifica y sube. Si algo falla, NO sube.
REM  Se puede ejecutar desde cualquier sitio: se coloca solo.
REM ============================================================
cd /d "%~dp0"
echo ============================================================
echo  CARPETA: %CD%
echo ============================================================
echo.

echo --- 1/4 TESTS DE LAS ULTIMAS LLAMADAS ---
for %%F in (test-bucle-upsell-20260807.cjs test-llamadas-20260806.cjs test-upsell-cascada-20260806.cjs) do (
  if exist "%%F" (
    call node "%%F"
    if errorlevel 1 goto :fallo
  )
)
echo.

echo --- 2/4 SUITE COMPLETA ---
call npm test
if errorlevel 1 goto :fallo
echo.

echo --- 3/4 COMMIT ---
call git add -A
call git commit -m "%~1"
echo.

echo --- 4/4 PUSH ---
call git push
if errorlevel 1 goto :fallo
echo.

echo --- COMMIT LOCAL / REMOTO ---
call git rev-parse HEAD
call git rev-parse origin/main
echo.
echo Espera 2 minutos y comprueba el despliegue:
echo   curl -s https://vozra-orders-production.up.railway.app/health
echo.
echo ============================================================
echo  LISTO. Copia toda esta salida y pegasela a Claude.
echo ============================================================
goto :fin

:fallo
echo.
echo ============================================================
echo  ALGO HA FALLADO. NO SE HA SUBIDO NADA.
echo  Copia toda esta salida y pegasela a Claude.
echo ============================================================

:fin
pause
