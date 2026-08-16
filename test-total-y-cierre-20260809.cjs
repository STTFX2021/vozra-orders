/**
 * test-total-y-cierre-20260809.cjs
 *
 * CASO REAL 09-08 (Samuel). Pidió UNA Abruzzo (15 €) y UNA Coca-Cola (2,50 €).
 * Total correcto: 17,50 €. Sarah dijo:
 *
 *     [agent] ...El total es treinta y dos euros. ¿Lo dejamos así?
 *
 * 32 = 15 + 15 + 2,50. Los productos se duplicaron, o el modelo se inventó el
 * total. Es lo único de la sesión que le cuesta DINERO a un cliente real.
 *
 * En la misma llamada, el cierre se disparó fuera de orden:
 *     [agent] Te confirmo que llevas un Abruzzo y una Coca-Cola...
 *     [user]  Sí, por f-                                    ← le corta
 *     [agent] Perfecto, tu pedido va a cocina. ¡Gracias!     ← DESPACHA
 *     [user]  Hasta luego.
 *     [agent] Samuel, te confirmo que llevas... El total es 32 euros. ¿Lo dejamos así?
 *     [agent] ¿Sigues ahí?  →  ¿algo más o lo cierro?  →  Resumen: ...
 *
 * O sea: despachó ANTES de la confirmación y siguió hablando DESPUÉS de despachar.
 *
 *   node test-total-y-cierre-20260809.cjs
 */
const assert = require("assert");
const marta = require("./marta-llm.service.js");
const store = require("./order-call-session.store.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}

const ABRUZZO = { menu_item_id: "pizza_abruzzo", quantity: 1 };
const COCA    = { menu_item_id: "coca_cola", quantity: 1 };

console.log("══ El total que se le dice al cliente ════════════");

test("CASO REAL: Abruzzo + Coca-Cola son 17,50 € y NO 32", () => {
  const q = marta.computeQuote(
    { items: [ABRUZZO, COCA], order_type: "delivery" }, [], "total-1");
  assert.strictEqual(q.ok, true, "el cálculo falla: " + JSON.stringify(q.errors || []));
  assert.strictEqual(q.total_eur, 17.5,
    "el total que oye el cliente es " + q.total_eur + " € en vez de 17,50 €");
});

test("CASO REAL: calcular DOS veces no duplica el pedido", () => {
  // El modelo llama a calcular_total varias veces en una llamada normal. Si el
  // draft acumulase en vez de reemplazar, el segundo total saldría al doble —
  // que es justo lo que se oyó (15 + 15 + 2,50 = 32,50 ≈ "treinta y dos").
  const call = "total-2";
  const args = { items: [ABRUZZO, COCA], order_type: "delivery" };
  const primera = marta.computeQuote(args, [], call);
  const segunda = marta.computeQuote(args, [], call);
  assert.strictEqual(segunda.total_eur, primera.total_eur,
    "recalcular duplica el pedido: " + primera.total_eur + " → " + segunda.total_eur);
  const s = store.getOrCreateOrderSession(call);
  assert.strictEqual((s.items || s.draftItems || []).length, 2,
    "la comanda tiene " + (s.items || s.draftItems || []).length + " líneas en vez de 2");
});

test("tres cálculos seguidos tampoco acumulan", () => {
  const call = "total-3";
  const args = { items: [ABRUZZO, COCA], order_type: "delivery" };
  let ultimo = null;
  for (let i = 0; i < 3; i++) ultimo = marta.computeQuote(args, [], call);
  assert.strictEqual(ultimo.total_eur, 17.5,
    "tras tres cálculos el total es " + ultimo.total_eur + " €");
});

test("dos Abruzzo SÍ suman lo que tienen que sumar", () => {
  const q = marta.computeQuote(
    { items: [{ menu_item_id: "pizza_abruzzo", quantity: 2 }, COCA], order_type: "delivery" },
    [], "total-4");
  assert.strictEqual(q.total_eur, 32.5, "dos Abruzzo y una Coca-Cola son 32,50 €");
});

// ── EL GUARDIÁN DE SALIDA ───────────────────────────────────────────────────
// "Que la LLM de gpt-4.1-mini no pueda decidir qué regla aplica o no: que nuestra
//  LLM customizada decida todo." — sam, 09-08
console.log("");
console.log("══ Lo que sale por la voz lo decide el código ════");

const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

test("CASO REAL: un total inventado se corrige con el real", () => {
  const call = "guard-1";
  marta.computeQuote({ items: [ABRUZZO, COCA], order_type: "delivery" }, [], call);
  const salida = marta.guardianDeSalida(
    "Te confirmo un Abruzzo y una Coca-Cola. El total es treinta y dos euros. ¿Lo dejamos así?",
    call, []);
  assert.ok(!/treinta y dos|32/.test(salida),
    "sigue saliendo por la voz un total que el código nunca calculó: " + salida);
});

test("un total CORRECTO no se toca", () => {
  const call = "guard-2";
  marta.computeQuote({ items: [ABRUZZO, COCA], order_type: "delivery" }, [], call);
  const salida = marta.guardianDeSalida("El total es 17,50 euros. ¿Confirmas?", call, []);
  assert.ok(/17[,.]5/.test(salida), "ha estropeado un total que estaba bien: " + salida);
});

test("CASO REAL: una pregunta ya respondida no llega a la voz", () => {
  const call = "guard-3";
  const conv = [A("¿Te pongo algo para picar, algo de beber?"), U("No, nada más.")];
  const salida = marta.guardianDeSalida(
    "Perfecto. ¿Quieres añadir algo más o seguimos con el pedido?", call, conv);
  assert.ok(!/algo m[áa]s/i.test(salida),
    "vuelve a preguntar lo mismo con otras palabras: " + salida);
});

test("una pregunta NUEVA sí pasa", () => {
  const call = "guard-4";
  const salida = marta.guardianDeSalida("¿A qué dirección te lo llevo?", call, []);
  assert.ok(/direcci/i.test(salida), "se ha comido una pregunta legítima: " + salida);
});

test("un turno normal pasa intacto", () => {
  const call = "guard-5";
  const txt = "Perfecto, te anoto una Abruzzo.";
  assert.strictEqual(marta.guardianDeSalida(txt, call, []), txt);
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
