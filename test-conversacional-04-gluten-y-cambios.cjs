/**
 * test-conversacional-04-gluten-y-cambios.cjs
 *
 * DOS ESCENARIOS EN UNA LLAMADA:
 *
 * A) CELÍACO. La base sin gluten NO se ofrece de oficio: solo cuando el cliente
 *    pregunta o menciona gluten / celiaquía / "sin TACC". Y siempre avisando del
 *    suplemento de 4,50 € por pizza ANTES de darla por hecha.
 *
 * B) CAMBIA DE OPINIÓN A MITAD. "Quita la Abruzzo y ponme dos Margaritas."
 *    El total y el resumen tienen que rehacerse, y NO se puede despachar el
 *    pedido viejo: si el cliente confirmó un resumen y luego cambió algo, hay que
 *    volver a leérselo. (Esto es lo que blinda test-transactional-authority, y
 *    casi lo rompo el 08-08 con el guardián de "una pregunta, una vez".)
 *
 *   node test-conversacional-04-gluten-y-cambios.cjs
 */
const assert = require("assert");
const marta = require("./marta-llm.service.js");

let pass = 0, fail = 0;
const paso = (n, fn) => {
  try { fn(); console.log("   ✓ " + n); pass++; }
  catch (e) { console.log("   ✗ " + n + "\n        " + e.message); fail++; }
};
const U = c => ({ role: "user", content: c });
const A = c => ({ role: "assistant", content: c });

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  A) El cliente dice que es celíaco                   ║");
console.log("╚══════════════════════════════════════════════════════╝");

paso("sin que él lo mencione, NO se le ofrece base sin gluten", () => {
  const p = marta.buildSystemPrompt();
  assert.ok(/NO preguntes de forma est[áa]ndar "¿base normal o sin gluten\?"/i.test(p) ||
            /asume SIEMPRE base normal/i.test(p),
    "ofrecería base sin gluten a todo el mundo");
});

paso("si él lo menciona, SÍ se le ofrece con su suplemento", () => {
  const p = marta.buildSystemPrompt();
  assert.ok(/Solo sacas el tema de la base sin gluten si el cliente menciona/i.test(p));
  assert.ok(/cuatro euros con cincuenta/i.test(p), "no avisa del suplemento de 4,50 €");
});

paso("'sin TACC' y 'apto celíacos' se reconocen como gluten", () => {
  const p = marta.buildSystemPrompt();
  assert.ok(/sin TACC/.test(p) && /SIN GLUTEN/.test(p),
    "no reconoce los sinónimos: un celíaco argentino se queda sin aviso");
});

paso("el gluten es INTRÍNSECO: no se puede 'quitar', se sustituye la base", () => {
  const onto = require("./allergen-ontology.service.js");
  const c = onto.classifyAllergen ? onto.classifyAllergen("GLUTEN", "pizza_margherita") : null;
  if (c) assert.notStrictEqual(c, "removable", "trataría el gluten como un topping");
  const p = marta.buildSystemPrompt();
  assert.ok(/si es GLUTEN, base sin gluten/i.test(p), "falta la sustitución del gluten");
});

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  B) Cambia el pedido después de oír el resumen       ║");
console.log("╚══════════════════════════════════════════════════════╝");

const CALL = "conv4-" + Date.now();
const ABRUZZO = { menu_item_id: "pizza_abruzzo", quantity: 1 };
const MARGHE  = { menu_item_id: "pizza_margherita", quantity: 2 };

const q1 = marta.computeQuote({ items: [ABRUZZO], order_type: "delivery" }, [], CALL);

paso("primer pedido: una Abruzzo, 15 €", () => {
  assert.strictEqual(q1.total_eur, 15);
});

const conv = [
  A("Resumen: 1 Abruzzo. Total 15 euros. ¿Está todo correcto y confirmas el pedido?"),
  U("Sí."),
  U("Espera, quita la Abruzzo y ponme dos Margaritas.")
];

const q2 = marta.computeQuote({ items: [MARGHE], order_type: "delivery" }, conv, CALL);

paso("cambiado el pedido, el total se rehace", () => {
  assert.notStrictEqual(q2.total_eur, 15, "sigue cobrando el pedido viejo");
  assert.ok(q2.total_eur > 0);
});

paso("el pedido NO acumula: dos Margaritas, no Abruzzo + Margaritas", () => {
  const s = require("./order-call-session.store.js").getOrCreateOrderSession(CALL);
  const items = s.items || s.draftItems || [];
  assert.ok(!items.some(i => /abruzzo/i.test(i.id || i.menu_item_id || "")),
    "la Abruzzo sigue en la comanda después de quitarla");
});

paso("CRÍTICO: la confirmación del resumen VIEJO no vale para el nuevo", () => {
  const viejo = "Resumen: 1 Abruzzo. Total 15 euros. ¿Está todo correcto y confirmas el pedido?";
  const nuevo = "Resumen: 2 Margherita. Total 18 euros. ¿Está todo correcto y confirmas el pedido?";
  assert.strictEqual(marta.mismoResumen(viejo, nuevo), false,
    "daría por confirmado un pedido que el cliente nunca oyó");
});

paso("y el guardián NO se salta el resumen nuevo", () => {
  // El resumen nuevo es distinto → no está "ya dicho" → hay que leérselo.
  assert.strictEqual(
    marta.yaSeDijoYRespondio(conv, "Resumen: 2 Margherita. Total 18 euros. ¿Confirmas?"),
    false, "despacharía sin leerle el pedido nuevo");
});

paso("un 'sí' con matiz NO autoriza el envío", () => {
  assert.strictEqual(marta.esAfirmacionSimple("Sí, pero añade una Coca-Cola"), false);
});

console.log("\n" + "─".repeat(56));
console.log(pass + " pasos ok / " + fail + " fallidos");
process.exit(fail ? 1 : 0);
