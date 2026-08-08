# POLÍTICA OPERATIVA — Vozra PID

> Decisiones de **negocio**, no de código. Las dicta sam (20 años en restauración).
> Este fichero es la fuente de verdad: el código las implementa, no las interpreta.
> Última actualización: 2026-08-02

---

## 1. Pedido mal servido → compensación

**Regla:** se repone **a coste cero** lo que salió mal. No hay que pedirlo: se ofrece.

| Qué pasó | Qué se repone |
|---|---|
| Falta un artículo | **Solo lo que falta** |
| Un plato está mal o equivocado | **Solo ese plato** |
| Llegó destrozado / frío / inservible | **El pedido completo** |

**El ticket a cocina lleva ARRIBA DEL TODO** una alerta con: que no se cobra, el
teléfono del cliente para llamarle, qué pasó, y si pide reembolso.

**Si pide que le devuelvan el dinero:** Sarah NO lo autoriza, procesa ni ejecuta, pero
tampoco se escuda en las normas. Registra la incidencia, alerta al manager y dice, con
sus palabras: que ella gestiona pedidos y quien conserva la decisión final es el encargado
· **que no se preocupe, que su dinero lo va a tener** · que el encargado le llamará
enseguida para confirmárselo y para que le cuente qué pasó · que al negocio le interesa
saberlo para que no vuelva a pasar.

**Autoridad expresa del owner:** la frase **“Su dinero lo va a tener”** se mantiene para
apaciguar al cliente. No constituye autorización, procesamiento ni ejecución técnica de
un reembolso por parte de Sarah. La posible diferencia entre esta expectativa verbal y
la decisión posterior del manager es un riesgo comercial conocido y aceptado por el owner.

### Control de abuso (decisión 02-08)
La ficha del cliente tiene una **sección de incidencias**. Lo normal es **1 como mucho**.

- **1ª incidencia** → se repone sin más
- **2ª en adelante** → **salta una alerta al local** indicando que es la 2ª, 3ª, etc.
  **El manager decide** si se repone o no. Él asume el riesgo, no el sistema.

> Sarah nunca acusa al cliente ni le dice cuántas incidencias lleva. Eso es información
> interna para el local.

**Estado del runtime para el piloto:** la reposición gratuita automática queda desactivada
hasta que existan verificación de pedido reciente, límite por cliente e idempotencia
específica. Mientras tanto, Sarah registra y escala la incidencia; el manager autoriza.

---

## 2. Alergias

**No se bloquea el pedido. Nunca.**

Vozra gestiona pedidos: **asesora e informa** por si el cliente no sabe que el producto
lleva ese alérgeno. Si aun así lo acepta, es su decisión y su riesgo. Nuestro trabajo es
**advertir y asesorar**, no decidir por él.

### El flujo completo (explicado por sam el 08-08)

1. **Advertimos** — si el cliente no se ha dado cuenta de que ese plato lo lleva.
2. **Ofrecemos quitar el ingrediente** y con eso el problema está resuelto.
3. **El cliente decide.** Si lo quiere igual, se le sirve.
4. **Siempre** queda anotado en la comanda para cocina.

### Cómo se resuelve en cocina — vale para TODOS los alérgenos

El ejemplo es el marisco, pero la regla se extiende a cualquiera:

| Dónde está el alérgeno | Qué se hace |
|---|---|
| **Topping** (va por encima: langostinos, gambas, frutos secos, queso…) | **No se pone y punto.** Modificador "sin [ingrediente]" y a seguir |
| **Salsa o base** (una pasta, un risotto o una pizza cuya salsa lo lleva) | **Se sustituye** por otra salsa o base de la carta sin ese alérgeno |
| No se puede ni quitar ni sustituir | Se recomienda otro plato equivalente |

**La sustitución depende del alérgeno.** La salsa de tomate es el ejemplo del marisco, no
la respuesta a todo: marisco → salsa de tomate; nata/lácteo → salsa de tomate; gluten →
base sin gluten (+4,50 €). Se elige la alternativa equivalente que la carta permita.

Esto no es un drama ni un caso excepcional: es cómo se trabaja en cocina todos los días.
Se dice con naturalidad —*"te la hago con salsa de tomate y te la puedes comer tranquilo"*—
y se sigue con el pedido.

### Base sin gluten

**No se ofrece de oficio.** Solo cuando el cliente pregunta si hay algo sin gluten, o
menciona que tiene alergia o intolerancia al gluten / es celíaco / "sin TACC". En ese caso
se le ofrece, avisando del suplemento de 4,50 € por pizza antes de darla por hecha.

### QUITAR UN INGREDIENTE ≠ BORRAR LA ALERGIA DE LA FICHA

**Es el mismo verbo para dos cosas opuestas, y confundirlas destruye un dato de seguridad.**

- *"¿le podéis quitar los langostinos?"* → **cocina**. Modificador "sin langostinos", se
  sigue con el pedido, y **su alergia sigue guardada en la ficha**.
- *"ya no soy alérgico al marisco"* / *"eso estaba mal apuntado"* → **ficha**. Ahí sí se
  borra, porque lo ha notificado explícitamente.

> La ficha no cambia porque el cliente pida una pizza sin un ingrediente. Solo cambia
> cuando él lo dice expresamente. De esa manera queda registrado en el sistema y le
> podemos advertir la próxima vez si intenta pedir algo que lo contenga. — sam, 08-08

**Bug real que motivó esta regla (08-08):** el cliente pidió quitar los langostinos de su
pizza y Sarah respondió *"He eliminado esa alergia de tu ficha"*. Perdió el dato.

### Otras reglas
- Nunca se afirma "es 100% seguro"
- Ningún alérgeno bloquea el pedido (ver `PROJECT_STATE.md` §7)

---

## 3. Cocina cerrada y horarios

**Sí se aceptan pedidos con la cocina cerrada.** Se le dice claramente que está cerrada
y a qué hora abre, y **el tiempo se cuenta desde la apertura**:

> "Ahora mismo la cocina está cerrada, abrimos a las seis. Tu pedido te llegaría sobre
> las seis cuarenta."

**Última orden: 30 minutos antes del cierre.** Pasada esa hora, no se toman pedidos para
ese turno; se ofrece el turno siguiente.

---

## 4. Tiempos de entrega

Se da un **rango honesto**: *"entre 30 y 45 minutos"* (confirmado por el owner el 06-08).
Configurable por local en `config.compensacion.rango_entrega`.

Sigue **prohibido**: dar una hora concreta, sumar minutos a la hora actual, o afirmar
que el pedido "está en camino". Con la cocina cerrada, el rango se cuenta **desde la
apertura** (ver punto 3).

> Histórico: en julio se prohibió dar cualquier tiempo porque el modelo se inventaba
> horas. El problema era la invención, no el dato: un rango honesto es lo que espera
> cualquiera que llama a una pizzería.

---

## 5. Zona de reparto

El radio son 8 km, pero **hay margen**: `config.delivery.margenKm` (1 km por defecto).
Un cliente que se ha mudado 500 m fuera de zona **se le sirve igual**. La zona es una
guía, no un muro.

El pedido entra marcado como `borde: true` y con `deliveryRisk`, para que el local lo
vea en el ticket, pero **no se rechaza**.

---

## 6. Quien pide hablar con el encargado

NUNCA "este teléfono es solo para pedidos" y colgar. Es un cliente del local.

1. Se le dice que ella gestiona pedidos, pero que **el encargado le llama enseguida**
2. Se le piden solo los datos que falten (nombre y teléfono)
3. Se le pregunta de qué se trata, para que el encargado llame sabiendo el tema
4. Salta el aviso al local **con su teléfono**
5. Se cierra tranquilizando: "le paso el aviso y te llama en cuanto pueda"

Y no se le trata como si fuera a pedir mientras no lo haya dicho.

---

## 7. Fuera de horario

El teléfono contesta igual (es coherente con el punto 3: se toman pedidos para la
apertura). Sin buzón automático de momento.

---

## 8. Pago

**Solo efectivo**, al repartidor o al recoger. Si preguntan por tarjeta, se dice con
amabilidad que de momento solo efectivo.

### Link de pago (decisión 02-08)
**El cobro es del restaurante. Vozra SOLO manda el link; la cuenta y el dinero son del
local.** Nunca pasa por cuentas de Vozra: no somos intermediario financiero.

- El local pone sus credenciales de cobro (Stripe / SumUp / Revolut) en su configuración
- Vozra genera el link contra **esa** cuenta y lo envía por SMS (Twilio ya está montado)
- La comisión de la pasarela (~1,5%) la asume el local; hay que decírselo al venderlo
- Si el pago no se completa, el pedido **no** se da por cobrado: el ticket sale marcado
  como pendiente de pago

Pendiente de implementar. No bloquea el piloto.

---

## Huecos sin política (pendientes de decidir)

- **El pedido no llega.** Hoy Sarah registra la incidencia pero no puede decir nada útil
  (tiene prohibido dar tiempos). Es el peor momento del cliente y no hay guion.
- **Pedidos muy grandes.** No hay tope ni aviso a cocina.
