# PROJECT_STATE — Vozra PID / Vozra Orders (fuente de verdad)

> Solo Vozra PID (pizzería La Locanda). Roomy Food vive en su propio proyecto: `../roomy-food`.

**Última actualización:** 2026-07-18

## Qué es
Agente de voz para pedidos telefónicos de la pizzería **La Locanda de Cancelada**. **OPERATIVO end-to-end en producción**: llamada → conversa → comanda → Telegram a cocina → ACK → vuelta al sistema.

## Infra
- Repo: `github.com/STTFX2021/vozra-orders.git`, rama `main`. Git root en `backend/.git`.
- Deploy: Railway (proyecto `pure-bravery`), `https://vozra-orders-production.up.railway.app`, healthcheck `/health`.
- Cerebro: OpenAI `gpt-4.1-mini` como Custom LLM de ElevenLabs.
- Agente ElevenLabs: "Sarah — pizzeria la locanda", voz Aitana.
- Supabase: proyecto `vozra` (`igdbkndadrrljbycfekh`), schema `vozra_orders` (orders, customers, call_logs, demo_callbacks, providers, usage_monthly, incidents).

## Fixes aplicados esta sesión (verificar que estén desplegados en Railway)
- Desambiguación de platos colisionantes (carbonara pasta/pizza): no pregunta si el cliente ya dio categoría.
- No recitar ingredientes salvo que pregunten.
- Notificar hora concreta de recogida/entrega (no "lo antes posible").
- Domicilio exige teléfono además de dirección.
- Candado de alérgenos: solo avisa si el cliente declara alergia.
- Saneador de voz robusto (comillas encadenadas + muletillas EN incl. "Duly noted").
- **Orden de datos: PRIMERO teléfono → buscar_cliente → si registrado confirma dirección (no la re-pide) → si nuevo pide dirección.**
- **Puntos suspensivos ELIMINADOS del prompt y del texto de salida** (causaban ruidos TTS). La regla de leer teléfonos usaba "..." como pausa — corregido a comas.
- Añadidos: zona de reparto por radio (8 km, geocodificado desde dirección del local), forma de pago (efectivo), motor de promociones (vacío, listo), rama de consultas/incidencias.

**Nota de deploy:** si persisten ruidos "Ahhh..." o puntos suspensivos tras desplegar, sospechar build viejo en Railway.

## Archivos clave
Ver `KEY_FACTS.md`.

## Deuda técnica conocida (de la auditoría)
- Tests cubren el motor legacy (`order-slot-filler`), no el cerebro real (`generateMartaReply`).
- Mono-tenant de facto (`la-locanda` hardcodeado en varios sitios).
- Invariantes críticos (teléfono/dirección/alérgenos) dependen del prompt, no de código bloqueante.
- Endpoints sin auth (`/kitchen/ack`); LLM abierto si falta secret; PII en logs.
- Monitor de ACK en memoria (se pierde al reiniciar).
