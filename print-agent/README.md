# Vozra Print Agent

Imprime las comandas de Vozra Orders en la impresora térmica de cocina (ESC/POS).
Corre en un aparato **dentro** de la pizzería (tablet con Termux, mini-PC o Raspberry).
La nube no puede alcanzar la impresora directamente: este agente la "pregunta" al
backend y la imprime en la red local.

## Requisitos
- Node.js 18+ en el aparato.
- Impresora térmica ESC/POS en la misma red (Epson TM-T20/T88, etc.) con IP fija.

## Instalación por local (lo único que cambia es la IP)
1. Copia esta carpeta al aparato.
2. `copy .env.example .env` (o `cp` en Linux) y edita **.env**:
   - `RAILWAY_URL` → URL del backend (ya viene puesta).
   - `AGENT_SECRET` → el mismo valor que `PRINT_AGENT_SECRET` del backend.
   - `PRINTER_IP` → **la IP de la impresora de ESTE local** (lo único que cambia).
   - `PRINTER_PORT` → normalmente `9100`.
   - `PRINTER_WIDTH` → `48` (papel 80mm) o `32` (58mm).
3. Probar sin imprimir: pon `SIMULATE=1` y ejecuta `node index.js --once`.
   Verás la comanda en `./tickets/`.
4. En real: `SIMULATE=0` y `npm start` (o configúralo para arrancar con el sistema).

## Cómo saber la IP de la impresora
- En la mayoría de Epson TM: apaga, mantén el botón FEED y enciende → imprime un
  ticket de autodiagnóstico con su IP.
- O míralo en el router (dispositivos conectados).

## Arranque automático (recomendado en producción)
- Windows: Programador de tareas → al iniciar sesión → `node index.js`.
- Linux/Raspberry: servicio systemd o `pm2 start index.js --name vozra-print`.

## Notas
- Cero dependencias externas: solo Node.
- Si la impresora o el backend fallan, la comanda **no se pierde**: se reintenta en
  la siguiente vuelta hasta imprimirse y confirmarse.
