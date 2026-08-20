@echo off
setlocal enabledelayedexpansion
REM ============================================================
REM  SUBIR.bat - prueba, verifica y sube. Si algo falla, NO sube.
REM  Se puede ejecutar desde cualquier sitio: se coloca solo.
REM
REM  REVISADO 20-08. Tres agujeros que tenia, y por donde se colaron
REM  las dos ultimas regresiones:
REM   1) el bloque 1b usaba "if exist": si alguien renombraba o borraba
REM      un test, el script no decia nada y seguia VERDE. Es el patron
REM      de f86d83f. Ahora la ausencia de un test es ROJA.
REM   2) "git add -A" ya colo salida.txt una vez (commit 0255f3e). Ahora
REM      se revisa lo que va a entrar y se aborta si hay algo peligroso.
REM   3) el commit no tenia guardia: con un mensaje vacio fallaba, el
REM      script seguia y decia LISTO igualmente. Falsa sensacion de subida.
REM ============================================================
cd /d "%~dp0"

if "%~1"=="" (
  echo.
  echo  ERROR: falta el mensaje de commit.
  echo  Uso:  SUBIR.bat "fix: lo que sea"
  goto :fallo
)

echo ============================================================
echo  CARPETA: %CD%
echo ============================================================
echo.

echo --- 1/5a LLAMADAS COMPLETAS (conversacionales) ---
set CONV=0
for %%F in (test-conversacional-*.cjs) do (
  set /a CONV+=1
  call node "%%F"
  if errorlevel 1 goto :fallo
)
if "!CONV!"=="0" (
  echo  ERROR: no se ha ejecutado NINGUN test conversacional.
  echo  O se han borrado, o se han renombrado. Eso no puede pasar en silencio.
  goto :fallo
)
echo   [!CONV! llamadas completas ejecutadas]
echo.

echo --- 1/5b TESTS DE LAS ULTIMAS LLAMADAS ---
REM SIN "if exist" a proposito: si un test desaparece, esto se pone ROJO.
for %%F in (test-si-no-y-aviso-20260808.cjs test-alergia-ficha-vs-plato-20260808.cjs test-bucle-upsell-20260807.cjs test-llamadas-20260806.cjs test-upsell-cascada-20260806.cjs test-total-y-cierre-20260809.cjs test-lo-que-ya-sabes-20260809.cjs) do (
  call node "%%F"
  if errorlevel 1 goto :fallo
)
echo.

echo --- 2/5 SUITE COMPLETA ---
call npm test
if errorlevel 1 goto :fallo
echo.

echo --- 3/5 QUE ENTRA EN EL COMMIT ---
call git add -A
call git diff --cached --name-only
call git diff --cached --name-only > "%TEMP%\vozra_staged.txt"
findstr /i /r /c:"\.env" /c:"\.key" /c:"\.pem" /c:"salida\.txt" /c:"\.log" /c:"credencial" "%TEMP%\vozra_staged.txt" >nul
if not errorlevel 1 (
  echo.
  echo  ============================================================
  echo   ABORTADO: hay un fichero que NO deberia subir a git.
  echo   Mira la lista de arriba y revisa el .gitignore.
  echo  ============================================================
  call git reset
  goto :fallo
)
echo   ok  nada sospechoso en el commit
echo.

echo --- 4/5 COMMIT ---
call git commit -m "%~1"
if errorlevel 1 (
  echo.
  echo  El commit no se ha hecho. Si es porque no habia cambios, no pasa nada,
  echo  pero NO se sube nada y no digo LISTO.
  goto :fallo
)
echo.

echo --- 5/5 PUSH ---
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
