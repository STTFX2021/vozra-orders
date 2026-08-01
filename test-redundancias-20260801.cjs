/**
 * test-redundancias-20260801.cjs
 *
 * Dos redundancias vistas en la llamada conv_2001kyz8 (01-08):
 *
 * A) LA DIRECCIÓN, PREGUNTADA DOS VECES — el perfil YA la tenía:
 *      6 [agent] "¿Me confirmas la dirección a la que te lo llevo?"
 *      7 [user]  "Avenida Los Frutales, Aldea de la Luna, casa 137."
 *      8 [agent] "¿Te lo llevo a Avenida de los Frutales, la de siempre?"
 *    El contador anti-insistencia no la frenó porque "¿me confirmas la dirección?"
 *    no casaba con los patrones vigilados.
 *
 * B) OFRECE BEBIDA A QUIEN ACABA DE PEDIR BEBIDA:
 *     11 [user]  "Una prosciutto y una Coca-Cola."
 *     12 [agent] "Perfecto... ¿Te pongo algo de beber más?"
 *
 *   node test-redundancias-20260801.cjs
 */
const assert = require("assert");
const {
  vecesPedidoCadaDato,
  estadoDelPerfil,
  directivaDatosDelCliente,
  categoriasYaPedidas
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

console.log("══ Redundancias (conv_2001kyz8) ══════════════════");

// ── A. Dirección ────────────────────────────────────────────────────────────
test("CASO REAL: '¿me confirmas la dirección?' cuenta como pedir la dirección", () => {
  const c = vecesPedidoCadaDato([A("¿Me confirmas la dirección a la que te lo llevo?")]);
  assert.strictEqual(c["dirección"], 1, "no la contaba → no frenaba la segunda vez");
});

test("CASO REAL: las dos formas del transcript suman 2 → se frena", () => {
  const c = vecesPedidoCadaDato([
    A("¿Me confirmas la dirección a la que te lo llevo?"),
    A("¿Te lo llevo a Avenida de los Frutales, la de siempre?")
  ]);
  assert.strictEqual(c["dirección"], 2);
  const e = estadoDelPerfil({
    registrado: true, nombre: "Jodido cabezón", direccion: null,
    telefono: "679391554", tipoEntrega: "domicilio", yaPedidos: c
  });
  assert.deepStrictEqual(e.faltan, [], "la pediría una tercera vez");
});

test("otras formas de pedir la dirección también cuentan", () => {
  for (const frase of [
    "¿A qué dirección te lo llevamos?",
    "¿Me das la dirección?",
    "¿Cuál es tu dirección?",
    "¿Dónde te lo llevo?",
    "¿Me repites la dirección?"
  ]) {
    const c = vecesPedidoCadaDato([A(frase)]);
    assert.strictEqual(c["dirección"], 1, "no detecta: " + frase);
  }
});

test("con dirección guardada: prohibido preguntarla abierta, solo confirmar", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: true, nombre: null, direccion: "Avenida de los Frutales 14",
    telefono: "679391554", tipoEntrega: "domicilio", yaPedidos: {}
  }));
  assert.ok(/PROHIBIDO preguntarla abierta/.test(d), "puede volver a preguntarla");
  assert.ok(/la de siempre/.test(d), "no da la fórmula de confirmación");
});

test("sin dirección guardada NO se mete esa prohibición", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: false, nombre: null, direccion: null, telefono: null,
    tipoEntrega: "domicilio", yaPedidos: {}
  }));
  assert.ok(!/PROHIBIDO preguntarla abierta/.test(d), "impediría pedirla a un cliente nuevo");
});

// ── B. Upsell que ignora la comanda ─────────────────────────────────────────
test("CASO REAL: detecta que ya hay bebida en el pedido", () => {
  assert.deepStrictEqual(categoriasYaPedidas([U("Una prosciutto y una Coca-Cola.")]), ["bebida"]);
});

test("detecta las tres categorías", () => {
  assert.deepStrictEqual(
    categoriasYaPedidas([U("unas croquetas, una pizza, una cerveza y un tiramisú")]).sort(),
    ["bebida", "entrante", "postre"]);
});

test("un pedido solo de pizza no marca ninguna categoría", () => {
  assert.deepStrictEqual(categoriasYaPedidas([U("Una prosciutto y una margarita")]), []);
});

test("lo que ofrece el AGENTE no cuenta como pedido por el cliente", () => {
  assert.deepStrictEqual(categoriasYaPedidas([A("¿Te apetece un tiramisú de postre?")]), [],
    "creería que ya hay postre solo por haberlo ofrecido");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
