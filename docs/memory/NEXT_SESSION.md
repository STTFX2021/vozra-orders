# NEXT_SESSION — Vozra PID

> Solo Vozra PID. Roomy Food está en `../roomy-food` con su propia memoria.

**Escrito el:** 2026-07-31
**HEAD = producción:** `1e4e435` (commiteado, pusheado, desplegado en Railway).

## Cómo arrancar (léelo en este orden)
1. `MEMORY_INDEX.md` → este archivo → `PROJECT_STATE.md` → `KEY_FACTS.md`.
2. Todo el trabajo reciente está DESPLEGADO. No hay nada pendiente de commit/push.
3. Regla de oro del owner (sam): **arreglamos LÓGICA, no parches.** Autorización = código determinista, no confiar en que el LLM "recuerde". Responder siempre en español, directo y accionable.
4. **Git root está en `backend/.git`.** Todo `git` se corre desde `…\vozra-orders\backend`, NO desde la carpeta padre (da "not a git repository").

## Estado actual (todo verde y en producción)
Cliente registrado hace el pedido completo SIN que le repregunten nombre/teléfono/dirección; reconoce por nombre y confirma la calle sin cantar el número; alergia se anota pero NUNCA bloquea; borrar alergia funciona en el acto (tool `eliminar_alergia_guardada`); suplementos de extras se avisan; colgar al despedirse implementado (`end_call`). Tests: `test-pid-fixes-20260728.cjs` 47/47 · `test-allergy-remove-20260730.cjs` 5/5 · `test-end-call-20260731.cjs` 21/21.

## PENDIENTE #1 (raíz aún abierta, prioridad alta): ¿el callId es estable?
Todo lo demás cuelga de esto. Hay que **mirar los logs de Railway** una línea `[EL] turn | callId=…`:
- Si es **`conv_...`** → estable. Entonces se puede REFACTORIZAR la deuda: quitar los parches de re-derivación por historial (`phoneFromHistory`, anti-repeat `yaDicho` regex en `marta-llm.service.js`) y pasarlos a **flags de sesión limpios** (`greeted`, `allergyMentioned`, `addressConfirmed`, `upsellOffered`, `farewellArmed`). Menos frágil, menos tokens.
- Si sigue **`el-...`** → la cabecera `X-ElevenLabs-Conversation-Id = {{system__conversation_id}}` no está llegando. Rematar en el panel de ElevenLabs (Custom LLM → Request headers → tipo "Variable" → `system__conversation_id`) y re-publicar. Ojo: al publicar, verificar que **Backup LLM sigue en "Disabled"** (se ha colado a Custom otras veces y mete fillers en inglés + latencia).

## PENDIENTE #2 (verificación de la llamada de prueba del end_call)
Confirmar en llamada real que Sarah CUELGA al despedirse. Si no cuelga:
- Revisar que el system tool **"End Call"** esté activo en Sarah (ElevenLabs → agente Sarah → Tools). Viene por defecto en agentes de dashboard.
- Si habla la despedida pero no cuelga, o cuelga sin hablar: mover la despedida al parámetro `message` de `end_call` (ajuste de 1 línea en `sendStreamResponseWithEndCall`, `elevenlabs-llm.routes.js`).

## PENDIENTE #3 (latencia)
El owner notó que al activar Backup LLM sube la latencia (por eso está Disabled). Aparte, el system prompt son ~10.671 tokens/turno porque embebe la carta entera (`buildMenuText()` en `marta-llm.service.js` ~L400). Palancas seguras sin aplicar: **prompt caching de OpenAI** (el system prompt es idéntico cada turno) y/o adelgazar la carta. Requieren test + OK del owner.

## Deuda técnica conocida (no urgente)
- Tests cubren contrato del prompt y código determinista, NO ejecutan el LLM en vivo → que Sarah OBEDEZCA se valida en llamada real.
- `validateOrder` es gate P0 fail-closed (OK), pero mono-tenant `la-locanda` hardcodeado en varios sitios.
- `/kitchen/ack` sin auth extra; PII en logs y en `orders_fallback/`. Monitor de ACK en memoria (se pierde al reiniciar).
- `simulator.js` usa el motor legacy `processTurn`, NO el cerebro → no refleja producción. No copiar de ahí.
- Warning `geometric-repack ... File exists` en cada commit: lock huérfano en `.git`. Limpiar con `git gc --prune=now`.
- Higiene .git: los `.env` tienen mensajes de "vestauth/inject env" al correr node — es una lib de terceros en el entorno del owner, no del proyecto.

## Comandos útiles (desde `…\vozra-orders\backend`)
```
node --check marta-llm.service.js
node --check elevenlabs-llm.routes.js
node test-pid-fixes-20260728.cjs
node test-allergy-remove-20260730.cjs
node test-end-call-20260731.cjs
git add <ficheros> && git commit -m "..." && git push origin main   # Railway auto-despliega
```

## Datos de prueba en Supabase
Cliente registrado de test: teléfono **`634425921`** (Samuel Tineo), `restrictions.allergies` se usa para probar el borrado de alergia en vivo. Schema `vozra_orders`, tabla `customers`.
