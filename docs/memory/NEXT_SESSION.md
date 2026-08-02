# NEXT_SESSION — Vozra PID

> Solo Vozra PID. Roomy Food está en `../roomy-food` con su propia memoria.

**Escrito el:** 2026-08-02
**HEAD = producción:** `3b55b6b` (commiteado, pusheado, desplegado en Railway).

## ⚡ LO PRIMERO: una llamada de prueba y leerla con la autopsia

```
node -e "require('dotenv').config();const s=process.env.RAILWAY_LLM_SECRET;const https=require('https');const b=JSON.stringify({to:'+34634425921'});const r=https.request({hostname:'vozra-orders-production.up.railway.app',path:'/admin/test-call',method:'POST',headers:{Authorization:'Bearer '+s,'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>console.log(x.statusCode,d))});r.write(b);r.end()"
```
Y con el `conversation_id` que devuelve: `GET /admin/test-call/autopsia?conv=conv_…` da transcript, motivo de corte y config del agente. **Ya no hace falta pedir logs de Railway para diagnosticar una llamada.**

> El Bearer sale de `RAILWAY_LLM_SECRET` en el `.env` local (lo puso el owner el 31-07; es el valor de `ELEVENLABS_CUSTOM_LLM_SECRET` de Railway, que NO coincide con el `ELEVENLABS_CUSTOM_LLM_SECRET` del `.env`).

## Qué verificar en esa llamada (los 3 fixes del 02-08 sin confirmar en vivo)
1. **Nombre compuesto entero.** Con el `679391554` (ficha: "Jodido cabezón") debe decirlo COMPLETO al saludar y al confirmar, y mandarlo completo a cocina. Antes iba "Jodido".
2. **Silencio.** Si te callas tras el resumen, debe decir solo "¿Sigues ahí?" — nunca repetir el resumen entero.
3. **Corrección de nombre.** Di "mi nombre real es X Y" y comprueba en Supabase que la ficha se actualiza (`select phone,name from vozra_orders.customers where phone='679391554'`).

## Pendientes anteriores que siguen abiertos
- **¿`callId` estable?** Mirar `[EL] turn | callId=…` en Railway: si es `conv_…`, se puede refactorizar la deuda (quitar `phoneFromHistory` / `yaDicho` y pasar a flags de sesión limpios).
- **¿Cuelga al despedirse?** El agente Sarah solo tiene la tool `play_keypad_touch_tone`: **no aparece "End Call"**. Si no cuelga, activarlo en ElevenLabs → Sarah → Tools.
- **Caché de prompt:** confirmar `cached≈11000` en el log `[LLM] openai … in= cached= out=`.
- Limpieza en Railway: quitar `TWILIO_SKIP_SIGNATURE`, renombrar `Secret key` → `TURNSTILE_SECRET`.

## ⚡ EMPIEZA POR AQUÍ: UNA llamada de prueba cierra los tres pendientes

**Ahora Sarah puede llamarte ella** (no hace falta que llames tú). Con el valor de `ELEVENLABS_CUSTOM_LLM_SECRET` de Railway → Variables:

```
curl -s -H "Authorization: Bearer TU_SECRET" https://vozra-orders-production.up.railway.app/admin/test-call/diag
curl -s -X POST -H "Authorization: Bearer TU_SECRET" -H "Content-Type: application/json" -d "{\"to\":\"+34634425921\"}" https://vozra-orders-production.up.railway.app/admin/test-call
```

Pedido corto + despedida, y guarda los logs de Railway. Con eso se resuelve todo lo de abajo de golpe:

| Qué mirar | Dónde | Qué significa |
|---|---|---|
| `[EL] turn \| callId=…` | log Railway | `conv_…` = estable ✅ (desbloquea el refactor). `el-…` = la cabecera no llega ❌ |
| `[LLM] openai …ms \| in=… cached=… out=…` | log Railway | `cached≈11000` desde el 2º turno = caché de prompt OK ✅. `cached=0` siempre = algo la rompió ❌ |
| ¿Cuelga al despedirse? | la propia llamada | Si habla el adiós pero no cuelga → falta activar "End Call" en Sarah |
| ¿Te reconoce como Samuel? | la propia llamada | ⚠️ En SALIENTE el `system__caller_id` puede no llegar igual que en entrante. Si NO te reconoce, mira `callerPhone` en el log: vacío o con el número de Twilio = problema del modo saliente, **no** regresión del reconocimiento |

**Limpieza pendiente en Railway (30 seg, no bloquea):** borrar `TWILIO_SKIP_SIGNATURE` (en producción ya se ignora) y renombrar `Secret key`/`Site key` → `TURNSTILE_SECRET`/`TURNSTILE_SITE_KEY` (con ese nombre y espacio `process.env` no las leía → la demo web de Lovable daba 503; el código ya las rescata por alias, pero el nombre correcto es mejor).

## Cómo arrancar (léelo en este orden)
1. `MEMORY_INDEX.md` → este archivo → `PROJECT_STATE.md` → `KEY_FACTS.md`.
2. Todo el trabajo reciente está DESPLEGADO. No hay nada pendiente de commit/push.
3. Regla de oro del owner (sam): **arreglamos LÓGICA, no parches.** Autorización = código determinista, no confiar en que el LLM "recuerde". Responder siempre en español, directo y accionable.
4. **Git root está en `backend/.git`.** Todo `git` se corre desde `…\vozra-orders\backend`, NO desde la carpeta padre (da "not a git repository").

## Estado actual (todo verde y en producción)
Cliente registrado hace el pedido completo SIN que le repregunten nombre/teléfono/dirección; reconoce por nombre y confirma la calle sin cantar el número; alergia se anota pero NUNCA bloquea; borrar alergia funciona en el acto (tool `eliminar_alergia_guardada`); suplementos de extras se avisan; colgar al despedirse implementado (`end_call`); y el system prompt ya es **cacheable** (prefijo estable de 11.206 tokens). Tests: `test-pid-fixes-20260728.cjs` 47/47 · `test-allergy-remove-20260730.cjs` 5/5 · `test-end-call-20260731.cjs` 21/21 · `test-prompt-cache-20260731.cjs` 6/6 · `test-admin-test-call-20260731.cjs` 10/10 · `test-webhook-security-20260731.cjs` 10/10 · gate P0 OK. Además: Sarah te puede llamar (`/admin/test-call`) y los webhooks son fail-closed en producción.

## PENDIENTE #1 (raíz aún abierta, prioridad alta): ¿el callId es estable?
Todo lo demás cuelga de esto. Hay que **mirar los logs de Railway** una línea `[EL] turn | callId=…`:
- Si es **`conv_...`** → estable. Entonces se puede REFACTORIZAR la deuda: quitar los parches de re-derivación por historial (`phoneFromHistory`, anti-repeat `yaDicho` regex en `marta-llm.service.js`) y pasarlos a **flags de sesión limpios** (`greeted`, `allergyMentioned`, `addressConfirmed`, `upsellOffered`, `farewellArmed`). Menos frágil, menos tokens.
- Si sigue **`el-...`** → la cabecera `X-ElevenLabs-Conversation-Id = {{system__conversation_id}}` no está llegando. Rematar en el panel de ElevenLabs (Custom LLM → Request headers → tipo "Variable" → `system__conversation_id`) y re-publicar. Ojo: al publicar, verificar que **Backup LLM sigue en "Disabled"** (se ha colado a Custom otras veces y mete fillers en inglés + latencia).

## PENDIENTE #2 (verificación de la llamada de prueba del end_call)
Confirmar en llamada real que Sarah CUELGA al despedirse. Si no cuelga:
- Revisar que el system tool **"End Call"** esté activo en Sarah (ElevenLabs → agente Sarah → Tools). Viene por defecto en agentes de dashboard.
- Si habla la despedida pero no cuelga, o cuelga sin hablar: mover la despedida al parámetro `message` de `end_call` (ajuste de 1 línea en `sendStreamResponseWithEndCall`, `elevenlabs-llm.routes.js`).

## PENDIENTE #3 (latencia) — MEDIO HECHO ✅, falta verificar en vivo
**Hecho (`c93f4db`, desplegado):** el prompt caching de OpenAI **no se activaba nunca**. Medido: el prefijo estable eran **69 tokens** (mínimo de OpenAI para cachear: 1024), porque `${perfilBloque}` estaba en la línea 3 y `${horarioLinea}` —con "Ahora son las HH:MM"— a ~3.500 tokens del inicio, con la carta entera (~9k tokens) detrás. Fix: **cola dinámica al final** (horario + cliente recurrente), `prompt_cache_key` y log `in=/cached=/out=`. Prefijo estable ahora **11.206 tokens** (99,5% del prompt).
- ⚠️ **Regla nueva: nada dinámico (hora, perfil, estado) por encima de la carta.** `test-prompt-cache-20260731.cjs` falla si alguien lo reintroduce.
- **Falta:** confirmar `cached≈11000` en los logs de Railway (tabla de arriba).

**Palanca restante:** adelgazar la carta que se embebe (`buildMenuText()`, ~9k tokens). Con la caché puesta ya no urge por coste, pero sigue pesando en el primer turno. Requiere test + OK del owner.

## Deuda técnica conocida (no urgente)
- Tests cubren contrato del prompt y código determinista, NO ejecutan el LLM en vivo → que Sarah OBEDEZCA se valida en llamada real.
- `validateOrder` es gate P0 fail-closed (OK), pero mono-tenant `la-locanda` hardcodeado en varios sitios.
- `/kitchen/ack` sin auth extra; PII en logs y en `orders_fallback/`. Monitor de ACK en memoria (se pierde al reiniciar).
- `simulator.js` usa el motor legacy `processTurn`, NO el cerebro → no refleja producción. No copiar de ahí.
- ~~Warning `geometric-repack ... File exists` en cada commit~~ → **RESUELTO 31-07**: era un `.pack` huérfano; borrado + `git gc --prune=now` + `git fsck` limpio.
- Higiene .git: los `.env` tienen mensajes de "vestauth/inject env" al correr node — es una lib de terceros en el entorno del owner, no del proyecto.

## Comandos útiles (desde `…\vozra-orders\backend`)
```
node --check marta-llm.service.js
node --check elevenlabs-llm.routes.js
node test-pid-fixes-20260728.cjs
node test-allergy-remove-20260730.cjs
node test-end-call-20260731.cjs
node test-prompt-cache-20260731.cjs
node test-submit-order-validation-gate.cjs
git add <ficheros> && git commit -m "..." && git push origin main   # Railway auto-despliega
curl -s https://vozra-orders-production.up.railway.app/health        # commit realmente desplegado
```

## Datos de prueba en Supabase
Cliente registrado de test: teléfono **`634425921`** (Samuel Tineo), `restrictions.allergies` se usa para probar el borrado de alergia en vivo. Schema `vozra_orders`, tabla `customers`.

---

## CONTEXTO GENERAL (para que un chat nuevo entienda el proyecto sin repreguntar)

**Qué es Vozra PID.** Agente de voz ("Sarah") que atiende el teléfono de la pizzería **La Locanda de Cancelada (Málaga)**, toma la comanda hablando en español, y la dispara a cocina por Telegram (fallback Discord→fichero). En producción, de verdad, recibiendo llamadas. Un SOLO cerebro (Sarah); no hay segundo agente.

**Cómo está montado (flujo de un turno):** ElevenLabs Conversational AI → Custom LLM → nuestro backend `POST /v1/chat/completions` (SSE, en `elevenlabs-llm.routes.js`) → `generateMartaReply()` (el cerebro, `marta-llm.service.js`) → OpenAI `gpt-4.1-mini` con tool-calling → respuesta en streaming SSE que ElevenLabs convierte a voz. El backend corre en Railway (auto-deploy desde `main`). Persistencia en Supabase (`vozra_orders`).

**Filosofía del owner (sam), innegociable:** "arreglamos LÓGICA, no parches". La autorización de cualquier acción crítica debe ser CÓDIGO DETERMINISTA, nunca "confiar en que el LLM se acuerde". Cada vez que un fallo se puede resolver en código (no en el prompt), se hace en código. El owner prueba TODO con llamadas reales y trae los transcripts; los tests automáticos no ejecutan el LLM, solo prueban que la regla/el código determinista existen.

**Cómo trabaja este dúo:** yo edito los ficheros del backend en `D:\…\vozra-orders\backend`. **ACTUALIZADO 31-07: con Desktop Commander SÍ llego al disco `D:` y puedo ejecutar yo mismo** `node --check`, los tests, `git commit/push` y `curl /health` — no hace falta que el owner pegue salidas (aunque puede). Ojo: el shell del sandbox de Claude **no** llega a `D:`; el runner válido es Desktop Commander, y en Windows hay que usar **`cmd`** (PowerShell bloquea `npm` por ExecutionPolicy) y evitar `head`/`timeout` (no existen; usar `findstr` / `ping -n`). Git root está en `backend/.git`. Respondo en español, directo, con pasos numerados y comandos listos para copiar.

**Distinción importante de nombres:** "Sarah" = agente PID de la pizzería (este proyecto). "SARA AI" = agente de Roomy Food (hotel room service), que vive en `../roomy-food` con su propia memoria. No confundir.

---

## CONTEXTO DE LA ÚLTIMA SESIÓN (2026-07-31) — el porqué de cada decisión

Veníamos arrastrando 3 días de frustración del owner porque "Sarah sigue pidiendo los datos que ya tiene" y "no borra la alergia". La causa raíz (descubierta el 30-07) es que el **callId era inestable**: ElevenLabs no mandaba el conversation id, `extractCallId` caía a `el-${Date.now()}` → sesión nueva cada turno → se perdía todo el estado. Se parcheó re-derivando el reconocimiento del historial en cada turno (`phoneFromHistory` + `loadProfileCached`) y se añadió la cabecera `X-ElevenLabs-Conversation-Id={{system__conversation_id}}` en ElevenLabs.

Esta sesión resolvió tres cosas encima de eso:

1. **Borrar alergia (queja: "le digo que quite el marisco y sigue avisando de langostinos en la Abruzzo").** El `removed_allergies` de submit_order solo actuaba al final del pedido, y la alergia guardada se re-inyectaba desde la sesión en cada turno. Decisión: herramienta DEDICADA y determinista `eliminar_alergia_guardada` — en cuanto el cliente dice "quítala", el código borra la alergia de Supabase Y de la sesión en el acto, e inyecta una directiva "ALERGIA ELIMINADA, no la menciones". Deja de avisar en el MISMO turno.

2. **BUG CRÍTICO del backtick (esto explica por qué "nada funcionaba pese a desplegar").** El lote de suplementos del 30-07 dejó, dentro del prompt —que es un template literal con backticks—, las palabras `` `aviso_suplementos` `` y `` `suplementos` `` entre backticks. Eso cerraba la cadena a la mitad → `SyntaxError` → el módulo entero NO cargaba. El commit `4d44956` se desplegó ROTO: el backend no arrancaba y las llamadas fallaban enteras. Se detectó porque el owner corrió `node --check` y saltó el error en la línea 381. Fix en `002a590`. **Lección grabada: nunca backticks dentro del prompt.**

3. **Colgar al despedirse (petición nueva del owner en la última llamada, que salió BIEN: reconoció a Samuel, confirmó la calle sin cantar el número, no re-pidió datos, no mencionó la alergia).** Pidió: "cuando el agente confirma y se despide, el cliente se despide y el agente dice ciao y cuelga". En Custom LLM colgar lo hace ElevenLabs con su system tool `end_call`; investigué la doc oficial y confirmé que el LLM debe emitir el `tool_call` y ElevenLabs lo intercepta. Como el backend NO reenvía tokens de OpenAI (arma la respuesta él mismo), lo monté DETERMINISTA en el route: al despachar se arma `farewellArmed`; al turno siguiente, si el cliente se despide (`isFarewell`, que ignora "añade/quita/espera"), el backend responde una despedida corta con el nombre y emite el chunk `tool_calls:[{name:"end_call"}]`. Bonus: eso mata el doble "queda confirmado" que se veía al final (ese turno ya no pasa por el LLM). Detalle de test: falló `adiós` porque el acento va en la `o` (`adi[oó]s`, no `ad[ií]os`).

**Tono y estado emocional del owner:** venía quemado ("llevo 3 días con esta mierda", "por qué cojones sigue preguntando"). Lo que le dio la vuelta fue el WIN real en llamada + encontrar el bug del backtick que explicaba la frustración. Cerramos la sesión con todo verde y desplegado, y con él pidiendo dejar la memoria lista para continuar en otro chat sin perder el hilo.

**Lo único que queda por VERIFICAR de esta sesión (no está confirmado en vivo):** que el `end_call` efectivamente cuelga (depende de que "End Call" esté activo en Sarah) y que el `callId` ya llega estable en los logs de Railway. Ambos están en los pendientes de arriba.

---

## CONTEXTO DE LA SESIÓN DEL 31-07 POR LA TARDE — caché de prompt

Sesión corta y quirúrgica, sin el owner delante: arranqué verificando (checks + los 4 tests + `/health`), encontré 3 tests de suplementos sin commitear y los subí, y fui a por el **PENDIENTE #3 (latencia)**, el único de los tres que no depende de una llamada real.

**La lección de la sesión: medir antes de optimizar.** "Activar prompt caching" sonaba a tocar un flag. Al medirlo se vio que la caché de OpenAI **es automática pero por prefijo exacto y solo desde 1024 tokens**, y que nuestro prefijo estable eran **69 tokens** — es decir, llevábamos meses pagando y esperando los ~11k tokens completos en cada turno. La culpa no era del tamaño del prompt sino del **orden**: la hora ("Ahora son las 14:37") y el bloque de cliente recurrente estaban ARRIBA, con la carta entera detrás. Mover lo dinámico al final es un cambio de cero riesgo semántico (no se tocó ni una palabra del contenido) que además **mejora la adherencia por recencia** — justo la palanca que ya usábamos con las directivas inyectadas.

**Encaja con la filosofía del owner:** no es un parche de prompt, es estructura. Y para que nadie lo rompa sin enterarse, el invariante quedó blindado en `test-prompt-cache-20260731.cjs` y el resultado es observable en los logs (`cached=`), no una promesa.
