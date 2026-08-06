/**
 * test-llamadas-20260806.cjs
 *
 * Tres fallos detectados en llamadas reales del 06-08.
 *
 * A) "LA CALLE DE SIEMPRE" A UNA CLIENTA NUEVA (llamada de Pepa, 617691347):
 *      [agent] Pepa, ¿a qué dirección te lo llevo?
 *      [user]  Urbanización Altos del Rodeo, calle Río Volga, número 17.
 *      [agent] Pepa, ¿me confirmas la dirección para el domicilio?   ← ya se la dio
 *      [user]  Sí. Urbanización Altos del Rodeo, calle Río Polga, número 17.
 *      [agent] ¿Te lo llevo a la calle de siempre, la de siempre?    ← ¡es su 1ª vez!
 *    Dos causas: (1) el fallback `calle || "la calle de siempre"` metido en una
 *    frase que YA acaba en "la de siempre" producía la duplicación; (2) la
 *    directiva de dirección guardada se aplicaba a una dirección DICTADA en la
 *    llamada, no a una de su ficha.
 *
 * B) PLATO + INGREDIENTE TRATADO COMO PLATO INEXISTENTE:
 *      "una pizza de pepperoni CON alcaparras" → respondía que no tienen esa pizza
 *      y ofrecía una parecida, en vez de pepperoni + extra de alcaparras.
 *
 * C) La llamada de un cliente REGISTRADO (Samuel) sí funcionó: no debe romperse.
 *
 *   node test-llamadas-20260806.cjs
 */
const assert = require("assert");
const {
  direccionDadaEnLlamada,
  estadoDelPerfil,
  directivaDatosDelCliente,
  registeredCustomerDirective,
  buildSystemPrompt
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const U = c => ({ role: "user", content: c });

console.log("══ Llamadas reales 06-08 ═════════════════════════");

// ── A. La frase absurda ─────────────────────────────────────────────────────
test("CASO REAL: NUNCA se dice 'la calle de siempre, la de siempre'", () => {
  const p = buildSystemPrompt();
  assert.ok(!/la calle de siempre, la de siempre/i.test(p), "sigue la frase duplicada");
  const d = registeredCustomerDirective("Pepa", null);   // sin calle extraíble
  assert.ok(!/la calle de siempre, la de siempre/i.test(d), "la directiva la sigue generando");
});

test("sin calle legible se dice 'la dirección de siempre', sin duplicar", () => {
  const d = registeredCustomerDirective("Samuel Tineo", null);
  assert.ok(/la direcci[óo]n de siempre/i.test(d));
});

test("con calle legible sí se usa la fórmula con el nombre de la calle", () => {
  const d = registeredCustomerDirective("Samuel Tineo", "Calle Alpandeire número 3");
  assert.ok(/Calle Alpandeire/.test(d), "pierde la calle que sí sabemos");
});

// ── A2. Cliente NUEVO: no tiene "de siempre" ────────────────────────────────
test("CASO REAL: la dirección dictada en la llamada se detecta", () => {
  assert.strictEqual(
    direccionDadaEnLlamada([U("Urbanización Altos del Rodeo, calle Río Volga, número 17.")]),
    true);
});

test("una frase cualquiera NO se confunde con una dirección", () => {
  assert.strictEqual(direccionDadaEnLlamada([U("quiero 2 pizzas")]), false);
  assert.strictEqual(direccionDadaEnLlamada([U("me gustaría hacer un pedido")]), false);
});

test("CASO REAL: a un cliente NUEVO se le prohíbe decirle 'la de siempre'", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: false, nombre: "Pepa", direccion: "dicha_en_llamada",
    telefono: "617691347", tipoEntrega: "domicilio", yaPedidos: {}
  }));
  assert.ok(/PROHIBIDO decirle "la de siempre"|PROHIBIDO volver a pedírsela/.test(d),
    "puede volver a soltarle lo de la calle de siempre");
  assert.ok(/es la primera vez que pide/.test(d));
});

test("CASO REAL: dictada la dirección, ya NO consta como dato pendiente", () => {
  const e = estadoDelPerfil({
    registrado: false, nombre: "Pepa", direccion: "dicha_en_llamada",
    telefono: "617691347", tipoEntrega: "domicilio", yaPedidos: {}
  });
  assert.ok(!e.faltan.includes("dirección"), "se la volvería a pedir");
});

test("un cliente REGISTRADO sí conserva la fórmula 'la de siempre'", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: true, nombre: "Samuel Tineo", direccion: "Calle Alpandeire 3",
    telefono: "634425921", tipoEntrega: "domicilio", yaPedidos: {}
  }));
  assert.ok(/la de siempre/.test(d), "un habitual pierde el reconocimiento");
});

// ── B. Plato + ingrediente ──────────────────────────────────────────────────
test("CASO REAL: el prompt separa PLATO + INGREDIENTE en plato + extra", () => {
  const p = buildSystemPrompt();
  assert.ok(/PLATO \+ INGREDIENTE = PLATO CON UN EXTRA/.test(p), "falta la regla");
  assert.ok(/pepperoni CON alcaparras/.test(p), "no da el ejemplo del caso real");
  assert.ok(/PROHIBIDO responder que "esa pizza no la tenemos"/.test(p),
    "puede volver a rechazar un plato que sí existe");
});

test("los disparadores simples están recogidos", () => {
  const p = buildSystemPrompt();
  for (const d of ["CON", "PONLE", "ÉCHALE", "AÑÁDELE"]) {
    assert.ok(new RegExp('"' + d + '"').test(p), "falta el disparador: " + d);
  }
});

test("sigue rechazando lo que NO está en la carta de ninguna forma", () => {
  const p = buildSystemPrompt();
  assert.ok(/aros de cebolla/.test(p) && /No improvises productos/.test(p),
    "ahora aceptaría cualquier invento");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
