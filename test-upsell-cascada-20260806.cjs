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
  // 16-08: la frase del hueco ENTRANTE ya NO dice "picar/entrante". El owner la
  // cambió a la canónica de una sola pregunta ("...una bebida o un postre"),
  // así que aquí se comprueba lo que de verdad es invariante: que cada hueco
  // devuelve una frase propia, distinta, y que ninguna enumera marcas.
  const fEntrante = deterministicUpsellOffer(pedido("pizza_rossa"), []);
  const fBebida   = deterministicUpsellOffer(pedido("starters"), []);
  const fPostre   = deterministicUpsellOffer(pedido("starters", "beverages"), []);

  assert.ok(/bebida.*postre/i.test(fEntrante), "el hueco entrante no usa la frase canónica del owner");
  assert.ok(/beber/i.test(fBebida));
  assert.ok(/postre/i.test(fPostre));
  assert.strictEqual(new Set([fEntrante, fBebida, fPostre]).size, 3, "dos huecos comparten frase");

  // Ninguna oferta puede listar marcas ni productos concretos
  for (const f of [fEntrante, fBebida, fPostre]) {
    assert.ok(!/coca|cola|fanta|cerveza|tiramis|panna/i.test(f), "la oferta enumera productos: " + f);
  }
});

test("la frase de bebida es la CANÓNICA del contrato del prompt", () => {
  // test-system-prompt-contract exige "¿Te pongo algo de beber?" exactamente una
  // vez en el prompt. Si aquí se cambia la frase y allí no, la suite se rompe.
  assert.strictEqual(deterministicUpsellOffer(pedido("starters"), []), "¿Te pongo algo de beber?");
});

test("la oferta no enumera el menú entero (el postre queda para después)", () => {
  // REGLA DEL OWNER (16-08): UNA sola pregunta de upsell por llamada, con su
  // frase: "¿Quieres acompañar tu pedido con una bebida o un postre?".
  // Antes eran hasta tres rondas y el cliente tenía que decir "no" tres veces.
  const frase = deterministicUpsellOffer(pedido("pizza_rossa"), []);
  assert.strictEqual(frase, "¿Quieres acompañar tu pedido con una bebida o un postre?");
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
