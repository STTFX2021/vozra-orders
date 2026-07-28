# SESSION_LOG — Vozra PID

> Append-only. La más reciente arriba. (Solo Vozra PID; el historial de Roomy está en `../roomy-food`.)

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
