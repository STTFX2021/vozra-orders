/**
 * test-conversacional-02-direccion-distinta.cjs
 *
 * LA FICHA ES RECURRENTE PERO DINÁMICA, NO RÍGIDA.
 *
 *   "Yo puedo llamar de casa de un amigo o de un familiar, y ese día lo quiero en
 *    esa dirección especial. Por eso se le pregunta: ¿te la llevo a la de siempre?"
 *                                                                  — sam, 09-08
 *
 * Un habitual llama desde casa de su madre. Se le reconoce, se le PREGUNTA por la
 * de siempre, dice que hoy no, da otra, y se usa esa — sin perder su ficha.
 *
 * Y la segunda llamada comprueba lo contrario: al día siguiente vuelve a pedir
 * desde su casa y la dirección guardada sigue siendo la suya de siempre.
 *
 *   node test-conversacional-02-direccion-distinta.cjs
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

const CASA   = "Calle Alpandeire 3";
const MADRE  = "Avenida del Mar 25, cuarto A";
const FICHA  = { name: "Samuel", address: { raw: CASA }, restrictions: { allergies: [], preferences: [] } };

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  Hoy pide desde casa de su madre                     ║");
console.log("╚══════════════════════════════════════════════════════╝");

const CALL = "conv2-" + Date.now();
const conv = [
  A("Pizzería La Locanda, te atiende Sarah. ¿En qué puedo ayudarte?"),
  U("Quiero un pedido a domicilio."),
  A("¿Me dices un teléfono de contacto?"),
  U("634425921")
];

paso("se le reconoce y se le PREGUNTA por la de siempre (no se asume)", () => {
  const d = marta.registeredCustomerDirective(FICHA.name, CASA);
  assert.ok(/Aqu[íi] est[áa]s, Samuel/.test(d), "no le reconoce");
  assert.ok(/Calle Alpandeire, la de siempre\?/.test(d),
    "no le pregunta: le impone la dirección guardada");
});

// ── Dice que hoy no ────────────────────────────────────────────────────────
conv.push(A("¿Te lo llevo a Calle Alpandeire, la de siempre?"));
conv.push(U("Hoy no, estoy en casa de mi madre: " + MADRE));

paso("la dirección nueva se detecta", () => {
  assert.strictEqual(marta.direccionDadaEnLlamada(conv), true);
});

paso("LO QUE DICE EN VIVO MANDA: se usa la de hoy, no la guardada", () => {
  const da = marta.resolveDeliveryAddress(MADRE, CASA);
  assert.ok(/Avenida del Mar/.test(da.raw),
    "sigue mandando el pedido a la dirección de siempre: " + da.raw);
  assert.strictEqual(da.number, "25");
});

paso("no se le vuelve a preguntar la dirección después de darla", () => {
  assert.strictEqual(marta.intencionYaCubierta(conv, "direccion"), true);
});

paso("el guardián tumba un segundo '¿a qué dirección?'", () => {
  const salida = marta.guardianDeSalida("Perfecto. ¿A qué dirección te lo llevo?", CALL, conv);
  assert.ok(!/a qu[ée] direcci/i.test(salida), "la vuelve a pedir: " + salida);
});

paso("tampoco se le pregunta si es domicilio o recogida", () => {
  const salida = marta.guardianDeSalida(
    "¿Quieres que te lo lleve a domicilio o prefieres pasar a recogerlo?", CALL, conv);
  assert.ok(!/recogerlo/i.test(salida), "repregunta el tipo de entrega: " + salida);
});

paso("y no se le repite el nombre en cada frase", () => {
  const p = marta.buildSystemPrompt(undefined, FICHA);
  assert.ok(/di su nombre SOLO al reconocerle al principio y al despedirte/i.test(p),
    "falta la regla de no abusar del nombre");
});

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  Mañana vuelve a pedir desde su casa                 ║");
console.log("╚══════════════════════════════════════════════════════╝");

paso("la ficha NO se ha sobrescrito: su dirección sigue siendo la suya", () => {
  // Pedir a otra dirección un día no cambia el domicilio habitual del cliente.
  const d = marta.registeredCustomerDirective(FICHA.name, FICHA.address.raw);
  assert.ok(/Calle Alpandeire/.test(d),
    "la dirección de un día suelto le ha pisado la de siempre");
});

paso("si la nueva no trae número, se conserva el de la guardada", () => {
  const da = marta.resolveDeliveryAddress("Calle Alpandeire", CASA);
  assert.strictEqual(da.number, "3", "pierde el número y se lo volvería a pedir");
});

paso("una dirección nueva SIN número sí obliga a pedir el número", () => {
  assert.strictEqual(marta.resolveDeliveryAddress("Calle Nueva", null).number, null);
});

console.log("\n" + "─".repeat(56));
console.log(pass + " pasos ok / " + fail + " fallidos");
process.exit(fail ? 1 : 0);
