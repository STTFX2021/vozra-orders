# KEY_FACTS — Datos duros

> IDs, URLs y rutas. **NUNCA secretos** (tokens, API keys, contraseñas). Solo referencias a dónde viven.

**Última actualización:** 2026-07-28

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

## Mapa parche→commit (nomenclatura del otro chat)
- 0012 = `12d9cc7` · 0013 = `74e4243` (saludo con calle) · 0014 = `64511ab` (latencia) · **0015 = `2bc9448` (stripConsentIfRegistered) = DESPLEGADO en prod**.
- Commits locales posteriores SIN pushear: `095d68c` (gate P0) · `b97948f` (refinado Sarah) · `982950a` (memoria) · `45e36c4` (no alergias no declaradas) · `171dadb` (cantidades + revisión alérgenos) = HEAD local.

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
