# NEXT_SESSION — Vozra PID

> Solo Vozra PID. Roomy Food está en `../roomy-food` con su propia memoria.

**Escrito el:** 2026-08-08
**HEAD = producción:** `2d44bea` (commiteado, pusheado, desplegado en Railway).

---

## ⚡ LO PRIMERO: una llamada real con estas cinco pruebas

Todo lo del 07 y 08 de agosto salió de transcripciones de llamadas reales del owner.
Los tests automáticos NO ejecutan el LLM: que Sarah OBEDEZCA solo se comprueba llamando.

| # | Qué decir | Qué tiene que pasar |
|---|---|---|
| 1 | "Soy alérgico al marisco" + pedir una **Abruzzo** | Avisa de los langostinos, ofrece quitarlos. Si dices "déjala como está" → **te la sirve** y la anota. NUNCA te niega el pedido |
| 2 | Desde un número **sin dirección guardada**, dictarla una vez | La da por buena y sigue. Jamás dice "la de siempre" |
| 3 | "No" al entrante | No insiste |
| 4 | Al ofrecerte bebida, responder **con el producto** ("ponme dos Coca-Colas") | Lo acepta a la primera, sin pedir un "sí" |
| 5 | Soltar "no hace falta" y "¿qué dato te falta?" | **Cero tickets de incidencia en Telegram** |

Llamada de prueba saliente (Sarah te llama):
```
curl -s -X POST -H "Authorization: Bearer TU_SECRET" -H "Content-Type: application/json" -d "{\"to\":\"+34634425921\"}" https://vozra-orders-production.up.railway.app/admin/test-call
```
Con el `conversation_id` que devuelve: `GET /admin/test-call/autopsia?conv=conv_…` da transcript
y motivo de corte. El Bearer sale de `RAILWAY_LLM_SECRET` en el `.env` local.

---

## ⚠️ ANTES DE TOCAR NADA: lee esto

### 1. Los .bat son el camino. PowerShell no acepta `&&`.
Desde `…\vozra-orders\backend`:
```
.\VERIFICAR.bat                    # sintaxis + suite completa + git + /health
.\SUBIR.bat "mensaje del commit"   # tests + suite y SOLO sube si todo pasa
```
El owner acaba en `C:\WINDOWS\system32` constantemente: los `.bat` hacen `cd /d "%~dp0"`
y se colocan solos. Dar comandos con `&&` le ha hecho perder tiempo varias veces.

### 2. El shell del sandbox NO llega al disco `D:`.
Los ficheros sí se leen y editan (Read/Write/Edit/Grep/Glob), pero `node`, `npm` y `git`
los ejecuta el owner. Además: **el disco `D:` se desconectó a mitad de sesión el 08-08**;
si las herramientas dejan de ver la carpeta, hay que pedirla otra vez.

### 3. Antes de cambiar una regla, mira si ya está decidida.
`PROJECT_STATE.md` §7 y `docs/POLITICA_OPERATIVA.md` son la fuente de verdad de NEGOCIO.
El 03-08 se reintrodujo un gate que bloqueaba por alérgeno, contradiciendo una decisión
que el owner había tomado el 28-07 y que estaba escrita. Costó una llamada rota y una
sesión entera deshacerlo. **Si el código y la política no coinciden, gana la política.**

---

## PENDIENTE #1 — La regla de UNA SOLA PREGUNTA (dictada el 08-08, sin implementar)

> "Solo se pregunta una vez una misma pregunta. Solo se puede volver a preguntar si no
> se entiende algo." — sam, 08-08

Sustituye a los contadores ad hoc (tope 2, tope 3) que hay hoy repartidos por gates.
Especificación completa en `C:\Users\Orochika\Claude\Projects\04_Vozra_Orders\REGLA_UNA_PREGUNTA_Y_ALERGENOS.md`.

**Diseño acordado: un guardián único.** Todo retorno bloqueante pasa por una función que
lleva el registro por llamada de qué se ha preguntado ya, con dos reglas:
1. Si la pregunta ya se hizo → solo se repite si el turno del usuario está vacío o es
   ininteligible. En cualquier otro caso **se libera y se avanza**.
2. **Un mensaje que no dice QUÉ falta no sale.** Se rechaza en el propio guardián.
   (Ya resuelto en validación y alérgenos con `mensajeDeBloqueo()`; faltan los demás.)

Gates afectados (~10): validación, alérgenos, upsell, suplementos, resumen, confirmación,
persistencia del pedido, persistencia de alergias, lectura de perfil, tipo de entrega.

## PENDIENTE #2 — Deuda de datos (detectada 08-08, sin arreglar)

- **Fail-open en `customer-store.js`**: `getCustomerByPhone` hace `if (!p || !isEnabled())
  return null;` ANTES del try/catch, así que `throwOnError:true` nunca se alcanza sin
  credenciales. Si Supabase se cae en producción, **todos los clientes registrados pasan a
  tratarse como nuevos, en silencio**, y el fail-closed del cerebro no se dispara.
  No se tocó porque puede tumbar los tests locales, que corren sin credenciales.
- **`order_count` a 0** para todos los clientes pese a decenas de pedidos. No se incrementa.
- El `.env` local NO tiene credenciales de Supabase (solo Railway): para consultar la BD
  hay que pedirle al owner el SQL Editor del panel.

## PENDIENTE #3 — `reposicion_gratis` sigue en `false`

Toda la política de compensación está construida y probada, pero **dormida**. Es dinero
real del local: la enciende el owner cuando quiera, no se hace por iniciativa propia.

## PENDIENTE #4 — Mitad y mitad puede estar fallando

Al quitar el bloqueo de alérgenos salió a la luz que un ítem `half_and_half` **no pasa
`validateItems`** (el id compuesto no existe en la carta). El test nunca lo vio porque el
bloqueo de alérgeno daba `ok:false` antes, por el motivo equivocado. Sin verificar si
rompe en llamadas reales.

## Pendientes anteriores que siguen abiertos
- **¿`callId` estable?** Mirar `[EL] turn | callId=…` en Railway. Si es `conv_…`, se puede
  quitar la deuda de re-derivación por historial (`phoneFromHistory`, `yaDicho`).
- **Caché de prompt:** confirmar `cached≈11000` en `[LLM] openai … in= cached= out=`.
- Limpieza en Railway: quitar `TWILIO_SKIP_SIGNATURE`, renombrar `Secret key` → `TURNSTILE_SECRET`.
- Multi-tenant: `la-locanda` hardcodeado en varios sitios.

---

## QUÉ PASÓ EL 07 y 08 DE AGOSTO (todo desplegado)

Cuatro rondas, todas nacidas de transcripciones reales que trajo el owner. El hilo
conductor: **el bloqueo casi siempre era correcto; lo que fallaba era que no se comunicaba.**

### `ec63710` — la dirección y el plato con extra
- "¿Te lo llevo a **la calle de siempre, la de siempre**?" a una clienta nueva. Dos causas:
  el fallback duplicaba la coletilla, y la directiva de dirección guardada se disparaba con
  una dirección DICTADA en la llamada.
- Dirección pedida dos veces → `direccionDadaEnLlamada()` (palabra de vía + número).
- "pizza de pepperoni **con** alcaparras" → respondía que no existe esa pizza. Regla nueva
  en el prompt: PLATO + INGREDIENTE = plato base + extra (`con`, `y`, `ponle`, `échale`…).

### `86681e0` — las incidencias fantasma (lo más caro)
`quejaDePedidoEntregado()` concatenaba TODO el histórico y buscaba una palabra de problema
y otra de comida en ese pegote. **`falta` estaba en la lista.** Resultado: "no hace **falta**"
(rechazando un entrante) y "¿qué dato te **falta**?", más un "pizza" de cinco turnos antes,
generaban un ticket de "Producto incorrecto" y una oferta de **reposición gratis** a clientes
que solo estaban pidiendo la cena. Dos llamadas reales acabaron así.
- Reescrito: se evalúa **frase a frase**, "hace falta"/"qué dato te falta" excluidos, y hace
  falta una señal de que **el pedido ya se entregó** ("me ha llegado", "me trajeron").
- Red de seguridad: si el modelo rellena `incidencia` y no hay queja en la conversación, se
  descarta el campo. **Una incidencia inventada no puede costarle una venta al local.**
- "La de siempre" estaba en **TRES sitios del prompt**: arreglar uno no bastó. El test ahora
  recorre el prompt entero y falla si cualquier línea la manda sin condicionarla.
- Upsell: el gate solo entendía "sí"/"no". Nadie responde "sí" a "¿algo de beber?": responde
  con la bebida. `upsellYaCubierto()` + tope de insistencia.
- Resumen repetido: se comparaba **carácter a carácter** con `summaryText`; un `&` por `y` y
  la confirmación del cliente se iba a la basura → `mismoResumen()` normalizado.

### `9ad667b` — el mensaje ciego y la alergia del acompañante
- **"Antes de resumir necesito resolver un dato pendiente"** ×4. El bloqueo era correcto
  (Abruzzo con langostinos), pero no decía cuál → nadie podía resolverlo. `mensajeDeBloqueo()`
  nombra plato, ingrediente y alergia, o el campo concreto que falta.
- **La alergia del amigo se guardó en la ficha del titular.** "Tengo un amigo con alergia a
  los langostinos" dejó "marisco" en la ficha de Samuel para siempre. Decisión del owner
  (opción A de tres): **a la comanda siempre, a la ficha solo si el alérgico es quien llama.**
  `alergiaEsDeTercero()`. "Yo soy alérgico" gana y sí se guarda.

### `2d44bea` — EL ALÉRGENO YA NO BLOQUEA (ver §7 de PROJECT_STATE)
El hallazgo de la sesión. El 28-07 el owner decidió que el alérgeno se advierte y decide el
cliente, y quedó escrito. El 03-08 se reintrodujo el bloqueo como "autoridad determinista",
con tests que lo protegían — uno decía literalmente: cliente responde *"al final déjala como
viene"* → **pedido rechazado**. Cuatro sitios corregidos: el validador (de `error` a
`warning`), el cálculo en el cerebro, la "regla madre" del prompt, y los tests.
- El aviso viaja ahora por su propio canal, `aviso_alergeno`, con la instrucción completa.
  Sin eso, al quitar el bloqueo Sarah se habría quedado **sin enterarse** del alérgeno: lo
  cazó el propio test.
- **Determinismo ≠ bloquear.** El código sigue decidiendo (siempre avisa, siempre va al
  ticket); lo que cambia es qué decide.

---

## Cómo arrancar (en este orden)
1. `MEMORY_INDEX.md` → este archivo → `PROJECT_STATE.md` → `KEY_FACTS.md`.
2. `docs/POLITICA_OPERATIVA.md` para cualquier duda de NEGOCIO (compensaciones, alergias,
   horarios, zona, pago). Lo dicta sam, no se interpreta.
3. Regla de oro del owner: **arreglamos LÓGICA, no parches.** Y la del método: cuando haya
   un conflicto de operativa, **se le plantea a él** — 20 años en restauración — y su
   respuesta se convierte en código.
4. Git root está en `backend/.git`. Todo `git` desde `…\vozra-orders\backend`.
