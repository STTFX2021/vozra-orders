/**
 * test-conversacional-06-sin-order-type.cjs
 *
 * EL BACKEND NO PIDE LO QUE YA TIENE.
 *
 * CASO REAL 16-08 (Samuel). Con el código bueno desplegado y el CI en verde:
 *     [user]  Me gustaría hacer un pedido A DOMICILIO.
 *     [agent] Aquí estás, Samuel. ¿Te lo llevo a Calle Alpandeire, la de siempre?
 *     [user]  Sí, por favor.
 *     [agent] ¿Qué te gustaría pedir PARA TU DOMICILIO?
 *     [user]  Un Abruzzo, una mitad prosciutto mitad hawaiana, una B&B, una Ludi.
 *     [agent] Antes de calcular y resumir necesito saber si es para recoger o a domicilio.
 *     [user]  Te he dicho que era a domicilio.
 *     [agent] Antes de calcular y resumir necesito saber si es para recoger o a domicilio.
 *     [user]  Es a domicilio.
 *     [agent] Antes de calcular y resumir necesito saber si es para recoger o a domicilio.
 *
 * Esa frase la emite el BACKEND, no el modelo. `orderTypeValid` solo miraba
 * `args.order_type` — lo que el modelo incluye en esa llamada — e ignoraba la
 * sesión, donde el dato llevaba cuatro turnos.
 *
 * POR QUÉ NO LO CAZAMOS ANTES: todos los tests llamaban a computeQuote pasando
 * `order_type: "delivery"` a mano. El modelo real NO siempre lo manda. Este test
 * llama como llama él: SIN ese campo.
 *
 *   node test-conversacional-06-sin-order-type.cjs
 */
const assert = require("assert");
const marta = require("./marta-llm.service.js");
const store = require("./order-call-session.store.js");

let pass = 0, fail = 0;
const paso = (n, fn) => {
  try { fn(); console.log("   ✓ " + n); pass++; }
  catch (e) { console.log("   ✗ " + n + "\n        " + e.message); fail++; }
};
const U = c => ({ role: "user", content: c });
const A = c => ({ role: "assistant", content: c });

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  El modelo NO manda order_type. ¿Se atasca?          ║");
console.log("╚══════════════════════════════════════════════════════╝");

const CALL = "sin-ot-" + Date.now();
const conv = [
  A("Pizzería La Locanda, te atiende Sarah. ¿En qué puedo ayudarte?"),
  U("Me gustaría hacer un pedido a domicilio."),
  A("Perfecto, para empezar necesito un teléfono de contacto, por favor."),
  U("Es 634425921."),
  A("Aquí estás, Samuel. ¿Te lo llevo a Calle Alpandeire, la de siempre?"),
  U("Sí, por favor."),
  A("Muy bien, ¿qué te gustaría pedir para tu domicilio?"),
  U("Un Abruzzo y una Ludi.")
];

// La sesión, tal y como queda tras confirmar la dirección.
const s = store.getOrCreateOrderSession(CALL);
s.registeredName = "Samuel";
s.registeredPhone = "634425921";
s.registeredAddress = "Calle Alpandeire 3";

paso("el tipo de pedido se resuelve SIN que el modelo lo mande", () => {
  const items = [{ menu_item_id: "pizza_abruzzo", quantity: 1 }];
  // Ojo: SIN order_type, que es como llama el modelo de verdad.
  const q = marta.computeQuote({ items }, conv, CALL);
  assert.notStrictEqual(q.requiredAction, "resolve_order_type",
    "vuelve a preguntar si es para recoger o a domicilio teniéndolo desde el turno 1");
});

paso("y el cálculo sale adelante", () => {
  const q = marta.computeQuote(
    { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }] }, conv, CALL);
  assert.strictEqual(q.ok, true, "el pedido se queda bloqueado: " + JSON.stringify(q.errors || []));
  assert.strictEqual(q.total_eur, 15);
});

paso("CASO REAL: esa frase NO llega a la voz si ya está respondido", () => {
  const salida = marta.guardianDeSalida(
    "Antes de calcular y resumir necesito saber si es para recoger o a domicilio.",
    CALL, conv);
  assert.ok(!/recoger o a domicilio/i.test(salida),
    "el guardián sigue dejando pasar su propio mensaje: " + salida);
});

paso("confirmar la dirección YA implica que es a domicilio", () => {
  const soloDir = [
    A("¿Te lo llevo a Calle Alpandeire, la de siempre?"),
    U("Sí, por favor.")
  ];
  const call2 = "sin-ot2-" + Date.now();
  const s2 = store.getOrCreateOrderSession(call2);
  s2.registeredAddress = "Calle Alpandeire 3";
  const q = marta.computeQuote(
    { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }] }, soloDir, call2);
  assert.notStrictEqual(q.requiredAction, "resolve_order_type");
});

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  Pero si NO se sabe, sí se pregunta (una vez)        ║");
console.log("╚══════════════════════════════════════════════════════╝");

paso("cliente nuevo sin decir nada: ahí SÍ hay que preguntarlo", () => {
  const call3 = "sin-ot3-" + Date.now();
  const q = marta.computeQuote(
    { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }] },
    [U("Hola, quiero una pizza.")], call3);
  assert.strictEqual(q.requiredAction, "resolve_order_type",
    "da por hecho el tipo de pedido sin que nadie lo haya dicho");
});

paso("y si el cliente lo CAMBIA, manda lo nuevo", () => {
  const call4 = "sin-ot4-" + Date.now();
  const s4 = store.getOrCreateOrderSession(call4);
  s4.orderType = "delivery";
  const q = marta.computeQuote(
    { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }], order_type: "pickup" },
    [], call4);
  assert.strictEqual(q.ok, true);
  const ses = store.getOrCreateOrderSession(call4);
  assert.strictEqual(ses.orderType, "pickup",
    "ignora que el cliente ha cambiado a recogida");
});

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  Lo mismo con el resto de datos                      ║");
console.log("╚══════════════════════════════════════════════════════╝");

paso("teléfono, nombre y dirección también se resuelven de la sesión", () => {
  const src = require("fs").readFileSync(require.resolve("./marta-llm.service.js"), "utf8");
  assert.ok(/function resolverDeSesion/.test(src), "falta el resolutor común");
  for (const campo of ["phone", "customer_name", "address", "order_type"]) {
    assert.ok(new RegExp('case "' + campo + '"').test(src),
      "el resolutor no cubre: " + campo);
  }
});

console.log("\n" + "─".repeat(56));
console.log(pass + " pasos ok / " + fail + " fallidos");
process.exit(fail ? 1 : 0);
