# KEY_FACTS — Datos duros

> IDs, URLs y rutas. **NUNCA secretos** (tokens, API keys, contraseñas). Solo referencias a dónde viven.

**Última actualización:** 2026-07-18

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

## ElevenLabs
- Agente pizzería PRODUCCIÓN: "Sarah — pizzeria la locanda" (voz Aitana). NO tocar sin querer.
- (El agente demo de Roomy y sus datos están en `../roomy-food/docs/memory/KEY_FACTS.md`.)

## Modelos
- LLM producción: OpenAI `gpt-4.1-mini` (vía Custom LLM). Ojo: comentarios del código dicen "gpt-4o-mini" (contradicción documental, no de código).

## Variables de entorno (referencia, valores en Railway)
`OPENAI_API_KEY`, `ELEVENLABS_CUSTOM_LLM_SECRET`, `TELEGRAM_BOT_TOKEN[_LA_LOCANDA]`, `TELEGRAM_CHAT_ID[_LA_LOCANDA]`, `TELEGRAM_WEBHOOK_SECRET`, `DISCORD_WEBHOOK_URL[_LA_LOCANDA]`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ORDERS_SCHEMA`, `TWILIO_*`, `TWILIO_WHATSAPP_FROM`, `CUSTOMER_NOTIFY_CHANNEL`, `FALLBACK_ORDERS_DIR`, `GEOCODER_PROVIDER`, `GOOGLE_MAPS_API_KEY`, `PORT`.

> Datos de Roomy Food (menú Alanda, agente demo, etc.) → `../roomy-food/docs/memory/KEY_FACTS.md`.
