/**
 * test-nombre-compuesto-20260802.cjs
 *
 * Tres fallos del caso anonimizado de nombre compuesto y silencio:
 *
 * A) NOMBRE TRUNCADO. En la BD estaba bien ("Jodido cabezón"), pero la directiva
 *    cortaba por el primer espacio:
 *       4 [agent] "Aquí estás, Jodido."
 *      14 [agent] "...a nombre de Jodido."      ← así iba a COCINA
 *    El recorte a nombre de pila vale para "Samuel Tineo", no para un compuesto.
 *
 * B) CORRECCIÓN NO DETECTADA.
 *       7 [user] "mi nombre real es J. Es un nombre compuesto."
 *    El disparador era "mi nombre es", no "mi nombre REAL es".
 *
 * C) RESUMEN REPETIDO POR SILENCIO.
 *      14 [agent] "Te confirmo... ¿Lo dejamos así?"
 *      15 [user]  (vacío)
 *      16 [agent] "Te confirmo... ¿Lo dejamos así?"   ← lo repite entero
 *
 *   node test-nombre-compuesto-20260802.cjs
 */
const assert = require("assert");
const {
  nombreParaSaludar,
  nombreCorregidoEnLlamada,
  turnoDeUsuarioVacio,
  registeredCustomerDirective
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

console.log("══ Nombre compuesto y silencio (caso anonimizado) ═══");

// ── A. El nombre no se trocea ───────────────────────────────────────────────
test("CASO REAL: 'Jodido cabezón' NO se acorta a 'Jodido'", () => {
  assert.strictEqual(nombreParaSaludar("Jodido cabezón"), "Jodido cabezón");
});

test("un nombre formal SÍ se acorta al de pila", () => {
  assert.strictEqual(nombreParaSaludar("Samuel Tineo"), "Samuel");
  assert.strictEqual(nombreParaSaludar("María José Ferrer"), "María");
});

test("un nombre de una sola palabra se queda igual", () => {
  assert.strictEqual(nombreParaSaludar("Pedro"), "Pedro");
});

test("CASO REAL: la comanda lleva el nombre COMPLETO", () => {
  const d = registeredCustomerDirective("Jodido cabezón", "Avenida de los Frutales 14");
  assert.ok(/campo customer_name de submit_order pon su nombre COMPLETO: "Jodido cabezón"/.test(d),
    "la comanda seguiría saliendo truncada a cocina");
  assert.ok(!/customer_name de submit_order pon[^\n]*"Jodido"(?:[".])/.test(d),
    "la directiva permite mandar solo la primera palabra a cocina");
});

test("con nombre formal la comanda también lo lleva entero", () => {
  const d = registeredCustomerDirective("Samuel Tineo", "Calle Alpandeire 3");
  assert.ok(/"Samuel Tineo"/.test(d), "manda a cocina solo el nombre de pila");
  assert.ok(/Aqu[íi] est[áa]s, Samuel\.|est\\u00e1s, Samuel/.test(d) || /Samuel/.test(d));
});

// ── B. La corrección se detecta ─────────────────────────────────────────────
test("CASO REAL: detecta 'mi nombre real es ...'", () => {
  assert.strictEqual(
    nombreCorregidoEnLlamada([U("Eh, sí, pero mi nombre real es Jodido Cabezón.")]),
    "Jodido Cabezón");
});

test("detecta las demás variantes de corrección", () => {
  for (const [frase, esperado] of [
    ["mi nombre completo es Antonio Roldán", "Antonio Roldán"],
    ["mi nombre verdadero es Samuel Tineo", "Samuel Tineo"],
    ["me llamo Pedro Porro", "Pedro Porro"]
  ]) assert.strictEqual(nombreCorregidoEnLlamada([U(frase)]), esperado, "falla: " + frase);
});

test("una inicial suelta NO sobrescribe el nombre bueno", () => {
  // El STT devolvió "J" en la llamada real: guardarlo habría destrozado la ficha.
  assert.strictEqual(nombreCorregidoEnLlamada([U("mi nombre real es J.")]), null);
});

// ── C. Silencio ─────────────────────────────────────────────────────────────
test("CASO REAL: detecta el turno vacío del cliente", () => {
  assert.strictEqual(turnoDeUsuarioVacio([
    A("Te confirmo una Prosciutto y una Coca-Cola... ¿Lo dejamos así?"), U("")
  ]), true);
});

test("puntuación suelta también es silencio", () => {
  assert.strictEqual(turnoDeUsuarioVacio([A("¿Lo dejamos así?"), U("...")]), true);
  assert.strictEqual(turnoDeUsuarioVacio([A("¿Lo dejamos así?"), U("  ¿? ")]), true);
});

test("una respuesta de verdad NO es silencio", () => {
  assert.strictEqual(turnoDeUsuarioVacio([A("¿Lo dejamos así?"), U("Sí, por favor")]), false);
});

test("si el último turno es del agente, no aplica", () => {
  assert.strictEqual(turnoDeUsuarioVacio([U("hola"), A("¿Lo dejamos así?")]), false);
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
