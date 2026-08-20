# Inventario de reglas: qué está en runtime y qué cuelga del prompt

> Vozra PID · agente Sarah · 2026-08-18
> Hecho sobre el código real en `main` (commit `7bf3f4d`), no sobre documentación.

---

## 1. La prueba de por qué los fallos vuelven

No hace falta teorizar. Está en el historial de git:

| Fecha | Commit | Qué pasó |
|---|---|---|
| 24-jun | `1de43df` | Se añade **`detectLang`**: detección de idioma **determinista, en código**. Inyectaba "IDIOMA OBLIGATORIO: responde en X" en cada turno. |
| 28-jun | `bd11a80` | *"fix: make brain the single system prompt source"* — **borra `detectLang`**. La regla vuelve a depender del prompt. |
| 28-jun | `f86d83f` | Se añade un test: *"lock Spanish default for ambiguous foreign tokens"*. **Comprueba que el modelo recibe un solo system prompt**, no que el idioma se respete. |

Resultado: la garantía desapareció, la suite se quedó **verde**, y nadie se enteró. Entró por el **PR #1**, fusionado.

Ese es el mecanismo completo, en tres commits y cuatro días. No es un caso aislado: es el patrón.

**Hoy `detectLang` no existe en el código.** El idioma depende enteramente de que `gpt-4.1-mini` obedezca un párrafo del prompt.

---

## 2. Estado real, regla por regla

### Ya está en runtime (no puede fallar)

Existen **14 gates deterministas** (`requiredAction`) más el guardián de salida:

| Regla | Mecanismo |
|---|---|
| No pedir lo que ya se sabe (tipo, teléfono, nombre, dirección) | `resolverDeSesion` |
| Tipo de pedido válido antes de calcular | `resolve_order_type` |
| Total obligatorio antes de confirmar | `present_current_summary` + `formatEurosSpoken` |
| Upsell exactamente una vez | `offer_upsell` / `deterministicUpsellOffer` |
| Suplementos avisados y aceptados | `obtain_surcharge_acceptance` |
| Confirmación explícita contra el resumen entregado | `confirmationMatchesDeliveredSummary` |
| Plato fuera de carta | `validateItems` / `resolve_invalid_product` |
| Alergia: advertir sin bloquear | `allergenAdvisory` |
| Quitar ingrediente ≠ borrar la ficha | `detectRemovedAllergies` |
| No repetir una pregunta ya contestada | `guardianDeSalida` + `intencionYaCubierta` |
| No pedir consentimiento a un registrado | `stripConsentIfRegistered` |
| Importes inventados por el modelo | `guardianDeSalida` + `importeHablado` |
| Puntos suspensivos y muletillas | `sanitizeReply` |
| Dirección: solo el nombre de la calle | `streetOnly` |

Esta capa **funciona**. Nada de lo que hay aquí ha vuelto a romperse.

### Cuelga solo del prompt (el modelo decide si obedece)

| Regla | Impacto | Riesgo |
|---|---|---|
| **Idioma y anti-rebote** | Cliente extranjero atendido en el idioma equivocado | 🔴 era código, se borró |
| **Última orden: no aceptar pedidos a <30 min del cierre** | Entra un pedido que cocina no puede hacer | 🔴 dinero y cabreo |
| **Fuera de zona de reparto** | `computeZone` da el dato pero **no hay gate**: nada impide un `submit_order` a 12 km | 🔴 dinero |
| **Rango de entrega / prohibido dar hora exacta** | Promesa incumplida | 🟠 |
| **Teléfono en tres bloques de tres** | Se lee mal al repetirlo | 🟡 estilo |
| **No recitar ingredientes salvo pregunta** | Alarga la llamada | 🟡 estilo |
| **No preguntar tamaño ni base sin gluten** | Alarga la llamada | 🟡 estilo |

Comprobado: `rango_entrega` y `ultima_orden_min` **solo se interpolan como texto** en el prompt (líneas 612 y 616). No hay una sola línea que los haga cumplir.

### Fuera de git y fuera de los tests

| Superficie | En git | Con tests |
|---|---|---|
| Código (gates, guardián) | ✅ | ✅ |
| `buildSystemPrompt` | ✅ | parcial |
| **Prompt del panel de ElevenLabs** | ❌ | ❌ |
| **Ajustes del panel** (temperature, first_message, tools) | ❌ | ❌ |

Volumen del prompt del backend: **18 PROHIBIDO, 21 NUNCA, 14 SIEMPRE, 13 "UNA vez"** en 513 líneas. Cada uno de esos es una regla que alguien confió a la buena voluntad de un modelo.

---

## 3. Qué hacer, por orden de lo que cuesta dinero

1. ✅ **Gate de zona de reparto** — HECHO (`f269d7f`, en producción). `zonaFueraDeReparto()` + `requiredAction: "resolve_delivery_zone"`. Fail-open en `unknown`; el veredicto va atado a la dirección sobre la que se calculó; pasarse a recogida lo desbloquea solo. 11 tests, verificados en rojo al quitar el gate.
2. ✅ **Última orden** — HECHO (`a2f09ae`, en producción). **Opción B, decidida por sam el 19-08: avisa, no bloquea.** El pedido entra y el ticket sale con `⏰ FUERA DE ÚLTIMA ORDEN — CONFIRMAR CON ENCARGADO`, diciendo a cuántos minutos del cierre entró y con el teléfono del cliente. Decide el local, igual que con el contador de incidencias. Al cliente no se le dice nada. 11 tests — uno cazó un fallo real: a la 01:40 con turno 20:00–02:00 el cálculo no veía que seguías dentro del turno de ayer.
3. ✅ **Idioma anti-rebote** — HECHO (`bb33383`, en producción). No se restauró `detectLang` tal cual: el original miraba solo el último mensaje y le bastaba UN marcador, así que un "ciao" cambiaba el idioma de la llamada entera (por eso lo borraron). La versión nueva (`idiomaDeFrase` + `idiomaDeLaLlamada` + `directivaDeIdioma`) implementa la regla como está escrita: mínimo 3 palabras y 2 marcadores para establecer idioma, y una vez establecido se queda. 14 tests.
4. ✅ **El prompt de ElevenLabs, a git** — HECHO (`a2f09ae`). Ver `elevenlabs/` en el repo: `agent-sarah.config.json` (ajustes), `prompt-sarah.md` (solo estilo), `publicar-agente.cjs` (diff y publicación por API) y `README.md`. El secreto del backend queda como `${ELEVENLABS_CUSTOM_LLM_SECRET}`, nunca en el fichero — hay un test que lo comprueba. 10 tests protegen las decisiones de sam sobre el panel: `first_message` sin espacios, temperature 0.25, Backup LLM disabled, End Call activo, Speculative turn off, 2 rellenos, y que el cerebro siga apuntando al backend.

   **Pendiente tuyo:** `ELEVENLABS_API_KEY` no está en el `.env` local, así que `publicar-agente.cjs` aún no puede correr. Añádela y ya funciona (el script aborta si falta, no publica a medias).

### 3bis. Última orden: por qué NO se ha implementado

La regla del owner (06-08) dice: *"no se toman pedidos para un turno cuando faltan menos de 30 minutos para que cierre. En ese caso **dilo y ofrece el turno siguiente**"*.

**`submit_order` no tiene ningún campo de hora.** Ni `pickup_time`, ni `scheduled_for`, ni nada. La sesión tampoco lo guarda. Así que "ofrece el turno siguiente" no se puede cumplir: si el cliente dice que sí, no hay dónde apuntarlo y el gate vuelve a bloquear.

Poner el gate hoy convierte la regla en **un callejón sin salida que pierde la venta** — peor que el estado actual, donde al menos el modelo puede improvisar. Las opciones son decisión de negocio, no técnica:

| Opción | Pros | Contras |
|---|---|---|
| **A. Añadir campo de hora a `submit_order`** (recomendada) | Cumple la regla entera; el pedido entra programado para el turno siguiente | Toca el esquema de la tool, la sesión y el ticket de cocina |
| **B. No bloquear; el ticket sale con aviso** "FUERA DE ÚLTIMA ORDEN — confirmar con encargado" | No se pierde ninguna venta; decide el local, como con el contador de incidencias | El pedido entra y puede que cocina no lo pueda hacer |
| **C. Bloquear sin alternativa** | Protege la cocina | Pierde la venta y deja al cliente colgado |

Hasta que se elija una, `ultima_orden_min` sigue siendo texto en el prompt.

Las reglas 🟡 de estilo se quedan en el prompt. Ahí es donde deben estar.

---

## 4. El criterio, para no volver aquí

Una regla está en runtime cuando **la salida incorrecta es imposible**, no cuando está desaconsejada. Sólo hay tres formas de conseguirlo, y ya existen las tres:

1. **Resolución** — el backend nunca pregunta lo que ya sabe (`resolverDeSesion`).
2. **Gate** — nada avanza sin cumplir (`requiredAction`).
3. **Guardián de salida** — lo que contradiga 1 y 2 no llega a la voz.

Si una regla no encaja en ninguna de las tres, es estilo y se queda en el prompt.

**Y una condición para los tests:** un test que comprueba que *el prompt dice algo* no protege nada. Sólo cuenta el test que falla cuando el **comportamiento** se rompe. `f86d83f` es el ejemplo de lo primero.
