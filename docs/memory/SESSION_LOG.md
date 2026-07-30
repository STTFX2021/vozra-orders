# SESSION_LOG — Vozra PID

> Append-only. La más reciente arriba. (Solo Vozra PID; el historial de Roomy está en `../roomy-food`.)

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
