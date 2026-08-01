/**
 * test-nombre-corregido-20260801.cjs
 *
 * REQUISITO DEL OWNER (01-08-2026):
 *   "cuando el cliente modifique algo, Sarah tiene que adaptarse y modificarlo también"
 *
 * CASO REAL (conv_5601kyyb…): el perfil del 679391554 tenía el nombre "el".
 *   4  [agent] "Aquí estás, el. ¿Te lo llevo a Avenida de los Frutales?"
 *   5  [user]  "...el nombre no, mi nombre es Antonio Roldán."
 *   7  [user]  "disculpa, mi nombre es Capullo Cabezón."
 *   8  [agent] "Perfecto, Antonio, dime qué te apetece pedir."      ← le sigue llamando Antonio
 *   9  [user]  "No, no, cámbiame el nombre, que mi nombre es Capullo Cabezón."
 *   10 [agent] "Perfecto, vamos con el pedido."                     ← lo ignora
 * Y la base de datos nunca se actualizó.
 *
 *   node test-nombre-corregido-20260801.cjs
 */
const assert = require("assert");
const {
  realCustomerName,
  nombreCorregidoEnLlamada,
  persistirNombreCorregido
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

const LLAMADA_REAL = [
  A("PizzeriaLaLocandaCancelada, te atiende Sarah, ¿en qué te puedo ayudar?"),
  U("Buenos días, me gustaría hacer un pedido para domicilio."),
  A("Perfecto, ¿me dices un teléfono de contacto para empezar?"),
  U("Sí, el 679391554."),
  A("Aquí estás, el. ¿Te lo llevo a Avenida de los Frutales, la de siempre?"),
  U("Eeeh, sí, la dirección la tienes bien, pero el nombre no, el no-- mi nombre es Antonio Roldán."),
  A("Muy bien, Antonio, vamos con el pedido. ¿Qué te gustaría pedir?"),
  U("Eh, disculpa, eh, mi nombre es Capullo Cabezón."),
  A("Perfecto, Antonio, dime qué te apetece pedir."),
  U("No, no, cámbiame el nombre, que mi nombre es Capullo Cabezón.")
];

console.log("══ El cliente manda sobre lo guardado ════════════");

test("CASO REAL: 'el' NO es un nombre válido (era el del perfil)", () => {
  assert.strictEqual(realCustomerName("el"), null, "seguiría diciendo 'Aquí estás, el.'");
});

test("otros restos de STT tampoco cuelan como nombre", () => {
  for (const n of ["la", "un", "sí", "no", "eh", "de", "que", "a", "-", "Cliente", "customer"])
    assert.strictEqual(realCustomerName(n), null, "acepta como nombre: " + n);
});

test("los nombres de verdad siguen pasando", () => {
  for (const n of ["Antonio Roldán", "Samuel Tineo", "Jo", "María José", "O'Connor"])
    assert.strictEqual(realCustomerName(n), n, "rechaza un nombre válido: " + n);
});

test("CASO REAL: se detecta la corrección y gana la ÚLTIMA", () => {
  assert.strictEqual(nombreCorregidoEnLlamada(LLAMADA_REAL), "Capullo Cabezón");
});

test("detecta las distintas formas de corregir el nombre", () => {
  const casos = [
    ["Me llamo Antonio Roldán", "Antonio Roldán"],
    ["mi nombre es Samuel Tineo", "Samuel Tineo"],
    ["ponlo a nombre de Lucía Ferrer", "Lucía Ferrer"],
    ["cámbiame el nombre, que mi nombre es Capullo Cabezón", "Capullo Cabezón"]
  ];
  for (const [frase, esperado] of casos)
    assert.strictEqual(nombreCorregidoEnLlamada([U(frase)]), esperado, "falla con: " + frase);
});

test("sin corrección explícita no inventa un nombre", () => {
  assert.strictEqual(nombreCorregidoEnLlamada([
    U("Quiero una pizza prosciutto"), U("Sí, por favor"), U("Para domicilio")
  ]), null);
});

test("lo que dice el AGENTE no cuenta como corrección del cliente", () => {
  assert.strictEqual(nombreCorregidoEnLlamada([A("Muy bien, Antonio, vamos con el pedido.")]), null);
});

test("no persiste un nombre inválido en la base de datos", async () => {
  const r = await persistirNombreCorregido("el", [U("mi telefono es 679391554")], null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, "nombre_no_valido");
});

test("sin teléfono no se puede persistir (y no revienta)", async () => {
  const r = await persistirNombreCorregido("Capullo Cabezón", [U("hola")], null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, "sin_telefono");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  ok  " + name); pass++; }
    catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
  }
  console.log("");
  console.log(pass + " ok / " + fail + " fail");
  process.exit(fail ? 1 : 0);
})();
