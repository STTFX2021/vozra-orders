/**
 * test-upsell-cascada-20260806.cjs
 *
 * REGLA DEL OWNER (06-08): el upselling es OBLIGATORIO, pero NO se ofrece lo que
 * el cliente ya lleva. Orden de prioridad, así se hace en barra:
 *
 *      1º ENTRANTE  →  2º BEBIDA  →  3º POSTRE
 *
 * Se ofrece la PRIMERA categoría que no esté en el pedido. Si ya lleva las tres,
 * no se sugiere nada y el upselling se da por resuelto (NUNCA se bloquea el pedido
 * por no poder ofrecer algo).
 *
 * Antes: `deterministicUpsellOffer()` soltaba "¿una bebida, un postre o un entrante?"
 * a todo el mundo, sin mirar la comanda. A quien pedía una Coca-Cola le ofrecía
 * otra bebida.
 *
 *   node test-upsell-cascada-20260806.cjs
 */
const assert = require("assert");
const {
  siguienteUpsell,
  categoriasEnPedido,
  deterministicUpsellOffer,
  UPSELL_PRIORIDAD
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const U = c => ({ role: "user", content: c });
const pedido = (...cats) => ({ items: cats.map(c => ({ category: c })) });

console.log("══ Upselling en cascada (entrante → bebida → postre) ══");

test("la prioridad es entrante, bebida, postre", () => {
  assert.deepStrictEqual(UPSELL_PRIORIDAD, ["entrante", "bebida", "postre"]);
});

// ── Solo pizza: se empieza por el entrante ─────────────────────────────────
test("pedido solo de pizza → se ofrece ENTRANTE", () => {
  assert.strictEqual(siguienteUpsell(pedido("pizza_rossa"), []), "entrante");
});

// ── CASO REAL: ya hay bebida ────────────────────────────────────────────────
test("CASO REAL: pizza + Coca-Cola → NO se ofrece otra bebida", () => {
  const cat = siguienteUpsell(pedido("pizza_rossa", "beverages"), []);
  assert.notStrictEqual(cat, "bebida", "vuelve a ofrecer bebida a quien ya la lleva");
  assert.strictEqual(cat, "entrante", "debería seguir el orden y ofrecer el entrante");
});

test("con entrante y bebida ya pedidos → toca POSTRE", () => {
  assert.strictEqual(siguienteUpsell(pedido("pizza_rossa", "starters", "beverages"), []), "postre");
});

test("con entrante y postre ya pedidos → toca BEBIDA", () => {
  assert.strictEqual(siguienteUpsell(pedido("starters", "desserts"), []), "bebida");
});

// ── El caso que podía bloquear el pedido ───────────────────────────────────
test("con las TRES categorías → no hay nada que ofrecer (no se bloquea)", () => {
  const p = pedido("pizza_rossa", "starters", "beverages", "desserts");
  assert.strictEqual(siguienteUpsell(p, []), null);
  assert.strictEqual(deterministicUpsellOffer(p, []), null,
    "devolvería una frase y el pedido se quedaría esperando un upsell imposible");
});

// ── Las ensaladas cuentan como entrante ────────────────────────────────────
test("una ensalada cuenta como entrante", () => {
  assert.ok(categoriasEnPedido(pedido("salads")).has("entrante"));
});

// ── Respaldo por texto, si los items aún no tienen categoría ───────────────
test("si el item no trae categoría, se lee de lo que dijo el cliente", () => {
  const cat = siguienteUpsell({ items: [] }, [U("una prosciutto y una Coca-Cola")]);
  assert.notStrictEqual(cat, "bebida", "ignora que ya pidió bebida de viva voz");
});

// ── Las frases ─────────────────────────────────────────────────────────────
test("cada categoría tiene su frase y NO enumera productos", () => {
  assert.ok(/picar|entrante/i.test(deterministicUpsellOffer(pedido("pizza_rossa"), [])));
  assert.ok(/beber/i.test(deterministicUpsellOffer(pedido("starters"), [])));
  assert.ok(/postre/i.test(deterministicUpsellOffer(pedido("starters", "beverages"), [])));
  // No debe listar marcas ni productos concretos en bebida
  assert.ok(!/coca|cola|fanta|cerveza/i.test(deterministicUpsellOffer(pedido("starters"), [])));
});

test("la frase de bebida es la CANÓNICA del contrato del prompt", () => {
  // test-system-prompt-contract exige "¿Te pongo algo de beber?" exactamente una
  // vez en el prompt. Si aquí se cambia la frase y allí no, la suite se rompe.
  assert.strictEqual(deterministicUpsellOffer(pedido("starters"), []), "¿Te pongo algo de beber?");
});

test("la oferta no enumera el menú entero (el postre queda para después)", () => {
  // REGLA DEL OWNER (08-08): una sola pregunta que cubra picar Y beber. Antes
  // eran dos rondas y el cliente tenía que decir "no" dos veces. Lo que sigue
  // prohibido es soltarle las TRES categorías de golpe.
  const frase = deterministicUpsellOffer(pedido("pizza_rossa"), []);
  assert.ok(/picar/i.test(frase) && /beber/i.test(frase),
    "la oferta ya no cubre picar y beber a la vez: " + frase);
  assert.ok(!/postre/i.test(frase), "suelta el menú entero: " + frase);
});

// ── El prompt refleja la misma regla ───────────────────────────────────────
test("el prompt lleva el mismo orden de prioridad", () => {
  const { buildSystemPrompt } = require("./marta-llm.service.js");
  const p = buildSystemPrompt();
  assert.ok(/1º ENTRANTE/.test(p) && /2º BEBIDA/.test(p) && /3º POSTRE/.test(p),
    "el prompt no refleja la prioridad");
  assert.ok(/PROHIBIDO ofrecer una categoría que el cliente YA ha pedido/.test(p));
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
