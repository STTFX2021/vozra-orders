/**
 * HONESTIDAD DEL GUARDIÁN — lo que Sarah NO puede decir nunca (20-08)
 *
 * Origen: llamada real de prueba con un cliente inventado, "Pedro Porro", que NO
 * existía en la base de datos. Sarah dijo "Aquí estás, Pedro" y "la dirección de
 * siempre", y después se inventó una excusa de privacidad para tapar que le
 * faltaban datos. El código SÍ sabía la verdad: buscar_cliente había devuelto
 * encontrado:false. La prohibición existía... en el prompt. Mismo patrón que
 * bd11a80: la regla estaba escrita, el mecanismo no existía.
 *
 * Y al auditarlo apareció algo peor: el guardián de importes comparaba CUALQUIER
 * importe contra el total y reescribía al total todo lo que no cuadrase. El
 * mensaje que genera el propio backend — "El pedido tiene cuatro euros con
 * cincuenta de suplementos" — salía por la voz diciendo el total del pedido.
 * El guardián que impide importes inventados estaba inventando importes.
 *
 * ESTE TEST COMPRUEBA COMPORTAMIENTO, NO TEXTO DE PROMPT. Se pone rojo si alguien
 * quita los filtros del guardián o vuelve a comparar solo contra el total.
 */
require("dotenv").config();
const assert = require("assert");
const marta = require("./marta-llm.service.js");
const { getOrCreateOrderSession } = require("./order-call-session.store.js");

let pass = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); console.log("  ok  " + nombre); pass++; }
  catch (e) { console.log("  FAIL " + nombre + "\n       " + (e.message || e).split("\n")[0]); fail++; }
}

let _n = 0;
/** Llamada de mentira con el estado que haga falta. */
function sesion(campos) {
  const call = "test-honestidad-" + (++_n);
  const o = getOrCreateOrderSession(call);
  Object.assign(o, campos);
  return call;
}
const NUEVO = { registeredFound: false, quotedTotal: 20.50 };
const CONOCIDO = { registeredFound: true, registeredName: "Samuel", quotedTotal: 20.50 };

console.log("\n══ Honestidad: lo que Sarah no puede decir ═══════");

// ── 1. No se reconoce a quien no conocemos ─────────────────────────────────
test("EL CASO PEDRO PORRO: no saluda por su nombre a un cliente que no existe", () => {
  const c = sesion(NUEVO);
  const out = marta.guardianDeSalida("Aquí estás, Pedro. ¿Es para recoger o a domicilio?", c, []);
  assert.ok(!/aqu[ií] est[aá]s/i.test(out), "reconoció a un desconocido: " + out);
  assert.ok(/recoger o a domicilio/i.test(out), "se llevó por delante la pregunta buena: " + out);
});

test("no le ofrece 'la dirección de siempre' a un cliente sin ficha", () => {
  const c = sesion(NUEVO);
  const out = marta.guardianDeSalida("Te lo llevo a la dirección de siempre. ¿Te parece?", c, []);
  assert.ok(!/de siempre/i.test(out), "prometió una dirección que no tiene: " + out);
});

test("tampoco 'lo de siempre' ni 'tu pedido habitual'", () => {
  const c = sesion(NUEVO);
  assert.ok(!/de siempre/i.test(marta.guardianDeSalida("¿Te pongo lo de siempre?", c, [])));
  const c2 = sesion(NUEVO);
  assert.ok(!/habitual/i.test(marta.guardianDeSalida("¿Quieres tu pedido habitual?", c2, [])));
});

test("ni dice tener datos guardados que no tiene", () => {
  const c = sesion(NUEVO);
  const out = marta.guardianDeSalida("Veo que tienes guardada una alergia al gluten.", c, []);
  assert.ok(!/tienes guardada/i.test(out), "se inventó la ficha: " + out);
});

test("EL LÍMITE: a un cliente que SÍ está registrado no le borra el reconocimiento", () => {
  const c = sesion(CONOCIDO);
  const out = marta.guardianDeSalida("Aquí estás, Samuel. ¿A la dirección de siempre?", c, []);
  assert.ok(/aqu[ií] est[aá]s/i.test(out), "borró un saludo legítimo: " + out);
  assert.ok(/de siempre/i.test(out), "borró una pregunta legítima: " + out);
});

// ── 2. Nada de excusas de privacidad ───────────────────────────────────────
test("no se excusa en la privacidad para tapar un dato que le falta", () => {
  const c = sesion(NUEVO);
  const out = marta.guardianDeSalida("Por privacidad no puedo confirmarte la dirección. ¿Me la dices?", c, []);
  assert.ok(!/privacidad/i.test(out), "mintió con voz profesional: " + out);
  assert.ok(/me la dices/i.test(out), "borró la petición buena: " + out);
});

test("tampoco 'por motivos de seguridad' ni 'protección de datos'", () => {
  const c = sesion(NUEVO);
  assert.ok(!/seguridad/i.test(marta.guardianDeSalida("Por motivos de seguridad no puedo dártelo. Dime tu teléfono.", c, [])));
  const c2 = sesion(CONOCIDO);
  assert.ok(!/protecci[oó]n de datos/i.test(marta.guardianDeSalida("La protección de datos me lo impide. Dime tu teléfono.", c2, [])));
});

test("la excusa se borra también a un cliente registrado (no existe tal norma para nadie)", () => {
  const c = sesion(CONOCIDO);
  const out = marta.guardianDeSalida("Por privacidad no puedo decirte esa información. Sigo.", c, []);
  assert.ok(!/privacidad/i.test(out), "la excusa sobrevivió: " + out);
});

// ── 3. Los importes: vale lo que calculó el código, no solo el total ───────
test("EL DE SIEMPRE: un total inventado se corrige al total real", () => {
  const c = sesion({ ...NUEVO, quotedTotal: 17.50 });
  const out = marta.guardianDeSalida("El total es treinta y dos euros.", c, []);
  assert.ok(!/treinta y dos/i.test(out), "dejó pasar el importe inventado: " + out);
  assert.ok(/17|diecisiete/i.test(out), "no puso el real: " + out);
});

test("EL QUE IMPORTA: un suplemento calculado por el código NO se reescribe al total", () => {
  const c = sesion({ registeredFound: true, quotedTotal: 20.50, quotedSurchargeTotal: 4.50,
    quotedSurcharges: [{ extra: "base sin gluten", importe_eur: 4.50 }] });
  const out = marta.guardianDeSalida("El pedido tiene cuatro euros con cincuenta de suplementos en total.", c, []);
  assert.ok(/cuatro euros con cincuenta/i.test(out),
    "el guardian corrompio un mensaje que genera el propio backend: " + out);
});

test("un precio de línea del pedido tampoco se reescribe", () => {
  const c = sesion({ registeredFound: true, quotedTotal: 20.50, items: [{ displayName: "Abruzzo", price: 15 }] });
  const out = marta.guardianDeSalida("La Abruzzo son quince euros.", c, []);
  assert.ok(/quince euros/i.test(out), "reescribió un precio legítimo: " + out);
});

test("'y cincuenta céntimos' se entiende igual que 'con cincuenta'", () => {
  const c = sesion({ registeredFound: true, quotedTotal: 20.50 });
  const out = marta.guardianDeSalida("El total es veinte euros y cincuenta céntimos.", c, []);
  assert.ok(!/20 euros con 50 y/i.test(out), "lo partió por la mitad: " + out);
  assert.ok(/veinte euros y cincuenta/i.test(out), "corrigió un importe correcto: " + out);
});

test("FAIL-CLOSED: un importe que no sabe leer NO se deja pasar", () => {
  const c = sesion({ registeredFound: true, quotedTotal: 20.50 });
  const out = marta.guardianDeSalida("Son mil doscientos euros.", c, []);
  assert.ok(!/mil doscientos/i.test(out), "se coló un importe que no sabe leer: " + out);
});

test("seiscientos en adelante también se caza", () => {
  const c = sesion({ registeredFound: true, quotedTotal: 20.50 });
  const out = marta.guardianDeSalida("Serían seiscientos euros.", c, []);
  assert.ok(!/seiscientos/i.test(out), "pasó intacto: " + out);
});

// ── 4. El teléfono BLOQUEA (antes solo avisaba y despachaba igual) ────────
const validator = require("./order-validator.service.js");

test("EL BUG: un teléfono de 7 dígitos ya NO pasa como bueno", () => {
  const r = validator.validatePhone("6344259");
  assert.strictEqual(r.errors.length, 1, "no lo bloqueó");
  assert.strictEqual(r.errors[0].requiredAction, "resolve_phone");
});

test("un móvil español de 9 dígitos pasa, con espacios o con +34", () => {
  for (const t of ["634425921", "634 42 59 21", "+34634425921", "912345678"]) {
    assert.strictEqual(validator.validatePhone(t).errors.length, 0, "bloqueó uno bueno: " + t);
  }
});

test("EL LÍMITE: un turista con número extranjero válido NO se queda sin cenar", () => {
  assert.strictEqual(validator.validatePhone("+447911123456").errors.length, 0,
    "bloqueó un número británico válido");
});

test("y el error llega hasta validateOrder como bloqueo real, no como aviso", () => {
  const order = {
    orderType: "pickup", customerName: "Pedro", phone: "6344259",
    items: [{ menu_item_id: "no_existe", quantity: 1 }]
  };
  const v = validator.validateOrder(order);
  assert.strictEqual(v.ok, false, "el pedido se dio por válido");
  assert.ok(v.errors.some(e => e.code === "PHONE_LENGTH"),
    "el teléfono malo no llegó a errors: " + JSON.stringify(v.errors.map(e => e.code)));
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
