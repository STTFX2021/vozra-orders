# PROJECT_STATE — Vozra PID / Vozra Orders (FUENTE DE VERDAD ÚNICA)

> **Este es el sitio único con todo Vozra PID.** Solo PID (pizzería La Locanda). Roomy Food vive aparte en `../roomy-food` con su propia memoria. El histórico cronológico está en `SESSION_LOG.md`; este fichero es SIEMPRE el presente.

**Última actualización:** 2026-07-28
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

## 3. ⚠️ ESTADO DE DESPLIEGUE (crítico)
- **Commit desplegado en producción: `2bc9448`** (activo desde 26-jul, "cliente registrado NUNCA oye la pregunta…").
- **`origin/main` = `2bc9448`.** El `main` **local está 5 commits por delante SIN pushear** (`095d68c`, `b97948f`, `982950a`, `45e36c4`, `171dadb`), +1 más sin commitear (los fixes del 28-07) → hasta **+6 sin desplegar**.
- **Consecuencia:** en producción NO están `realCustomerName`, el bloqueo de alergias no solicitadas, las cantidades derivadas ni nada del 28-07. Muchos "bugs" reportados ya están resueltos en local pero nunca subidos.
- **Para poner al día producción:** commit → `git push origin main` → Railway auto-despliega → **llamada de prueba**. (Railway tuvo incidencia de builds el 28-jul; puede retrasar.)

## 4. El cerebro (`marta-llm.service.js`)
- Entrada: `generateMartaReply(callId, incomingMessages, callerPhone)`. Historial formato OpenAI.
- Tools (6): `submit_order`, `calcular_total`, `buscar_cliente`, `validar_direccion`, `consultar_pedido`, `registrar_incidencia`.
- Gate P0 fail-closed: `validateOrder` bloquea efectos si la validación falla (`test-submit-order-validation-gate.cjs`).
- Deterministas ya en código (no dependen de que el LLM recuerde): precarga de perfil por teléfono, prevalidación de zona, `stripConsentIfRegistered`, `registeredCustomerDirective`, `realCustomerName`, `resolvePerPizzaQuantities`, `upsellAlreadyOffered`, dedup de dispatch por firma.
- **Latencia:** system prompt = **42.685 chars ≈ 10.671 tokens por turno**. Causa: `${buildMenuText()}` (L400) embebe la carta completa (79 platos con descripción+alérgenos) en cada turno. Palancas seguras no aplicadas: prompt caching de OpenAI (el system prompt es idéntico cada turno) y/o adelgazar la carta. Requieren test + OK.

## 5. Fixes aplicados (detalle en SESSION_LOG)
- **28-07 (en local, SIN commit):** alergia sin "Oye" + lógica retirable/intrínseco (decisión: quitar topping y seguir, NO bloqueo); upsell exactamente una vez (determinista); `save_profile_consent=false` forzado en cliente registrado; fuera tiempos de entrega inventados (no hay fuente de ETA). Nuevo `allergen-ontology.service.js`. Nuevo `test-pid-fixes-20260728.cjs` (18 verdes).
- **20-07:** nombres genéricos ("Cliente") filtrados por `realCustomerName`; dirección prohibida en RECOGER.
- **18-07 y antes:** orden teléfono-primero, puntos suspensivos eliminados, desambiguación de platos, candado de alérgenos, zona de reparto (8 km), pago efectivo, promociones (vacío), incidencias.

## 6. Ontología de alérgenos (montada, vacía)
`backend/allergen-ontology.service.js`: `ONTOLOGY = {}`. Enganche listo (`classifyAllergen`, `hasOntologyData`). Cuando el restaurante dé por plato qué alérgeno es topping retirable vs intrínseco, rellenar el mapa → la carta que ve Sarah lo muestra y deja de deducir. Interino: Sarah deduce de la descripción.

## 7. Decisión de producto vigente (alergias)
Se **anota** la alergia (kitchenNote) y se **asesora** al cliente. Si el alérgeno es un topping retirable → se ofrece quitarlo y **el pedido continúa y se confirma**. Si es intrínseco → se recomienda otro plato. **NO hay gate de bloqueo/revisión** (descartado por el owner el 28-07). No se afirma "100% seguro".

## 8. Deuda técnica conocida
- Tests cubren motor legacy (`order-slot-filler`) + contrato del prompt; el camino real (`generateMartaReply`) no se testea con el LLM en vivo.
- Mono-tenant de facto (`la-locanda` hardcodeado en varios sitios).
- Endpoints sin auth (`/kitchen/ack`); LLM abierto si falta secret; PII en logs y en `orders_fallback/` (32 pedidos en texto plano).
- Monitor de ACK en memoria (se pierde al reiniciar).
- `simulator.js` usa el motor legacy `processTurn`, NO el cerebro → no refleja producción.
- Memoria del proyecto ahora vive en `backend/docs/memory/` (dentro del git root) para quedar versionada.
- **Archivos esparcidos fuera del repo:** carpeta `C:\Users\Orochika\Claude\Projects\04_Vozra_Orders\` con parches PID históricos (0001–0015, ya en git) + copia de `marta-llm.service.js` + diagnósticos, y — mezclados — ficheros de ROOMY (`THE_MARKET_menu-taxonomy.v1.json`, `PROMPT_SARA_room_service_v1.md`) que deben ir a `../roomy-food`. Pendiente de limpieza.
- **Auditoría formal 2026-07-17** en `docs/` (D:), riesgo top S6 (invariantes en prompt vs código); ya atacado por `stripConsentIfRegistered` y por los deterministas del 28-07.

## 9. Próximo paso
Ver `NEXT_SESSION.md`: commit (funcional + docs separados) → push → deploy → llamada de prueba. Autorización de push pendiente del owner.

## 10. Archivos clave / IDs / URLs
Ver `KEY_FACTS.md`.
