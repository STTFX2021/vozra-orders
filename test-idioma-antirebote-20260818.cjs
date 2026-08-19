/**
 * IDIOMA — regla anti-rebote determinista (16-08)
 *
 * Comprueba COMPORTAMIENTO. Si alguien vuelve a borrar la detección de idioma del
 * código (como pasó el 28-06 con bd11a80), este test se pone rojo. El que había
 * entonces, f86d83f, sólo comprobaba que el modelo recibía un system prompt: por eso
 * la suite se quedó verde y la garantía estuvo dos meses desaparecida.
 *
 * La regla, tal y como está escrita en el prompt:
 *   - Idioma de apertura: español.
 *   - Sólo cambia con una frase ENTERA y CLARA en otro idioma.
 *   - Una palabra suelta o un préstamo ("ok", "ciao", "pizza") NO cambia nada.
 *   - Una vez establecido, se queda el resto de la llamada.
 */
require("dotenv").config();
const assert = require("assert");
const marta = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); console.log("  ok  " + nombre); pass++; }
  catch (e) { console.log("  FAIL " + nombre + "\n       " + (e.message || e).split("\n")[0]); fail++; }
}
const U = c => ({ role: "user", content: c });
const A = c => ({ role: "assistant", content: c });
const idioma = msgs => { const r = marta.idiomaDeLaLlamada(msgs); return r ? r.code : "es"; };

console.log("\n══ Idioma: la regla anti-rebote, en código ═══════");

// ── Lo que NO puede cambiar el idioma ──────────────────────────────────────
test("CASO REAL: 'ciao' suelto NO cambia el idioma", () => {
  assert.strictEqual(idioma([U("Hola, quiero una pizza"), U("ciao")]), "es");
});

test("CASO REAL: 'ok' suelto tampoco", () => {
  assert.strictEqual(idioma([U("Buenas, quería pedir"), U("ok")]), "es");
});

test("CASO REAL: 'un Margherita, por favor' sigue siendo español", () => {
  assert.strictEqual(idioma([U("un Margherita, por favor")]), "es");
});

test("los nombres de plato italianos no convierten la llamada en italiana", () => {
  assert.strictEqual(idioma([U("Ponme una Diavola y una Carbonara para recoger")]), "es");
});

test("una llamada normal en español se queda en español", () => {
  assert.strictEqual(idioma([
    U("Hola, quiero pedir para llevar"),
    A("¿Pasas a recogerlo o te lo llevamos?"),
    U("Me lo llevo yo"),
    U("Una Prosciutto y una Coca-Cola")
  ]), "es");
});

// ── Lo que SÍ lo cambia ────────────────────────────────────────────────────
test("una frase entera en inglés SÍ establece inglés", () => {
  assert.strictEqual(idioma([U("Hello, I would like to order a pizza please")]), "en");
});

test("y en francés, alemán, italiano y portugués también", () => {
  assert.strictEqual(idioma([U("Bonjour, je voudrais commander une pizza s'il vous plaît")]), "fr");
  assert.strictEqual(idioma([U("Hallo, ich möchte eine Pizza bestellen bitte")]), "de");
  assert.strictEqual(idioma([U("Buongiorno, vorrei ordinare una pizza per favore")]), "it");
  assert.strictEqual(idioma([U("Olá, gostaria de pedir uma pizza por favor")]), "pt");
});

// ── Y una vez establecido, SE QUEDA ────────────────────────────────────────
test("CRÍTICO: establecido el inglés, un 'ok' no lo devuelve al español", () => {
  assert.strictEqual(idioma([
    U("Hello, I would like to order a pizza please"),
    A("Sure! What would you like?"),
    U("ok")
  ]), "en", "rebotó al español con una palabra suelta");
});

test("tampoco lo devuelve el nombre de un plato español", () => {
  assert.strictEqual(idioma([
    U("Hi, can I order for delivery please"),
    U("Diavola")
  ]), "en");
});

test("pero una frase ENTERA en español sí lo devuelve", () => {
  assert.strictEqual(idioma([
    U("Hello, I would like to order a pizza please"),
    U("Perdona, mejor te lo digo en español, quiero una Margarita para recoger")
  ]), "es");
});

// ── La frase suelta: qué establece y qué no ────────────────────────────────
test("una frase de menos de tres palabras nunca establece idioma", () => {
  for (const t of ["ciao", "ok", "yes", "sí", "hello", "grazie"]) {
    assert.strictEqual(marta.idiomaDeFrase(t), null, "'" + t + "' no debería establecer nada");
  }
});

test("un turno vacío o basura no toca el idioma", () => {
  assert.strictEqual(idioma([U("Hello, I would like to order a pizza please"), U(""), U("   ")]), "en");
});

// ── El cableado: sin esto, la función no sirve de nada ─────────────────────
test("EL QUE IMPORTA: en inglés SE EMITE la directiva de idioma para el turno", () => {
  const d = marta.directivaDeIdioma([U("Hello, I would like to order a pizza please")]);
  assert.ok(d, "no se emitió ninguna directiva de idioma");
  assert.ok(/IDIOMA OBLIGATORIO/.test(d));
  assert.ok(/inglés/.test(d), "no nombra el idioma detectado");
  assert.ok(/no se traducen/i.test(d), "no protege los nombres de los platos");
  assert.ok(/cocina.*español/i.test(d), "la comanda a cocina debe seguir en español");
});

test("y en español NO se emite ninguna directiva (es el idioma por defecto)", () => {
  assert.strictEqual(marta.directivaDeIdioma([U("Hola, quiero una pizza para recoger")]), null);
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
