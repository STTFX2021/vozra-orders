# PROJECT_STATE — Vozra PID / Vozra Orders (FUENTE DE VERDAD ÚNICA)

> **Este es el sitio único con todo Vozra PID.** Solo PID (pizzería La Locanda). Roomy Food vive aparte en `../roomy-food` con su propia memoria. El histórico cronológico está en `SESSION_LOG.md`; este fichero es SIEMPRE el presente.

**Última actualización:** 2026-07-31
**Owner:** sam (STTFX2021 / sttfx2021@gmail.com)

---

## 1. Qué es
Agente de voz para pedidos telefónicos de la pizzería **La Locanda de Cancelada (Málaga)**. Operativo end-to-end: llamada → Sarah conversa → toma la comanda → la dispara a cocina (Telegram, con fallback Discord→fichero) → monitor de ACK → vuelta al sistema. Un solo cerebro (Sarah), sin segundo agente.

## 2. Infraestructura
- **Repo:** `github.com/STTFX2021/vozra-orders.git`, rama `main`. ⚠️ **Git root en `backend/.git`**, NO en la raíz del proyecto. Todo git se corre desde `…\vozra-orders\backend`.
- **Deploy:** Railway, proyecto **`pure-bravery`** / entorno `production`. Servicio `vozra-orders` → `https://vozra-orders-production.up.railway.app`. Healthcheck `/health` (timeout 10s). Restart on-failure x3. **Auto-deploy desde GitHub `main`.** 19 variables de entorno (en Railway → Variables; sin secretos aquí).
- **Cerebro:** OpenAI **`gpt-4.1-mini`** como Custom LLM de ElevenLabs. 1 llamada/turno normal (≤2 con tools, en paralelo). Sin SDKs: integraciones por `https` nativo.
- **Voz/ElevenLabs:** agente "Sarah — pizzeria la locanda". Custom LLM → backend (model id `vozra-marta-orders`, Bearer `ELEVENLABS_CUSTOM_LLM_SECRET`). **Backup LLM = Disabled** (causaba fillers en inglés). Speed 1.03, Speculative turn OFF, solo Español. **Voz activa: voice_id `dNjJKg63Fr5AXwIdkATa`** (decisión owner 28-07; se fija en el panel de ElevenLabs, no por código).
- **Supabase:** proyecto `vozra` (`igdbkndadrrljbycfekh`, eu-west-2), schema `vozra_orders` (orders, customers, call_logs, demo_callbacks, providers, usage_monthly, incidents). También existe `vozra_control` (control plane, uso Roomy/multi-tenant).

## 3. ESTADO DE DESPLIEGUE
- **Commit desplegado en producción = HEAD = `3b55b6b`** (02-08). `origin/main` y `main` local sincronizados. **No hay nada pendiente de push.**
- Todo lo del 28→31 de julio ESTÁ en producción: reconocimiento persistente, alergia no bloquea, borrado de alergia, suplementos, colgar al despedirse, **prompt cacheable**, `/admin/test-call` y **webhooks fail-closed**.
- Cadena reciente: `…1e4e435` → `bb6288a` → `888767c` → `c93f4db` → `1844f06` → `bf2e5be` → **`84f8e94`** (HEAD).
- ⚠️ **Incidente 31-07 ya resuelto:** `4d44956` se desplegó ROTO (un backtick dentro del prompt-template-literal rompía el módulo; `node --check` fallaba). Arreglado en `002a590`. **Regla:** nunca usar backticks dentro del system prompt de `marta-llm.service.js`.
- **Para desplegar:** commit → `git push origin main` (desde `backend/`) → Railway auto-despliega → llamada de prueba.

## 4. El cerebro (`marta-llm.service.js`)
- Entrada: `generateMartaReply(callId, incomingMessages, callerPhone)`. Historial formato OpenAI.
- Tools (7): `submit_order`, `calcular_total`, `buscar_cliente`, `validar_direccion`, `consultar_pedido`, `registrar_incidencia`, **`eliminar_alergia_guardada`**.
- El colgado (`end_call`) NO es una tool del cerebro: se emite como `tool_call` en el stream desde `elevenlabs-llm.routes.js` (ver §5).
- Gate P0 fail-closed: `validateOrder` bloquea efectos si la validación falla (`test-submit-order-validation-gate.cjs`).
- Deterministas ya en código (no dependen de que el LLM recuerde): precarga de perfil por teléfono, prevalidación de zona, `stripConsentIfRegistered`, `registeredCustomerDirective`, `realCustomerName`, `resolvePerPizzaQuantities`, `upsellAlreadyOffered`, dedup de dispatch por firma.
- **Latencia / caché de prompt (31-07, desplegado):** el system prompt son ~45.000 chars ≈ **11.260 tokens por turno** (lo domina `${buildMenuText()}`, la carta completa). Está deliberadamente estructurado como **PREFIJO ESTABLE + COLA DINÁMICA**: todo lo que cambia (el bloque `# HORARIO DE COCINA` con "Ahora son las HH:MM" y el `# CLIENTE RECURRENTE`) va **al FINAL**. Motivo: OpenAI cachea por prefijo EXACTO y solo desde 1024 tokens; antes el prefijo estable eran **69 tokens** (la hora estaba a 3.500 tokens del inicio, con la carta detrás) → la caché no entraba nunca. Ahora el prefijo estable son **11.206 tokens**. Se envía `prompt_cache_key: "vozra-pid-<slug>"`. Blindado por `test-prompt-cache-20260731.cjs`.
  - ⚠️ **NO metas contenido dinámico (hora, perfil, estado) por encima de la carta.** Rompe la caché entera y el test lo cazará.
  - Verificación en logs de Railway: `[LLM] openai 900ms | in=11400 cached=11136 out=48`. `cached≈11000` desde el 2º turno = caché OK; `cached=0` siempre = algo la rompió.
  - Palanca restante sin aplicar: **adelgazar la carta** (requiere test + OK del owner).

## 4bis. Endpoints de administración y seguridad de webhooks (31-07)
- **`/admin/test-call`** (`admin-test-call.routes.js`) — **Sarah te llama**. `GET /admin/test-call/diag` dice qué falta (solo booleanos) y trae un panel `seguridad{}`; `POST /admin/test-call` con `{"to":"+34…"}` lanza la llamada. Bearer obligatorio (`ADMIN_TEST_CALL_SECRET` → si falta, `ELEVENLABS_CUSTOM_LLM_SECRET`), fail-closed, allowlist `TEST_CALL_ALLOWED_NUMBERS`, teléfono enmascarado.
  - ⚠️ **La llamada saliente la hace ElevenLabs, NO Twilio directo** (`POST /v1/convai/twilio/outbound-call`). Con la API de Twilio a pelo el teléfono suena pero SIN Sarah.
- **Webhook de Twilio (`/whatsapp/incoming`): fail-closed en producción.** En Railway se **ignora** `TWILIO_SKIP_SIGNATURE` y se **exige** `TWILIO_AUTH_TOKEN` (antes ambas dejaban el webhook abierto). La URL a firmar se construye con `x-forwarded-proto` (detrás del proxy `req.protocol` da `http` y Twilio firma `https`). Comparación con `timingSafeEqual`. Test: `test-webhook-security-20260731.cjs`.
- **Turnstile:** `turnstileSecret()` acepta `TURNSTILE_SECRET` (canónico) y alias, incluido el literal `"Secret key"` que pone Cloudflare — así estaba en Railway y por eso la demo web daba 503. Sigue fail-closed.

## 4ter. REGLA DE ORO DEL CEREBRO (aprendida a base de bucles, 01/02-08)
**Ninguna directiva inyectada puede repetirse sin contador y sin límite.** Todos los bucles de la sesión del 01-08 tenían la misma causa: una orden reinyectada en cada turno sin memoria de si ya se había cumplido (aviso de suplemento, nombre del cliente, gate de datos, dirección). Antes de añadir cualquier `messages.push({role:"system"…})` nuevo: ¿cómo sé que ya se cumplió, y cuál es el tope de veces que puede sonar?
- Implementado: `vecesPedidoCadaDato()` (tope 2 por dato), `suplementoYaAvisado()`, `upsellOffered` en sesión, `repitePreguntaAnterior()`, `turnoDeUsuarioVacio()`.
- **Un dato que falta NUNCA puede bloquear la llamada**: a las 2 veces se deja de pedir y se sigue.
- **Honestidad innegociable**: prohibido afirmar tener un dato que no se tiene y prohibido inventarse "políticas de privacidad".
- **Lo que dice el cliente en vivo MANDA sobre lo guardado**, y se persiste en Supabase en el acto.
- **Nunca trocear un dato del cliente**: el nombre va COMPLETO a la comanda (`nombreParaSaludar()` solo acorta nombres formales tipo "Samuel Tineo").

## 5. Fixes aplicados (detalle en SESSION_LOG)
- **01/02-08 (desplegado, hasta `3b55b6b`):** anti-bucle determinista, gate de datos del cliente (revisar BD antes de la comanda, pedir solo lo que falta, consentimiento solo a cliente nuevo y al final), regla de honestidad, persistencia inmediata de correcciones, dirección guardada que se confirma en vez de preguntarse, upsell que no ofrece lo que ya está en el pedido, nombre compuesto sin trocear y silencio del cliente sin repetir resumen. Tests nuevos: `test-antibucle-20260801` (12), `test-nombre-corregido-20260801` (13), `test-datos-cliente-20260801` (12), `test-perfil-nuevo-20260801` (9), `test-redundancias-20260801` (9), `test-nombre-compuesto-20260802` (12). Endpoints de diagnóstico `/admin/test-call/probe` y `/admin/test-call/autopsia`.
- **31-07 tarde-2 (desplegado, `bf2e5be` + `84f8e94`):** endpoint `/admin/test-call` (llamada saliente de prueba) y **cierre de dos agujeros**: webhook de Twilio abierto en producción (SKIP_SIGNATURE + fail-open sin token) y Turnstile que no se leía por el nombre de la variable. Ver §4bis.
- **31-07 tarde (desplegado, `c93f4db`):** **prompt cacheable** — cola dinámica (horario + perfil recurrente) movida al final del system prompt, `prompt_cache_key` en el payload de OpenAI y log `in=/cached=/out=` para verificar la caché en Railway. Prefijo estable 69 → 11.206 tokens. Test `test-prompt-cache-20260731.cjs` (6). Además: higiene de `.git` (lock huérfano de `geometric-repack` limpiado con `git gc --prune=now`).
- **31-07 (desplegado):** (a) tool determinista **`eliminar_alergia_guardada`** — borra la alergia de Supabase y de la sesión en el acto y deja de mencionarla en el mismo turno; (b) **colgar al despedirse** — al despachar se arma `session.farewellArmed`; en el turno siguiente, si `isFarewell()`, el backend (`elevenlabs-llm.routes.js`) da una despedida corta y emite `tool_call end_call` en el SSE (ElevenLabs cuelga), lo que además elimina el doble "queda confirmado"; (c) **fix crítico** del backtick roto en el prompt. Tests `test-allergy-remove-20260730.cjs` (5) + `test-end-call-20260731.cjs` (21).
- **30-07 (desplegado):** raíz del "pide datos que ya tiene" = callId inestable → re-derivación por historial (`phoneFromHistory`, `loadProfileCached` 120s); anti-repetición saludo/dirección/alergia (`yaDicho`); `removed_allergies` en submit_order; `restrictions` jsonb en `customers`; `call_logs` (`upsertCallLog`); mitad-y-mitad (precio de la más cara); "una por pizza" (`resolvePerPizzaQuantities`); suplementos de extras (`computeQuote` → `suplementos`/`aviso_suplementos`). Cabecera `X-ElevenLabs-Conversation-Id={{system__conversation_id}}` publicada.
- **28-07 (desplegado):** alergia sin "Oye" + lógica retirable/intrínseco (decisión: quitar topping y seguir, NO bloqueo); upsell exactamente una vez (determinista); `save_profile_consent=false` forzado en cliente registrado; fuera tiempos de entrega inventados. Nuevo `allergen-ontology.service.js`. `test-pid-fixes-20260728.cjs` (47 verdes actualmente).
- **20-07:** nombres genéricos ("Cliente") filtrados por `realCustomerName`; dirección prohibida en RECOGER.
- **18-07 y antes:** orden teléfono-primero, puntos suspensivos eliminados, desambiguación de platos, candado de alérgenos, zona de reparto (8 km), pago efectivo, promociones (vacío), incidencias.

## 6. Ontología de alérgenos (montada, vacía)
`backend/allergen-ontology.service.js`: `ONTOLOGY = {}`. Enganche listo (`classifyAllergen`, `hasOntologyData`). Cuando el restaurante dé por plato qué alérgeno es topping retirable vs intrínseco, rellenar el mapa → la carta que ve Sarah lo muestra y deja de deducir. Interino: Sarah deduce de la descripción.

## 7. Decisión de producto vigente (alergias)
Se **anota** la alergia (kitchenNote) y se **asesora** al cliente. Si el alérgeno es un topping retirable → se ofrece quitarlo y **el pedido continúa y se confirma**. Si es intrínseco → se recomienda otro plato. **NO hay gate de bloqueo/revisión** (descartado por el owner el 28-07). No se afirma "100% seguro".

## 8. Deuda técnica conocida
- Tests cubren motor legacy (`order-slot-filler`) + contrato del prompt; el camino real (`generateMartaReply`) no se testea con el LLM en vivo.
- Mono-tenant de facto (`la-locanda` hardcodeado en varios sitios).
- Endpoints sin auth: queda **`/kitchen/ack`** (el webhook de Twilio y el LLM ya son fail-closed en producción). PII en logs y en `orders_fallback/` (32 pedidos en texto plano).
- **Limpieza pendiente en Railway (no bloquea):** borrar `TWILIO_SKIP_SIGNATURE` (en producción ya se ignora, pero sobra y confunde) y renombrar `Secret key`/`Site key` → `TURNSTILE_SECRET`/`TURNSTILE_SITE_KEY`.
- Monitor de ACK en memoria (se pierde al reiniciar).
- `simulator.js` usa el motor legacy `processTurn`, NO el cerebro → no refleja producción.
- Memoria del proyecto ahora vive en `backend/docs/memory/` (dentro del git root) para quedar versionada.
- **Archivos esparcidos fuera del repo:** carpeta `C:\Users\Orochika\Claude\Projects\04_Vozra_Orders\` con parches PID históricos (0001–0015, ya en git) + copia de `marta-llm.service.js` + diagnósticos, y — mezclados — ficheros de ROOMY (`THE_MARKET_menu-taxonomy.v1.json`, `PROMPT_SARA_room_service_v1.md`) que deben ir a `../roomy-food`. Pendiente de limpieza.
- **Auditoría formal 2026-07-17** en `docs/` (D:), riesgo top S6 (invariantes en prompt vs código); ya atacado por `stripConsentIfRegistered` y por los deterministas del 28-07.

## 9. Próximo paso
Ver `NEXT_SESSION.md`. Resumen: **una sola llamada de prueba resuelve los tres pendientes a la vez** — en sus logs de Railway se lee (1) si el `callId` ya es `conv_...` (estable) para poder refactorizar los parches de historial a flags de sesión limpios, (2) si `cached≈11000` (la caché de prompt entra), y en la propia llamada (3) si Sarah CUELGA al despedirse. Nada pendiente de commit/push.

## 10. Archivos clave / IDs / URLs
Ver `KEY_FACTS.md`.
