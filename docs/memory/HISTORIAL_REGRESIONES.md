# HISTORIAL DE REGRESIONES — Vozra PID

> Reconstruido el 2026-08-09 a partir de las notificaciones de GitHub en
> sttfx2021@gmail.com, cruzadas con las fechas de los ficheros del repo y las
> transcripciones de llamadas reales.
>
> **Pregunta que responde:** ¿cuándo dejó Sarah de hacer cosas que ya hacía bien?

---

## EL HALLAZGO PRINCIPAL: el repo PID se quedó sin red el 29 de junio

`STTFX2021/vozra-orders` **tenía CI**. Hay notificaciones de tres workflows:

| Workflow | Última señal |
|---|---|
| `Vozra Orders regression tests` | **29-06-2026** |
| `apply-system-prompt-fix.yml` | 28-06-2026 |
| `amend-multilingual.yml` | 28-06-2026 |

Después del **30 de junio (PR #4)**, el repo `vozra-orders` **no vuelve a generar
ni una sola notificación**. Ni PRs, ni ejecuciones de CI, ni revisiones.

Y en el repo de hoy **no existe la carpeta `.github/workflows`**.

**Consecuencia:** desde el 30 de junio, todo entra a producción por push directo a
`main` sin que nada lo compruebe. La única red que queda son los tests que se
ejecutan **a mano** (`VERIFICAR.bat`) y las llamadas reales del owner. Por eso las
regresiones se descubren cuando un cliente ya ha colgado el teléfono.

> Esto no es una opinión sobre cómo trabajar: es el motivo material por el que una
> decisión de negocio pudo revertirse durante seis días sin que saltara nada.

---

## CRONOLOGÍA DE LA REGRESIÓN DE ALÉRGENOS

La función que dejó de hacer lo que hacía. Fechas de los emails y de los ficheros:

| Fecha | Qué pasó | Fuente |
|---|---|---|
| **23-07** | Llamada `conv_4101`: "el manejo de alérgenos fue **correcto y seguro**: cruza los 3 platos, avisa, ofrece base sin gluten con su suplemento y dice con honestidad que no hay pizzas sin lactosa. **Ese es exactamente el comportamiento que vende el producto**" | `SARAH_POST_FIX_BASELINE_RESULT.md` |
| **28-07** | El owner decide: **el alérgeno se anota y se asesora, el pedido continúa. NO hay gate de bloqueo.** Queda escrito en `PROJECT_STATE.md` §7 | memoria del proyecto |
| **03-08** | Aparecen `test-allergen-authority-20260803.cjs` y `test-transactional-authority-20260803.cjs`. **El alérgeno pasa a ser un ERROR bloqueante** (`ALLERGEN_CONFLICT_PENDING`), con tests que lo protegen | ficheros del repo |
| **05-08** | Aparece `test-deterministic-closure-20260805.cjs` | ficheros del repo |

> **Nota de autoría.** Codex **no** trabajó en PID: el owner lo mantuvo fuera de este
> repo a propósito. Los PRs de "authority" del repo `vozra` (#8 del 31-07 al #12 del
> 06-08) son de OTRO proyecto y **no son la causa** — coinciden en fechas y en
> vocabulario porque se estaba pensando lo mismo en paralelo, nada más. El trabajo
> que entró en PID se hizo en sesiones de chat con push directo a `main`.
| **07-08** | Llamada real: Abruzzo + alergia a marisco → **bucle de 4 turnos**, pedido sin cerrar | transcripción |
| **08-08** | Llamada real: *"¿le podéis quitar los langostinos?"* → *"He eliminado esa alergia de tu ficha"* | transcripción |
| **08-08** | Se revierte: el alérgeno vuelve a ser aviso, no bloqueo (`2d44bea`) | commit |

**Ventana de la regresión: 31 de julio → 6 de agosto.** Seis días. Ninguna alerta.

### Por qué nadie se enteró

1. **No hay CI en `vozra-orders` desde el 29 de junio.** Nada comprueba un push.
2. **Los tests nuevos no fallaban**: se escribieron para blindar el comportamiento
   nuevo. Un test que protege una regresión no la detecta — **la fija**. Esto es lo
   más importante de todo el episodio.
3. `PROJECT_STATE.md` §7 seguía diciendo lo contrario desde el 28-07, pero nadie lo
   leyó al tocar el código.
4. El síntoma (un bucle) parecía un fallo del modelo, no una regla de negocio
   cambiada. Se buscó durante días en el sitio equivocado.

---

## OTRAS REGRESIONES DEL MISMO PERIODO (todas ya corregidas)

| Función que funcionaba | Cuándo se rompió | Síntoma real | Arreglado en |
|---|---|---|---|
| Reconocer al cliente sin repreguntar la dirección | ~01-08 | *"¿Te lo llevo a **la calle de siempre, la de siempre**?"* a una clienta nueva | `ec63710` |
| No abrir incidencias falsas | ~02-08 (con la política de compensación) | *"no hace **falta**"* generaba un ticket de "Producto incorrecto" y **reposición gratis** | `86681e0` |
| Decir qué dato falta | ~03-08 (con los gates de authority) | *"Antes de resumir necesito resolver un dato pendiente"* ×4 | `9ad667b` |
| La alergia del titular es del titular | desconocido | La alergia de un **amigo** se guardó en la ficha de Samuel | `9ad667b` |
| Entender "sí" y "no" | ~03-08 | *"sí, está bien"* (= cerrar) se leía como *"sí, quiero añadir"* | `8ac1a13` |
| No repetir el resumen | ~03-08 | Resumen repetido **4 veces** tras confirmar | `8ac1a13` |

**Patrón común:** todas entraron con la oleada de "autoridad determinista" del
31-jul → 6-ago. El objetivo era bueno (sacar las decisiones del modelo y meterlas
en código) pero se codificaron reglas que el negocio no había pedido, y se
blindaron con tests.

---

## EL CORREO: qué es ruido y qué no

De `vozra-orders` (PID) **no llega nada desde el 30 de junio**. Lo que llena la
bandeja es de otros repos:

| Repo | Qué manda | ¿Silenciar? |
|---|---|---|
| **`vozra-s-digital-twin`** | *Release gate* fallando sin parar desde el 06-08 en `agent/interactive-floor-manager`: **+20 ejecuciones** entre el 6 y el 9 de agosto | **SÍ** — decisión del owner 09-08 |
| **`vozra-insight-engine`** | *Vozra visual check* fallando desde el 17-07 | **NO.** Es el Control Center: donde la empresa y los clientes ajustan sus parámetros. Parte fundamental del producto |
| **`vozra`** | `supabase[bot]` avisando de que ignora PRs sin cambios en `supabase/` | Informativo, no es un error |

⚠️ El *visual check* de `vozra-insight-engine` lleva **desde el 17 de julio** en rojo.
No es ruido: es el panel del producto. Habrá que mirarlo.

---

## QUÉ HACER CON ESTO

1. **Restaurar el CI de `vozra-orders`.** Un workflow que ejecute `npm test` en cada
   push a `main`. Sin eso, la próxima regresión se descubrirá igual: en una llamada.
2. **Callar SOLO `vozra-s-digital-twin`.** Los 20 correos diarios de su Release gate
   tapan cualquier aviso que sí importe. `vozra-insight-engine` NO se toca: es el
   Control Center del producto.
3. **Antes de tocar una regla, leer `PROJECT_STATE.md` §7 y `POLITICA_OPERATIVA.md`.**
   Si el código y la política no coinciden, **gana la política**.
4. **Un test que fija un comportamiento nuevo no vale como prueba de que sea el
   correcto.** Los tests de authority estaban bien escritos y protegían lo contrario
   de lo que el dueño había decidido.
