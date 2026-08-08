/**
 * test-bucle-upsell-20260807.cjs
 *
 * Dos bucles de la llamada real del 06-08 (Samuel, 634425921).
 *
 * A) EL UPSELL NO ENTIENDE QUE YA LE HAN RESPONDIDO:
 *      [agent] ¿Te pongo algo de beber?
 *      [user]  Eh, sí, una Coca Cola para cada pizza, por favor.
 *      [agent] Necesito saber si quieres añadir algo o seguimos con el pedido.
 *      [user]  Sí, te he dicho una Coca-Cola para cada pizza, por favor.
 *      [agent] Necesito saber si quieres añadir algo o seguimos con el pedido.
 *      [user]  Sí, ponme dos Coca-Colas.
 *      [agent] Perfecto. ¿Qué bebida o complemento quieres añadir?
 *      [user]  Te acabo de pedir la bebida.
 *    El gate solo leía "sí" / "no". Nadie responde "sí" a "¿algo de beber?":
 *    responde CON la bebida. Además no había tope de insistencia.
 *
 * B) RESUMEN REPETIDO TRAS CONFIRMAR:
 *      [agent] Resumen: 1 Abruzzo, 1 Prosciutto & Funghi… ¿confirmas el pedido?
 *      [user]  Sí, por favor.
 *      [agent] Resumen: 1 Abruzzo, 1 Prosciutto & Funghi… ¿confirmas el pedido?
 *      [user]  Te he dicho que sí.
 *    Se exigía igualdad EXACTA de cadena. Un "&" por "y" y la confirmación del
 *    cliente se tiraba a la basura.
 *
 *   node test-bucle-upsell-20260807.cjs
 */
const assert = require("assert");
const {
  upsellYaCubierto,
  vecesInsistidoUpsell,
  mismoResumen,
  confirmationMatchesDeliveredSummary,
  quejaDePedidoEntregado,
  mensajeDeBloqueo,
  alergiaEsDeTercero,
  upsellAlreadyOffered,
  buildSystemPrompt,
  siguienteUpsell
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

const OFERTA_BEBIDA   = "¿Te pongo algo de beber?";
const OFERTA_ENTRANTE = "¿Te pongo algo para picar, un entrante para compartir?";
const INSISTE = "Necesito saber si quieres añadir algo o seguimos con el pedido.";

console.log("══ Bucles de la llamada real 06-08 ═══════════════");

// ── A. El cliente responde con el producto ──────────────────────────────────
test("CASO REAL: 'una Coca Cola para cada pizza' resuelve el upsell de bebida", () => {
  const order = { items: [{ category: "pizza_rossa" }], upsellOfferText: OFERTA_BEBIDA };
  const msgs = [A(OFERTA_BEBIDA), U("Eh, sí, una Coca Cola para cada pizza, por favor.")];
  assert.strictEqual(upsellYaCubierto(order, msgs), true,
    "sigue sin ver que el cliente ya ha pedido la bebida");
});

test("la bebida ya en la comanda también lo resuelve", () => {
  const order = { items: [{ category: "pizza_rossa" }, { category: "beverages" }],
                  upsellOfferText: OFERTA_BEBIDA };
  assert.strictEqual(upsellYaCubierto(order, []), true);
});

test("si NO ha pedido la categoría ofrecida, el upsell sigue pendiente", () => {
  const order = { items: [{ category: "pizza_rossa" }], upsellOfferText: OFERTA_BEBIDA };
  assert.strictEqual(upsellYaCubierto(order, [A(OFERTA_BEBIDA), U("pues no sé")]), false);
});

test("ofrecido un entrante, pedir bebida NO lo da por resuelto", () => {
  const order = { items: [{ category: "pizza_rossa" }], upsellOfferText: OFERTA_ENTRANTE };
  const msgs = [A(OFERTA_ENTRANTE), U("ponme una Coca-Cola")];
  assert.strictEqual(upsellYaCubierto(order, msgs), false,
    "da por servido un entrante que nadie ha pedido");
});

test("sin oferta registrada no se inventa que está cubierto", () => {
  assert.strictEqual(upsellYaCubierto({ items: [], upsellOfferText: "" }, []), false);
});

// ── A2. El tope de insistencia (regla §4ter) ────────────────────────────────
test("CASO REAL: cuenta las veces que se ha insistido", () => {
  assert.strictEqual(vecesInsistidoUpsell([
    A(OFERTA_BEBIDA), U("una Coca Cola"), A(INSISTE), U("ya te la he pedido"), A(INSISTE)
  ]), 2);
});

test("cuenta también la variante de '¿Qué bebida o complemento…?'", () => {
  assert.strictEqual(vecesInsistidoUpsell([
    A(INSISTE), A("Perfecto. ¿Qué bebida o complemento quieres añadir?")
  ]), 2);
});

test("una conversación normal no acumula insistencias", () => {
  assert.strictEqual(vecesInsistidoUpsell([A(OFERTA_BEBIDA), U("no, gracias")]), 0);
});

// ── B. La confirmación no se tira a la basura ───────────────────────────────
const RESUMEN = "Resumen: 1 Abruzzo, 1 Prosciutto & Funghi, 1 Antipasto Italiano, 2 Coca-Cola. Total 56 euros. ¿Está todo correcto y confirmas el pedido?";

test("CASO REAL: el mismo resumen con '&' o 'y' es el mismo resumen", () => {
  assert.strictEqual(
    mismoResumen(RESUMEN.replace("&", "y"), RESUMEN), true,
    "un '&' por 'y' invalida la confirmación del cliente");
});

test("puntuación y mayúsculas distintas no rompen la confirmación", () => {
  assert.strictEqual(
    mismoResumen("RESUMEN - 1 abruzzo, 1 prosciutto y funghi, 1 antipasto italiano, 2 coca cola. total 56 euros. ¿esta todo correcto y confirmas el pedido?", RESUMEN),
    true);
});

test("un resumen DISTINTO no cuela como confirmación", () => {
  assert.strictEqual(
    mismoResumen("Resumen: 1 Margherita. Total 9 euros. ¿Confirmas?", RESUMEN), false,
    "confirmaría un pedido que el cliente nunca ha oído");
});

test("CASO REAL: 'Sí, por favor' tras el resumen SÍ confirma", () => {
  const order = { summaryText: RESUMEN, summaryFingerprint: "fp1", draftFingerprint: "fp1" };
  const msgs = [A(RESUMEN.replace("&", "y")), U("Sí, por favor.")];
  assert.strictEqual(confirmationMatchesDeliveredSummary(msgs, order), true,
    "el resumen se repetiría entero, como en la llamada real");
});

test("sin afirmación del cliente NO se da por confirmado", () => {
  const order = { summaryText: RESUMEN, summaryFingerprint: "fp1", draftFingerprint: "fp1" };
  assert.strictEqual(
    confirmationMatchesDeliveredSummary([A(RESUMEN), U("espera, cambia la Abruzzo")], order),
    false, "confirma un pedido que el cliente está cambiando");
});

test("si el pedido ha cambiado tras el resumen, hay que resumir de nuevo", () => {
  const order = { summaryText: RESUMEN, summaryFingerprint: "fp1", draftFingerprint: "fp2" };
  assert.strictEqual(
    confirmationMatchesDeliveredSummary([A(RESUMEN), U("sí")], order), false,
    "despacharía un pedido distinto del que se le leyó");
});

// ── C. INCIDENCIAS FANTASMA (lo más caro de los cuatro) ─────────────────────
// Dos llamadas reales del 07-08 generaron un ticket "Producto incorrecto" y una
// oferta de reposición GRATIS a clientes que solo estaban pidiendo la cena.
test("CASO REAL: '¿qué dato te falta?' NO es una queja de pedido entregado", () => {
  assert.strictEqual(quejaDePedidoEntregado([
    U("Eh, me gustaría hacer un pedido a domicilio."),
    U("una pizza carbonara, una B&B, una Ludy y una prosciutto"),
    U("No, ponme cuatro Coca-Colas, por favor."),
    U("Vale, ¿qué dato te falta?")
  ]), false, "vuelve a inventarse una incidencia y a regalar comida");
});

test("CASO REAL: 'no, no hace falta' NO es una queja", () => {
  assert.strictEqual(quejaDePedidoEntregado([
    U("Eh, me gustaría hacer un pedido para recoger."),
    U("una pizza carbonara, una B&B, una Ludi, una Abruzzo y una pizza frita"),
    U("Eh, no, no hace falta.")
  ]), false, "'no hace falta' seguiría disparando una reposición gratuita");
});

test("CASO REAL: declarar una alergia NO abre incidencia ni regala el pedido", () => {
  // Hipótesis de sam: la reposición gratuita saltó al declarar la alergia del
  // amigo. Se comprueba la frase aislada — y la conversación entera — para no
  // dar por buena ninguna de las dos versiones sin verla.
  assert.strictEqual(quejaDePedidoEntregado([
    U("Eh, tengo un amigo con alergia a los langostinos y al marisco, ¿vale? Entonces, te voy a hacer unos pedidos, tú ya me dices.")
  ]), false, "una alergia declarada se trataría como pedido mal servido");
  assert.strictEqual(quejaDePedidoEntregado([
    U("Eh, me gustaría hacer un pedido para recoger."),
    U("El 634425921."),
    U("Eh, tengo un amigo con alergia a los langostinos y al marisco, ¿vale?"),
    U("una pizza carbonara, una B&B, una Ludi, una Abruzzo y una pizza frita"),
    U("Eh, no, no hace falta.")
  ]), false, "la llamada real completa vuelve a generar la incidencia fantasma");
});

test("un pedido normal con la palabra 'pizza' no dispara nada", () => {
  assert.strictEqual(quejaDePedidoEntregado([U("quiero dos pizzas y una Coca-Cola")]), false);
});

test("CASO REAL 02-08: la queja de verdad SÍ se sigue detectando", () => {
  assert.strictEqual(quejaDePedidoEntregado([
    U("la comida me ha llegado fría y destrozada, la pizza está reventada")
  ]), true, "un cliente con la pizza destrozada se quedaría sin compensación");
});

test("'me faltaba una pizza en el pedido que me trajeron' SÍ es queja", () => {
  assert.strictEqual(quejaDePedidoEntregado([
    U("me trajeron el pedido pero faltaba una pizza")
  ]), true);
});

test("un problema SIN entrega previa no basta para abrir incidencia", () => {
  // Sin señal de que el pedido ya llegó no puede haber pedido mal servido.
  assert.strictEqual(quejaDePedidoEntregado([U("no quiero la masa quemada")]), false);
});

// ── D. "La de siempre" a quien no tiene dirección guardada ──────────────────
test("CASO REAL: perfil SIN dirección guardada nunca dice 'la de siempre'", () => {
  const p = buildSystemPrompt(undefined, { name: "Pepa", address: null });
  assert.ok(/NO TIENE NINGUNA DIRECCI[ÓO]N GUARDADA/.test(p),
    "falta la prohibición explícita en el bloque de perfil");

  // Toda instrucción que mande usar la fórmula tiene que ir CONDICIONADA a que
  // exista una dirección guardada. El fallo de Pepa vino de que tres sitios
  // distintos la mandaban sin condición y bastaba con arreglar uno para creer
  // que estaba resuelto.
  const sueltas = p.split("\n").filter(l =>
    /la de siempre\?/i.test(l) &&
    !/(TRAE|tiene|hay|con)\s+(una\s+)?direcci[óo]n guardada/i.test(l) &&
    !/PROHIBIDO/i.test(l));
  assert.strictEqual(sueltas.length, 0,
    "instrucción incondicional de decir 'la de siempre':\n       " + sueltas.join("\n       "));
});

test("perfil CON dirección guardada sí conserva la fórmula", () => {
  const p = buildSystemPrompt(undefined, { name: "Samuel", address: { raw: "Calle Alpandeire 3" } });
  assert.ok(/Calle Alpandeire, la de siempre/.test(p), "un habitual pierde el reconocimiento");
});

// ── F. Un gate que no dice QUÉ falta es un bucle garantizado ────────────────
// CASO REAL 07-08: "Antes de resumir necesito resolver un dato pendiente del
// pedido" repetido CUATRO veces. El bloqueo era correcto (Abruzzo con
// langostinos + alergia a marisco en ficha), pero el mensaje no lo decía.
test("CASO REAL: el bloqueo por alérgeno dice el plato, el ingrediente y la alergia", () => {
  const msg = mensajeDeBloqueo({ allergenConflicts: [{
    status: "pending", classification: "removable",
    itemName: "Abruzzo", component: "langostinos", declaredAs: "marisco"
  }]});
  assert.ok(/Abruzzo/.test(msg), "no dice de qué plato habla");
  assert.ok(/langostinos/.test(msg), "no dice el ingrediente");
  assert.ok(/marisco/.test(msg), "no dice la alergia");
  assert.ok(!/un dato pendiente/i.test(msg), "sigue siendo el mensaje ciego del bucle");
});

test("si el alérgeno NO se puede quitar, se recomienda otro plato", () => {
  const msg = mensajeDeBloqueo({ allergenConflicts: [{
    status: "pending", classification: "intrinsic",
    itemName: "Frutti di Mare", component: "mejillones", declaredAs: "marisco"
  }]});
  assert.ok(/no se puede quitar/i.test(msg) && /otro plato/i.test(msg));
});

test("cada dato que falta se nombra en concreto", () => {
  for (const [code, esperado] of [
    ["MISSING_ADDRESS_NUMBER", /N[ÚU]MERO/],
    ["MISSING_PHONE", /tel[ée]fono/i],
    ["MISSING_NAME", /nombre/i],
    ["MISSING_ITEMS", /vac[íi]o/i],
    ["ITEM_NOT_IN_MENU", /no est[áa] en la carta/i]
  ]) {
    const msg = mensajeDeBloqueo({ errors: [{ code, message: "x" }] });
    assert.ok(esperado.test(msg), "el código " + code + " no se explica: " + msg);
    assert.ok(!/un dato pendiente/i.test(msg), "cae en el mensaje ciego: " + code);
  }
});

// ── G. La alergia del acompañante NO se queda en la ficha del titular ───────
// CASO REAL: "tengo un amigo con alergia a los langostinos" dejó "marisco" en
// la ficha de Samuel. Dos días después, su Abruzzo quedó bloqueada.
test("CASO REAL: 'tengo un amigo con alergia' es de un TERCERO", () => {
  assert.strictEqual(
    alergiaEsDeTercero("Eh, tengo un amigo con alergia a los langostinos y al marisco, ¿vale?"),
    true, "la alergia del amigo se guardaría otra vez en la ficha del titular");
});

test("otros acompañantes también se reconocen", () => {
  for (const f of [
    "mi mujer es alérgica a los frutos secos",
    "mi hijo tiene alergia al huevo",
    "una de las que viene no puede tomar gluten",
    "es para mi pareja, que no puede tomar lactosa"
  ]) assert.strictEqual(alergiaEsDeTercero(f), true, "no lo ve como de tercero: " + f);
});

test("si la alergia es SUYA, sí va a la ficha", () => {
  for (const f of [
    "soy alérgico al marisco",
    "yo soy celíaco",
    "tengo alergia a los frutos secos",
    "tengo intolerancia a la lactosa"
  ]) assert.strictEqual(alergiaEsDeTercero(f), false, "dejaría de guardar SU alergia: " + f);
});

test("una frase normal no se confunde con una alergia ajena", () => {
  assert.strictEqual(alergiaEsDeTercero("ponme una pizza para mi amigo"), true);
  assert.strictEqual(alergiaEsDeTercero("quiero dos pizzas"), false);
});

// ── E. El modelo ya ofreció en voz ──────────────────────────────────────────
test("CASO REAL: una oferta hecha en voz cuenta como ofrecida", () => {
  assert.strictEqual(upsellAlreadyOffered([
    A("¿Quieres que te ponga algo para picar, un entrante para compartir?")
  ]), true, "el gate repetiría la oferta que el cliente ya ha rechazado");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
