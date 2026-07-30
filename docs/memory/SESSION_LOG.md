# SESSION_LOG — Vozra PID

> Append-only. La más reciente arriba. (Solo Vozra PID; el historial de Roomy está en `../roomy-food`.)

---

## 2026-07-30 — RAÍZ REAL del "pide datos que ya tiene": la SESIÓN se pierde cada turno (callId inestable)

**Esto es lo que explica por qué NADA de lo anterior funcionaba en llamada real.** `extractCallId` (elevenlabs-llm.routes.js) cae al fallback `el-${Date.now()}` cuando ElevenLabs no manda el conversation id → **callId NUEVO en cada turno → sesión nueva cada turno → `registeredName`/`registeredAddress`/`registeredRestrictions` (y upsellOffered) se BORRAN entre turnos.** En los logs de Railway se ve: `callId=el-1785172696543` (el fallback). Por eso saluda "Aquí estás, Juan" (en ese turno acababa de leer el teléfono) pero al confirmar ya no se acuerda y pide los datos. Todos mis fixes guardaban en esa sesión efímera → inútiles en vivo.

**Fix (no depende del callId):** el reconocimiento se RE-DERIVA en CADA turno del teléfono dicho en el historial completo.
- `phoneFromHistory(incomingMessages)`: busca un teléfono (9-15 dígitos) en CUALQUIER turno de usuario, no solo el último.
- `loadProfileCached(tel)`: carga el perfil con caché de 120s (evita golpear la BD cada frase).
- La precarga usa ambos y re-aplica `registeredName/Address/Restrictions` aunque la sesión sea nueva.
- Tests F9. Sandbox 4/4.

**Deuda relacionada (pendiente):** con callId inestable, `call_logs` tendría UNA fila por turno (no por llamada), y el dedup por callId es débil. Lo ideal es estabilizar el callId (que ElevenLabs mande el conversation id, o derivarlo). Anotado para después; NO bloquea el fix del reconocimiento.

---

## 2026-07-30 — RAÍZ (parcial) del "pide datos que ya tiene": customer_name era REQUIRED en la tool

El backfill (95f6aa9) rellenaba el nombre en submit, pero el modelo SEGUÍA preguntándolo porque **`customer_name` estaba en el `required` del esquema de `submit_order`** → el LLM se veía obligado a tenerlo antes de poder llamar la tool, así que lo pedía aunque le dijéramos que no. Fix definitivo (4 capas):
1. Quitado `customer_name` de `required` (`["items","order_type","phone"]`).
2. Descripción de `customer_name`: "si es registrado, OMÍTELO; el sistema usa el guardado".
3. Prompt (paso 3): "si el cliente está registrado, NO pidas nombre ni dirección; el sistema los rellena".
4. Backfill de nombre+dirección desde la sesión (ya en 95f6aa9).
El validador SIGUE exigiendo nombre a cliente NUEVO (gate P0 intacto). Verificado: ningún test asume customer_name required.

---

## 2026-07-30 — Guardado de conversaciones en Supabase (call_logs)

**Hallazgo:** las conversaciones NO se guardaban. `call_logs` (tabla ya existente, buen esquema: conversation_id UNIQUE, transcript jsonb, order_id, caller_phone, analysis, raw…) estaba **vacía** — nada escribía en ella. Solo se guardaban pedidos (`orders`, 60 filas) y perfiles (`customers`). Los transcripts que veíamos venían de **ElevenLabs** (su panel), no de Supabase.

**Implementado:**
- `supabase-store.js`: nuevo `upsertCallLog({conversationId, callerPhone, callStatus, orderCaptured, transcript})` — upsert por `conversation_id` (merge-duplicates), no-op si Supabase off, no lanza. `order_captured` solo se escribe true (nunca desmarca).
- `elevenlabs-llm.routes.js`: tras `generateMartaReply`, fire-and-forget que guarda el transcript acumulado (historial + respuesta del turno). NO bloquea la voz. El último turno deja la conversación completa.
- Verificado contra Supabase real: insert + upsert por conversation_id OK (fila de prueba insertada y borrada).
- ⚠️ GDPR: `call_logs` guarda datos personales; retención/borrado (DELETE por conversation_id) responsabilidad del restaurante. Anotado en el código.

**Confirmado además:** el fix de "pedir datos que ya tiene" (nombre+dirección desde el perfil) está desplegado en `95f6aa9`.

---

## 2026-07-30 — DESPLEGADO + 3 bugs de la 1ª llamada real post-deploy

**Deploy:** commit `ae1cf7e` ("feat(pid): pizza mitad y mitad…") **ACTIVE/Online en Railway** (verificado en el panel; el del 26/07 `2bc9448` pasó a Removed). Producción al día.

**Wins confirmados en llamada real:** "Aquí estás, Samuel. ¿Te lo llevo a Calle Alpandeire, la de siempre?" (calle sí, número no), "te tengo apuntada la alergia a marisco" (alergia del perfil), Abruzzo sin langostinos sin bloquear ni "Oye".

**3 bugs detectados y arreglados (sin desplegar aún):**
- **A (GRAVE): cliente registrado fallaba "falta algún dato".** RAÍZ GENERAL: para un registrado el código NO rellenaba nombre ni dirección desde el perfil — dependía de que el LLM los repitiera en submit_order, y al decirle "ya los tienes, no los pidas", a veces NO los pasaba → llegaban vacíos → validador falla. Se vio con la DIRECCIÓN (llamada de Samuel) y con el NOMBRE (llamada de Juan). Fix determinista en `handleSubmitOrder`:
  · Dirección: helper `resolveDeliveryAddress(argAddr, savedAddr)` — usa la del modelo si trae número, si no la GUARDADA (completa) del perfil y extrae el número para el gate. Exportado + tests F8.
  · Nombre: `_custName = realCustomerName(args.customer_name) || realCustomerName(_sess.registeredName)` — si el modelo no lo repite, usa el guardado. Usado en el patch y en la despedida.
- **B: pidió consentimiento a cliente registrado.** Diagnóstico: efecto secundario de A (al fallar el pedido, el modelo regresó al flujo de cliente nuevo). `stripConsentIfRegistered` + save_profile_consent=false siguen puestos. A re-testear tras desplegar A; si reaparece, instrumentar con logs.
- **C: "una Coca-Cola para cada pizza" dio 2 en vez de 3.** El STT oyó "para cada piso". Fix: `hasPerPizzaQuantityIntent` acepta "piso" (variante STT de pizza); `resolvePerPizzaQuantities` cuenta las mitad-y-mitad como pizza. Test F8.

Sandbox: dirección + per-pizza 7/7 OK. Pendiente: npm test + commit + push (auto-deploy).

---

## 2026-07-28 — Pizza mitad y mitad + revisión de los 8 tests "Skipped"

**Los 8 skipped de fase4, revisados (no todos valían):**
- TEST-019→024 (6): dispatch fallback + ACK timeout. **YA cubiertos** en test-orders-fase5 (dispatch Telegram→Discord→file) y fase6 (ACK). Eran stubs viejos. Actualizado el motivo del skip a "YA cubierto en fase5/6". No se rehacen (duplicado).
- TEST-014: transferencia por catering. Niche, no construido (no es prioridad de un order-taker).
- TEST-007 (mitad y mitad): **IMPLEMENTADO** (era el único real).

**Feature mitad y mitad (decisión owner: se cobra la MÁS CARA):**
- `SUBMIT_ORDER_TOOL`: campo nuevo `half_and_half` en el item (2 ids/nombres).
- `mapToolItem`: resuelve las dos mitades, `price = Math.max(a,b)`, `id="half_and_half"`, displayName "Pizza mitad X / mitad Y", guarda `halfAndHalf`.
- `estimateTotal` (order-validator): rama que usa `item.price` para half_and_half (id sintético no está en carta).
- `crossCheckAllergens`: suma los alérgenos de LAS DOS mitades (seguridad).
- Prompt: regla de mitad y mitad (precio = la más cara, lo da calcular_total, solo dos mitades).
- Tests F7 (precio = más cara + cruce de alergias de ambas mitades); sandbox 5/5 OK. fase4 TEST-007 sigue skip pero con motivo actualizado (el motor legacy no se toca; la feature vive en el camino real).

⚠️ Motor legacy (`order-slot-filler`/fase4 `sim`) NO es producción; no se implementa nada ahí.

---

## 2026-07-28 — Perfil con preferencias/restricciones (alergias guardadas) + test contrato

**Feature nueva (pedida en llamada real: "lo tenías que tener apuntado en la base de datos"):**
- **Supabase:** migración `add_restrictions_to_customers` → columna `restrictions jsonb` (default `{"allergies":[],"preferences":[]}`) en `vozra_orders.customers`. Aplicada.
- **`customer-store.js`:** `parseRestrictions` + `mergeRestrictions` (unión sin duplicados, case-insensitive). `getCustomerByPhone` devuelve `restrictions`. `upsertCustomer` acumula restricciones (lee+merge) y ahora **solo escribe nombre/dirección si vienen** (no los borra al actualizar solo alergias).
- **`marta-llm.service.js`:** `buscar_cliente`/`computeLookup` devuelven `alergias_guardadas`/`preferencias_guardadas`; precarga y rama de buscar_cliente las guardan en sesión (`registeredRestrictions`); al reconocer al cliente se inyecta directiva ("te tengo apuntada la alergia a X, no se la preguntes"); `handleSubmitOrder` **une alergias guardadas + declaradas** (determinista → siempre al ticket) y las persiste (cliente nuevo con consent, o cliente ya registrado que declara una nueva).
- **Seed:** perfil `634425921` (Samuel Tineo) → `restrictions.allergies=["marisco"]`.
- Tests F6 (parse/merge) + sandbox 6/6 OK.
- ⚠️ Recordatorio: el fix de "alergia no bloquea" (`order-validator.service.js` + `test-submit-order-validation-gate.cjs`) quedó SIN commitear en el commit `408ca51`. Va en el commit de cierre junto con esto.

---

## 2026-07-28 — LAS ALERGIAS YA NO BLOQUEAN (bug real en el validador) + regla madre

Llamada real detectó el bloqueo: Sarah decía "quitar un ingrediente no garantiza... contaminación cruzada... necesito que el equipo lo revise antes de confirmar" y NO enviaba el pedido. **La causa NO era el prompt: era CÓDIGO.**
- `order-validator.service.js` empujaba un error bloqueante `ALLERGEN_REVIEW_REQUIRED` → `validation.ok=false` → `handleSubmitOrder` retenía el pedido y devolvía el mensaje de contaminación (L837).
- **Fix:** ese error pasa a **aviso no bloqueante `ALLERGEN_NOTED`**. La alergia se sigue anotando (flag `requiresKitchenReview`/`allergyRisk` → ticket de cocina "! ALERGIA" + bloque foodSafety) pero **NUNCA bloquea**. Verificado: esos flags solo alimentan el ticket, ningún otro punto bloquea.
- Mensaje muerto de "contaminación cruzada" eliminado del cerebro.
- Prompt: **REGLA MADRE "Vozra PID SOLO TOMA PEDIDOS"** — nunca bloquea/rechaza/retiene por alergia; solo anota y, como mucho, sugiere quitar el ingrediente o recomendar otro plato; si el cliente quiere el plato igual, se lo toma y lo anota.
- Tests actualizados: `test-submit-order-validation-gate.cjs` (sección de alergia reescrita: ahora aserta que NO bloquea, warning ALLERGEN_NOTED, sin error); +test F1 "PID nunca bloquea". `test-orders-fase4.cjs` intacto (solo comprueba flags, que se mantienen).

**Pendiente (feature nueva, pedida por el owner):** guardar en el perfil del cliente (tabla `customers`) sus **preferencias y restricciones/alergias**, para que al reconocerlo ya las tengamos. Requiere columna nueva en Supabase (migración) + código en customer-store/marta-llm. NO ejecutado — propuesto, a la espera de OK del owner para tocar el esquema.

---

## 2026-07-28 — Correcciones pre-commit (ontología fuera + flujo de reconocimiento)

- **Ontología: eliminada y luego DEVUELTA con datos** (el owner aclaró que es primordial). Ya NO es un esqueleto vacío: `allergen-ontology.service.js` es un **clasificador determinista por reglas** que lee los parámetros de la taxonomía (categoría + alérgeno + descripción) y decide retirable/intrínseco para los 79 platos, con una capa `OVERRIDES` (vacía) para datos validados por restaurante. Reglas: gluten/huevo/lácteo=intrínseco siempre; marisco=retirable en pizza, intrínseco en pasta/risotto; frutos secos=intrínseco en pesto, retirable por encima; pescado=intrínseco en césar/plato de pescado. `formatItemAllergens` anota SOLO los retirables en la carta con "(se puede quitar)" (mínimo peso en prompt); el prompt manda hacer caso a esa marca. ⚠️ Reglas v1 inferidas — validar OVERRIDES con el restaurante antes de piloto real. Tests: 7 nuevos (reglas + datos reales del menú), verde en sandbox 9/9.
- **Upselling a estado de sesión:** flag `upsellOffered` en la sesión (arranca false, true en la 1ª oferta, bloquea la 2ª). El barrido de historial queda como respaldo.
- **Tests de consentimiento** por los dos caminos (caller ID precargado y teléfono dictado) + negativo. Exportado `stripConsentIfRegistered`.
- **FLUJO DE RECONOCIMIENTO CORREGIDO (fallo detectado por el owner):** el código NO nombraba la calle. Un commit posterior a `74e4243` apagó el nombrado y dejó `streetOnly` huérfana, con el prompt diciendo "NUNCA verbalices la calle" en 4 sitios. Reconectado: `registeredCustomerDirective` + perfilBloque + PASO C + PRECIOS ahora → saluda "Aquí estás, [nombre]." y confirma SOLO la calle (primera línea, vía `streetOnly`): "¿Te lo llevo a Calle Alpandeire, la de siempre?", nunca número/piso/portal. `streetOnly` pulida (no deja "nº" colgando). +3 tests F5. Verificado en sandbox: OK.
- `test-pid-fixes-20260728.cjs` añadido a `npm test`.
- **Sandbox ejecutado (real):** upsell + consent (2 caminos) 9/9 OK; streetOnly 8 formatos OK; directiva de reconocimiento 4/4 checks OK. `node --check`/`npm test`/git → pendientes de correr por el owner (mi shell no alcanza D:).

---

## 2026-07-28 — Fusión con el otro chat + reconciliación de estado

Se importó el volcado del otro chat ("Actualización del proyecto", nomenclatura de parches 0012–0015). **Su estado de git/deploy estaba DESACTUALIZADO**; reconciliado contra la verdad (git log + Railway) de esta sesión:
- El otro chat daba el parche **0015 `stripConsentIfRegistered` como "pendiente de push, sin confirmar"**. FALSO a día de hoy: **es el commit `2bc9448`, es `origin/main`, y está DESPLEGADO en Railway (Active desde 26-jul).** El fix de consentimiento YA está en producción.
- El otro chat creía HEAD = `64511ab` (0014). Realidad: HEAD local = `171dadb` = `2bc9448` +5 commits. Su foto era anterior al push de 0015 y a esos 5 commits.
- Mapa parche→commit consolidado en KEY_FACTS.

Info nueva y útil incorporada a PROJECT_STATE/KEY_FACTS: panel ElevenLabs (Backup LLM **Disabled** = causa de fillers ingleses; model id `vozra-marta-orders`; Speed 1.03; solo Español), **conflicto de voz Aitana vs Cristina (a verificar en panel)**, auditoría 2026-07-17 (riesgo S6), capacidad de llamada saliente Twilio.

**Archivos esparcidos detectados** (lo que preocupaba al owner): carpeta fuera del repo `C:\Users\Orochika\Claude\Projects\04_Vozra_Orders\` con parches PID históricos + copia de `marta-llm.service.js` + ficheros de ROOMY mezclados (`THE_MARKET_menu-taxonomy.v1.json`, `PROMPT_SARA_room_service_v1.md` → mover a `../roomy-food`). Anotado en PROJECT_STATE §8 para limpieza.

Nombres aclarados: producto = **Vozra PID**; `vozra-orders` = identificador técnico (no renombrar). "Sarah" = PID; "SARA AI" = Roomy.

---

## 2026-07-28 — Cierre de 4 fallos reales de PID (sin commit/deploy aún)

**Base:** `main` @ `171dadb`, working tree limpio. (El fix branch del 20-07 con `cleanCustomerName` quedó huérfano; `main` ya resuelve "¡Cliente!" con `realCustomerName`, L157. No mezclar.)

**Auditoría antes de tocar:** el `main` real estaba MÁS avanzado que la memoria — ya tenía `stripConsentIfRegistered`, `registeredCustomerDirective`, precarga de teléfono, `resolvePerPizzaQuantities`, `realCustomerName`. Faults 5/6/7 ya estaban hechos; 3 casi.

**4 fixes aplicados en `marta-llm.service.js` + 1 módulo nuevo:**
1. **Alergia (F1):** fuera el ejemplo literal `"Oye, la Carbonara…"` (era la causa del "Oye"). Sección reescrita: no empezar con "Oye", no repetir lo que el cliente declara, rama RETIRABLE (topping→ofrecer quitar, ej. Abruzzo/langostinos) vs INTRÍNSECO (masa/salsa→recomendar alternativa), y deducir si la carta no marca el dato. Se anota siempre en kitchenNote. **NO se auto-confirma seguro.**
   - Nuevo `allergen-ontology.service.js`: enganche `classifyAllergen(itemId, allergen)` + `hasOntologyData()`. **Ontología VACÍA a propósito** (`ONTOLOGY = {}`). Cuando haya datos por restaurante, `formatItemAllergens` los añade a la carta (retirable/intrínseco) y Sarah deja de deducir. Decisión del usuario: montar el enganche sin la info.
2. **Upsell (F2):** `upsellAlreadyOffered(historial)` calcula del historial si ya se ofreció; si sí, inyecta orden dura "PROHIBIDO volver a ofrecer" cada turno. Determinista, no depende de la memoria del LLM. Exportado para test.
3. **Consentimiento (F3):** en `handleSubmitOrder`, si `_sess.registeredName` → `save_profile_consent=false` forzado por código (complementa a `stripConsentIfRegistered`).
4. **Tiempos (F4):** confirmado que NO existe fuente de ETA. Reescrito paso 4 del flujo: prohibido inventar minutos/hora; copy aprobado "El restaurante te confirmará el tiempo estimado"; se conserva solo el aviso de cocina cerrada (dato real).

**Tests:** nuevo `test-pid-fixes-20260728.cjs` (18, todos verdes). Baseline completo verde: 20+6+10+5. `node --check` OK en ambos ficheros. Lógica determinista (upsell, ontología) validada en sandbox aparte.

**Latencia (medida):** system prompt = **42.685 chars ≈ 10.671 tokens por turno**. 1 llamada/turno normal, tools en paralelo, precarga ya puestas. Única palanca restante: recortar la carta del prompt (NO tocado, requiere test + OK).

**⚠️ SIN COMMIT / SIN PUSH / SIN DEPLOY.** Autorización técnica dada; el usuario decide el gatillo.
- Commit propuesto: `git add marta-llm.service.js allergen-ontology.service.js test-pid-fixes-20260728.cjs`
- **Railway sin confirmar:** `origin/main` = `2bc9448`; `main` local +5 (con el commit de hoy, +6). Si Railway sirve `origin/main`, NINGÚN fix (ni hoy ni los 5 previos) está en producción. Paso de impacto: confirmar commit desplegado → push → deploy → **llamada de prueba real**.

**Verificación en llamada real pendiente:** que Sarah OBEDEZCA (no "Oye", ofrecer quitar langostinos, no repetir upsell, no inventar hora) solo se confirma tras desplegar.

---

## 2026-07-20 — Fix: nombres genéricos + dirección en RECOGER

**Transcript del fallo (llamada real, pedido para RECOGER):**
`"Right...". Cliente! ¿Quieres que lo deje a nombre de cliente para recoger? ¿Y confirmas que vienes a recogerlo a Calle Alpandeire 3...?"`

**4 fallos, diagnosticados con evidencia ejecutada:**

1. **`"Right..."` → NO era del código.** Ejecuté `sanitizeReply` contra la cadena exacta: la limpia en las 3 variantes, y se aplica en las dos salidas (líneas 964/981). **Causa: Railway sirviendo un build viejo.** Nada que arreglar en código; hay que verificar el hash desplegado (puede haber más fixes del 18-07 sin aplicar).
2. **`"¡Cliente!"` → fallo nuestro, cadena completa confirmada en Supabase** (`634425921` tenía `name = "cliente"`, `order_count 0`):
   - `submit_order` declaraba `customer_name` como **required y sin description** → el modelo estaba obligado a inventar un genérico.
   - `handleSubmitOrder` lo persistía sin filtrar.
   - `computeLookup` lo devolvía sin filtrar → el prompt dice "salúdale por su nombre" → "¡Cliente!".
3. **Confirmaba la dirección de casa en un pedido para RECOGER → el más grave.** El prompt enseñaba "confírmale la dirección guardada" (PASO C, domicilio) y no lo prohibía en recoger. Absurdo: en recoger el cliente viene AL LOCAL.
4. **"para buscar tu perfil"** → verbalizaba la mecánica interna.

**Aplicado** (rama `fix/pid-nombre-generico-y-recoger-20260720`, commit `353a990`, 1 fichero, +32/-7):
- Helper `cleanCustomerName()` + regex `NOMBRE_GENERICO` en `marta-llm.service.js`, aplicado en los TRES puntos: lectura (`computeLookup`), escritura (`upsertCustomer`) y despedida (que tenía su propio regex más pobre, solo 3 palabras).
- `customer_name` FUERA de `required` + `description` que prohíbe inventarlo. **Esta era la raíz.**
- Prompt: 4 reglas nuevas en el flujo, la clave **"LA DIRECCIÓN NO EXISTE EN RECOGER"** (regla absoluta, con el porqué), + no verbalizar mecánica + no inventar nombres.
- Supabase: `update customers set name = null` sobre genéricos → 1 registro limpiado.

**Defensa en dos capas:** aunque el modelo ignore el prompt, el código tapa el agujero.

**Verificación:** `node --check` OK. Tests 20+6+10+2 verdes, 0 fallos.
⚠️ **Estos tests NO prueban el fix** — cubren motor legacy, dispatch y ACK, no `generateMartaReply` ni el prompt. Solo demuestran no-regresión. **La prueba real es una llamada tras desplegar.**

**Estado de ramas:** el trabajo de Roomy B2 quedó en `git stash` ("wip-b2") sobre `work/roomy-b2-domain-tenant-registry-20260719`. Recuperarlo con `git stash pop` tras volver a esa rama.

---

## 2026-07-18 — Fixes de voz/flujo + separación de Roomy

**Qué se hizo (PID):**
- Corregido el ORDEN de datos en domicilio: primero teléfono → buscar_cliente → confirmar dirección si registrado (no re-pedirla) → si nuevo, pedir dirección.
- Eliminados TODOS los puntos suspensivos del prompt y del texto de salida (causaban ruidos en TTS). La regla de leer teléfonos usaba "..." como pausa.
- Saneador ampliado con "Duly noted" y más muletillas en inglés.
- (Sesión previa) desambiguación de platos, no recitar ingredientes, hora concreta, candado de alérgenos, zona de reparto, pago, promos, incidencias.

**Separación:**
- Roomy Food movido a su propio proyecto `../roomy-food`. Este proyecto queda solo para PID.

**Pendiente al cerrar:**
- ⏳ Confirmar que los fixes están desplegados en Railway (no build viejo).
- Opcional: endurecer invariantes en código, cerrar endpoints, tests del camino real.

---

## 2026-07-19 — Hallazgo del simulador + fallo pendiente de afinar

- **`simulator.js` usa el motor LEGACY** (`order-slot-filler.service.js` / `processTurn`), NO el cerebro LLM. Evidencia: repite "¿Algo más o con eso te vale?" ante cualquier entrada y no entiende preguntas ("el que?", "como?"). **El simulador no refleja lo que oye un cliente real** (producción usa `generateMartaReply`).
- Consecuencia: el simulador NO vale como criterio de no-regresión. Usar los tests del camino real.
- **Pendiente:** el usuario quiere afinar un fallo de PID. Falta que concrete si lo vio en el simulador (→ bucle del motor legacy) o en una llamada real (→ cerebro LLM). Ver NEXT_SESSION.
- PID en `main` sin cambios esta sesión (todo el trabajo de B2 fue en la rama de Roomy).

---
<!-- NUEVAS ENTRADAS DEBAJO, la más reciente ARRIBA -->
