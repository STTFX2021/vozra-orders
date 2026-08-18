/**
 * ZONA DE REPARTO — gate determinista (16-08)
 *
 * Este test comprueba COMPORTAMIENTO, no texto del prompt.
 * Falla si alguien quita el gate, aunque el prompt siga diciendo lo correcto.
 *
 * Agujero que cierra: `validar_direccion` devolvía dentro_de_zona=false y el prompt
 * le PEDÍA al modelo que ofreciera recogida. Nada impedía que llamara igualmente a
 * submit_order: un reparto a 12 km entraba en cocina. De los 14 gates deterministas
 * que existían, ninguno miraba la zona.
 */
require("dotenv").config();
const assert = require("assert");
const marta = require("./marta-llm.service.js");
const store = require("./order-call-session.store.js");

let pass = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); console.log("  ok  " + nombre); pass++; }
  catch (e) { console.log("  FAIL " + nombre + "\n       " + (e.message || e).split("\n")[0]); fail++; }
}
async function testAsync(nombre, fn) {
  try { await fn(); console.log("  ok  " + nombre); pass++; }
  catch (e) { console.log("  FAIL " + nombre + "\n       " + (e.message || e).split("\n")[0]); fail++; }
}

const DIR_LEJOS = "Calle Inventada 99, Nerja";
const DIR_CERCA = "Calle Alpandeire 3, Cancelada";

const pedidoBase = (extra = {}) => Object.assign({
  items: [{ menu_item_id: "pizza_bb", quantity: 1 }],
  order_type: "delivery",
  customer_name: "Samuel",
  phone: "634425921",
  address: DIR_LEJOS,
  payment_method: "cash"
}, extra);

console.log("\n══ Zona de reparto: el gate que faltaba ══════════");

// ── 1. La decisión pura ────────────────────────────────────────────────────
test("un domicilio fuera de zona SÍ se bloquea", () => {
  assert.strictEqual(
    marta.zonaFueraDeReparto(
      { orderType: "delivery", address: { raw: DIR_LEJOS } },
      { zoneStatus: "out_of_zone", zoneAddress: null }
    ), true);
});

test("dentro de zona NO se bloquea", () => {
  assert.strictEqual(
    marta.zonaFueraDeReparto(
      { orderType: "delivery", address: { raw: DIR_CERCA } },
      { zoneStatus: "in_zone", zoneAddress: null }
    ), false);
});

test("FAIL-OPEN: 'unknown' no bloquea (un fallo de geocodificación no cuesta una venta)", () => {
  for (const estado of ["unknown", "not_required", null, undefined]) {
    assert.strictEqual(
      marta.zonaFueraDeReparto(
        { orderType: "delivery", address: { raw: DIR_LEJOS } },
        { zoneStatus: estado }
      ), false, "el estado '" + estado + "' no debería bloquear");
  }
});

test("una RECOGIDA nunca se bloquea por zona, aunque el veredicto sea malo", () => {
  assert.strictEqual(
    marta.zonaFueraDeReparto(
      { orderType: "pickup", address: { raw: DIR_LEJOS } },
      { zoneStatus: "out_of_zone" }
    ), false);
});

// ── 2. El veredicto caduca si cambia la dirección ──────────────────────────
test("CRÍTICO: un 'fuera de zona' de OTRA dirección no bloquea la nueva", () => {
  assert.strictEqual(
    marta.zonaFueraDeReparto(
      { orderType: "delivery", address: { raw: DIR_CERCA } },
      { zoneStatus: "out_of_zone", zoneAddress: "calle inventada 99 nerja" }
    ), false, "bloqueó con un veredicto caduco de una dirección anterior");
});

test("y el veredicto SÍ vale para la dirección sobre la que se calculó", () => {
  assert.strictEqual(
    marta.zonaFueraDeReparto(
      { orderType: "delivery", address: { raw: "CALLE INVENTADA 99, NERJA" } },
      { zoneStatus: "out_of_zone", zoneAddress: "calle inventada 99 nerja" }
    ), true, "mayúsculas y puntuación no deberían romper la comparación");
});

test("sin dirección no se bloquea por zona (de eso se ocupa el gate de validación)", () => {
  assert.strictEqual(
    marta.zonaFueraDeReparto(
      { orderType: "delivery", address: null },
      { zoneStatus: "out_of_zone" }
    ), false);
});

// ── 3. El efecto real: no llega a cocina ───────────────────────────────────
(async () => {
  await testAsync("EL QUE IMPORTA: submit_order fuera de zona NO despacha", async () => {
    store.clearAllSessionsForTests();
    const callId = "zona-fuera";
    store.getOrCreateOrderSession(callId);
    store.updateOrderSession(callId, { zoneStatus: "out_of_zone", zoneAddress: null });

    const r = await marta.handleSubmitOrder(callId, pedidoBase(), [
      { role: "user", content: "Sí, confirmo" }
    ]);

    assert.strictEqual(r.ok, false, "el pedido salió adelante estando fuera de zona");
    assert.strictEqual(r.delivered, false, "SE DESPACHÓ un reparto imposible");
    assert.strictEqual(r.requiredAction, "resolve_delivery_zone");
    assert.strictEqual(r.reason, "delivery_zone_out");
  });

  await testAsync("el bloqueo DICE qué pasa y ofrece la salida (regla del owner 08-08)", async () => {
    store.clearAllSessionsForTests();
    const callId = "zona-mensaje";
    store.getOrCreateOrderSession(callId);
    store.updateOrderSession(callId, { zoneStatus: "out_of_zone", zoneAddress: null });

    const r = await marta.handleSubmitOrder(callId, pedidoBase(), []);
    assert.ok(/zona de reparto|no llegamos/i.test(r.reply), "no dice cuál es el problema");
    assert.ok(/recoger|recogerlo|local/i.test(r.reply), "no ofrece la alternativa de recogida");
  });

  await testAsync("ANTI-BUCLE: pasarse a recogida desbloquea el pedido solo", async () => {
    store.clearAllSessionsForTests();
    const callId = "zona-recogida";
    store.getOrCreateOrderSession(callId);
    store.updateOrderSession(callId, { zoneStatus: "out_of_zone", zoneAddress: null });

    const bloqueado = await marta.handleSubmitOrder(callId, pedidoBase(), []);
    assert.strictEqual(bloqueado.requiredAction, "resolve_delivery_zone");

    // El cliente acepta pasarse a recogerlo. El mismo veredicto de zona sigue en la
    // sesión, pero ya no aplica: si esto vuelve a bloquear, hay bucle.
    const r = await marta.handleSubmitOrder(callId, pedidoBase({ order_type: "pickup", address: null }), []);
    assert.notStrictEqual(r.requiredAction, "resolve_delivery_zone",
      "siguió bloqueando por zona a un cliente que ya se pasó a recogida = BUCLE");
  });

  await testAsync("dentro de zona el pedido sigue su curso normal", async () => {
    store.clearAllSessionsForTests();
    const callId = "zona-ok";
    store.getOrCreateOrderSession(callId);
    store.updateOrderSession(callId, { zoneStatus: "in_zone", zoneAddress: null });

    const r = await marta.handleSubmitOrder(callId, pedidoBase({ address: DIR_CERCA }), []);
    assert.notStrictEqual(r.requiredAction, "resolve_delivery_zone",
      "bloqueó por zona un pedido que SÍ está dentro");
  });

  console.log("");
  console.log(pass + " ok / " + fail + " fail");
  process.exit(fail ? 1 : 0);
})();
