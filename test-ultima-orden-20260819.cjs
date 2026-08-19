/**
 * ÚLTIMA ORDEN — aviso al local, sin bloquear (decisión de sam 19-08, opción B)
 *
 * Comprueba COMPORTAMIENTO. Antes, `ultima_orden_min` sólo se interpolaba como
 * texto en el prompt (línea 616): cero cumplimiento.
 *
 * LA DECISIÓN QUE PROTEGE ESTE TEST: el pedido NO se bloquea. `submit_order` no
 * tiene campo de hora, así que "ofrece el turno siguiente" no se puede cumplir y un
 * gate duro sería un callejón sin salida que pierde la venta. Entra el pedido, el
 * ticket avisa, y decide el local. Si alguien lo convierte en bloqueo, esto falla.
 */
require("dotenv").config();
const assert = require("assert");
const marta = require("./marta-llm.service.js");
const { buildTextTicket } = require("./kitchen-ticket-builder.service.js");

let pass = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); console.log("  ok  " + nombre); pass++; }
  catch (e) { console.log("  FAIL " + nombre + "\n       " + (e.message || e).split("\n")[0]); fail++; }
}

// Estado de cocina de mentira: así el test no depende de la hora real.
const ks = (nowHHMM, ventanas, abierta = true) => ({
  openNow: abierta, nowHHMM,
  todayWindows: ventanas.map(([open, close]) => ({ open, close })),
  weekday: "lunes", nextOpen: null
});
const TURNOS = [["12:00", "16:00"], ["19:00", "24:00"]];

console.log("\n══ Última orden: avisa al local, no bloquea ══════");

// ── Cuándo avisa y cuándo no ───────────────────────────────────────────────
test("a 10 min del cierre SÍ avisa", () => {
  const a = marta.avisoUltimaOrden(ks("23:50", TURNOS), 30);
  assert.ok(a, "no avisó");
  assert.strictEqual(a.faltanMin, 10);
  assert.strictEqual(a.cierraHHMM, "24:00");
});

test("a 29 min avisa (justo por debajo del límite)", () => {
  assert.ok(marta.avisoUltimaOrden(ks("23:31", TURNOS), 30));
});

test("a 30 min EXACTOS ya no avisa (el límite no es aviso)", () => {
  assert.strictEqual(marta.avisoUltimaOrden(ks("23:30", TURNOS), 30), null);
});

test("a media tarde, en pleno turno, no avisa nada", () => {
  assert.strictEqual(marta.avisoUltimaOrden(ks("20:30", TURNOS), 30), null);
  assert.strictEqual(marta.avisoUltimaOrden(ks("13:00", TURNOS), 30), null);
});

test("el turno de comidas también cuenta: 15:45 avisa", () => {
  const a = marta.avisoUltimaOrden(ks("15:45", TURNOS), 30);
  assert.ok(a);
  assert.strictEqual(a.cierraHHMM, "16:00");
});

test("con la cocina CERRADA no avisa (el pedido es para la próxima apertura)", () => {
  assert.strictEqual(marta.avisoUltimaOrden(ks("17:30", TURNOS, false), 30), null);
});

test("FAIL-OPEN: sin horario legible no avisa, nunca al revés", () => {
  assert.strictEqual(marta.avisoUltimaOrden(null, 30), null);
  assert.strictEqual(marta.avisoUltimaOrden(ks("no-es-una-hora", TURNOS), 30), null);
  assert.strictEqual(marta.avisoUltimaOrden(ks("23:50", [["x", "y"]]), 30), null);
});

test("el límite es configurable por local", () => {
  assert.strictEqual(marta.avisoUltimaOrden(ks("23:40", TURNOS), 15), null, "con límite 15, a 20 min no se avisa");
  assert.ok(marta.avisoUltimaOrden(ks("23:40", TURNOS), 45), "con límite 45, a 20 min sí");
});

test("un turno que cruza medianoche se calcula bien", () => {
  const a = marta.avisoUltimaOrden(ks("01:40", [["20:00", "02:00"]]), 30);
  assert.ok(a, "no supo que el turno cierra a las 02:00 del día siguiente");
  assert.strictEqual(a.faltanMin, 20);
});

// ── LO QUE DE VERDAD DECIDIÓ SAM: avisa, NO bloquea ────────────────────────
test("EL QUE IMPORTA: el ticket lleva el aviso y nombra al encargado", () => {
  const order = {
    orderId: "ORD-TEST-1", orderType: "pickup", customerName: "Samuel", phone: "634425921",
    items: [{ name: "Margherita", quantity: 1 }],
    ultimaOrden: { faltanMin: 10, cierraHHMM: "24:00", limiteMin: 30 }
  };
  const t = buildTextTicket(order, { estimatedTotal: 12, currency: "EUR" });
  assert.ok(/FUERA DE ÚLTIMA ORDEN/.test(t), "el ticket no avisa");
  assert.ok(/ENCARGADO/i.test(t), "no dice que lo confirme el encargado");
  assert.ok(/10 min del cierre/.test(t), "no dice cuánto faltaba");
  assert.ok(/24:00/.test(t), "no dice a qué hora cierra");
  assert.ok(/DECIDE TÚ/.test(t), "no deja claro que la decisión es del local");
  assert.ok(/634425921/.test(t), "no da el teléfono para avisar al cliente");
});

test("y un pedido normal NO lleva ese aviso", () => {
  const order = {
    orderId: "ORD-TEST-2", orderType: "pickup", customerName: "Samuel", phone: "634425921",
    items: [{ name: "Margherita", quantity: 1 }]
  };
  const t = buildTextTicket(order, { estimatedTotal: 12, currency: "EUR" });
  assert.ok(!/FUERA DE ÚLTIMA ORDEN/.test(t), "avisó en un pedido que está en hora");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
