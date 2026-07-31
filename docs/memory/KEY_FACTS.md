# KEY_FACTS — Datos duros

> IDs, URLs y rutas. **NUNCA secretos** (tokens, API keys, contraseñas). Solo referencias a dónde viven.

**Última actualización:** 2026-07-31

---

## Repositorio
- Remoto: `github.com/STTFX2021/vozra-orders.git`
- Rama principal: `main`
- Git root: `backend/.git` (¡no en la raíz del proyecto!)
- Ruta local: `D:\VOZRA\vozra_proyecto_completo_20260620\vozra-orders`
- Usuario git: STTFX2021 / sttfx2021@gmail.com

## Despliegue (La Locanda / Vozra Orders)
- Plataforma: Railway, proyecto `pure-bravery`
- URL producción: `https://vozra-orders-production.up.railway.app`
- Healthcheck: `/health`
- Arranque: `node server.js` (raíz de deploy = carpeta `backend/`)

## Backend — archivos clave
- Cerebro + prompt: `backend/marta-llm.service.js`
- Estado/máquina de pedidos: `backend/order-call-session.store.js`
- Dispatch a cocina: `backend/dispatch-adapter.service.js`
- ACK cocina: `backend/kitchen-ack-monitor.service.js` + `backend/telegram-ack.routes.js`
- Persistencia: `backend/supabase-store.js` + `backend/customer-store.js`
- Config proveedor: `backend/provider-profile.config.js`
- Zona reparto: `backend/delivery-zone.service.js`
- Promociones: `backend/promotions.service.js`
- Incidencias: `backend/incident.service.js`
- Entrada ElevenLabs: `backend/elevenlabs-llm.routes.js`
- Motor legacy (NO usar, no copiar): `backend/order-slot-filler.service.js`

## Supabase
- Proyecto: `vozra`, id `igdbkndadrrljbycfekh`, región eu-west-2
- Schemas propios de Orders: `vozra_orders` (datos), `vozra_control` (control plane multi-tenant)
- Acceso backend: `SUPABASE_SERVICE_ROLE_KEY` (en Railway → Variables; salta RLS)

## ElevenLabs (panel del agente Sarah — consolidado del otro chat 2026-07-28)
- Agente pizzería PRODUCCIÓN: "Sarah — pizzeria la locanda". NO tocar sin querer.
- **Custom LLM** → backend Railway `/chat/completions`; **model id = `vozra-marta-orders`**; Bearer = `ELEVENLABS_CUSTOM_LLM_SECRET`.
- **Backup LLM = Disabled** ← importante: era la causa de los fillers en inglés ("Mm-hmm/Got it"). Los fillers en español restantes son relleno de latencia de ElevenLabs, no del backend.
- Speed 1.03 · Speculative turn OFF · solo Español (0 idiomas extra) · First message pegado a propósito (separado suena lento).
- **Voz activa (decisión owner 2026-07-28): voice_id `dNjJKg63Fr5AXwIdkATa`.** Sustituye el conflicto anterior (Aitana/Cristina). Se fija en el panel de ElevenLabs del agente Sarah (Voice), no por código.
- (El agente demo de Roomy y sus datos están en `../roomy-food/docs/memory/KEY_FACTS.md`. Ojo: "Sarah"=PID pizzería; "SARA AI"=Roomy hotel. No confundir.)

## Modelos
- LLM producción: OpenAI `gpt-4.1-mini` (vía Custom LLM, model id `vozra-marta-orders`). Ojo: comentarios del código dicen "gpt-4o-mini" (contradicción documental, no de código).

## Mapa de commits
- **HEAD = producción = `c93f4db`** (prompt cacheable: cola dinámica al final + `prompt_cache_key` + log de tokens cacheados). Todo sincronizado con `origin/main`.
- Cadena reciente desplegada: `2bc9448` (stripConsentIfRegistered) → … → `06ba512` → `4d44956` (tool eliminar_alergia + backtick roto) → `002a590` (fix backtick crítico) → `1e4e435` (end_call) → `bb6288a` (memoria) → `888767c` (tests F11 suplementos) → **`c93f4db`** (caché de prompt).
- ⚠️ `4d44956` estuvo desplegado ROTO (backtick en el prompt). Arreglado en `002a590`.

## Caché de prompt (OpenAI) — reglas que NO se pueden romper
- La caché es **automática**, pero solo con **prefijo EXACTO** y a partir de **1024 tokens**. Se enruta con `prompt_cache_key: "vozra-pid-<slug>"`.
- Por eso el system prompt es **prefijo estable (~11.206 tokens: identidad, reglas, carta) + cola dinámica al final (`# HORARIO DE COCINA` con la hora, `# CLIENTE RECURRENTE`)**.
- ⚠️ **Nada dinámico por encima de la carta.** Antes del 31-07 el prefijo estable eran 69 tokens y la caché no entraba nunca.
- Verificación en logs de Railway: `[LLM] openai 900ms | in=11400 cached=11136 out=48`.

## Herramientas del cerebro (7) y colgado
- `submit_order`, `calcular_total`, `buscar_cliente`, `validar_direccion`, `consultar_pedido`, `registrar_incidencia`, `eliminar_alergia_guardada`.
- **Colgar = `end_call`**: system tool de ElevenLabs (NO del cerebro). El backend lo emite como `tool_call` en el SSE (`sendStreamResponseWithEndCall` en `elevenlabs-llm.routes.js`). Requiere que "End Call" esté activo en el agente Sarah.

## Ficheros de test (todos desde `backend/`)
- `test-pid-fixes-20260728.cjs` (47) · `test-allergy-remove-20260730.cjs` (5) · `test-end-call-20260731.cjs` (21) · `test-prompt-cache-20260731.cjs` (6) · `test-submit-order-validation-gate.cjs` (gate P0).

## Dato de prueba en Supabase
- Cliente registrado de test: teléfono `634425921` (Samuel Tineo), `vozra_orders.customers`, con `restrictions.allergies` para probar el borrado de alergia en vivo.

## Auditoría formal
- Fecha 2026-07-17, en `docs/` del repo (D:). Riesgo top = **S6** (invariantes críticos en prompt en vez de en código). Contenido íntegro NO leído aún.

## ⚠️ Archivos fuera del repo (a consolidar — "esparcidos")
- Carpeta `C:\Users\Orochika\Claude\Projects\04_Vozra_Orders\`: parches PID `0001`–`0015` (históricos, ya aplicados como commits), copia de `marta-llm.service.js`, diagnósticos Sarah.
- **Mezclados ahí, son de ROOMY (mover a `../roomy-food`):** `THE_MARKET_menu-taxonomy.v1.json`, `PROMPT_SARA_room_service_v1.md`.

## Twilio (prueba de llamada real)
- Llamada saliente al número del owner disponible. Vars en Railway: `TWILIO_ACCOUNT_SID/AUTH_TOKEN`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_AGENT_PHONE_NUMBER_ID`.

## Variables de entorno (referencia, valores en Railway)
`OPENAI_API_KEY`, `ELEVENLABS_CUSTOM_LLM_SECRET`, `TELEGRAM_BOT_TOKEN[_LA_LOCANDA]`, `TELEGRAM_CHAT_ID[_LA_LOCANDA]`, `TELEGRAM_WEBHOOK_SECRET`, `DISCORD_WEBHOOK_URL[_LA_LOCANDA]`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ORDERS_SCHEMA`, `TWILIO_*`, `TWILIO_WHATSAPP_FROM`, `CUSTOMER_NOTIFY_CHANNEL`, `FALLBACK_ORDERS_DIR`, `GEOCODER_PROVIDER`, `GOOGLE_MAPS_API_KEY`, `PORT`.

> Datos de Roomy Food (menú Alanda, agente demo, etc.) → `../roomy-food/docs/memory/KEY_FACTS.md`.
