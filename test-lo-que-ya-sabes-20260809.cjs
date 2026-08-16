/**
 * test-lo-que-ya-sabes-20260809.cjs
 *
 * "Sigue haciendo preguntas repetitivas y mal. No sale ni una llamada bien, y son
 *  datos simples del mismo cliente."                              — sam, 09-08
 *
 * CASO REAL (Tano, 627186903). TRES sugerencias seguidas, cada una con un texto
 * distinto — por eso el guardián que compara TEXTO no las cazaba:
 *     [agent] ¿Quieres añadir algo más o seguimos con el pedido?
 *     [user]  Eh, no, nada más.
 *     [agent] ¿Te pongo algo para picar, un entrante para compartir?
 *     [user]  No.
 *     [agent] ¿Quieres que te ponga algo para picar, algo de beber?
 *     [user]  Que no.
 *
 * Y en la misma llamada, dos síntomas del MISMO fallo (preguntar lo que ya tiene):
 *     [user]  Plaza de los Infantes, edificio 5, segundo C.
 *     [agent] ¿Te lo llevo a Plaza de los Infantes, la de siempre?   ← acaba de dictarla
 *
 * CASO REAL (Samuel, 634425921), pedido de reposición:
 *     [agent] ¿Quieres que te lo lleve a Calle Alpandeire, la de siempre?
 *     [user]  Sí, por favor.
 *     [agent] ¿Quieres que te lo lleve a domicilio o prefieres pasar a recogerlo?
 *                                                    ← ya había confirmado dirección
 *
 *   node test-lo-que-ya-sabes-20260809.cjs
 */
const assert = require("assert");
const { intencionDelTurno, intencionYaCubierta } = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

console.log("══ No preguntes lo que ya sabes ══════════════════");

// ── Las tres sugerencias del caso real son LA MISMA intención ───────────────
test("CASO REAL: las tres frases distintas son todas 'sugerencia'", () => {
  for (const f of [
    "¿Quieres añadir algo más o seguimos con el pedido?",
    "¿Te pongo algo para picar, un entrante para compartir?",
    "¿Quieres que te ponga algo para picar, algo de beber?",
    "¿Te apetece un postre para rematar?",
    "¿Algo más o lo dejamos así?"
  ]) assert.strictEqual(intencionDelTurno(f), "sugerencia", "no la clasifica: " + f);
});

test("CASO REAL: tras contestar a la primera, la segunda ya está cubierta", () => {
  const conv = [
    A("¿Quieres añadir algo más o seguimos con el pedido?"),
    U("Eh, no, nada más.")
  ];
  assert.strictEqual(intencionYaCubierta(conv, "sugerencia"), true,
    "vuelve a sugerirle después de que haya dicho que no");
});

test("CASO REAL: '¿qué te apetece pedir?' NO es una sugerencia", () => {
  // Bug del 09-08: se marcaba como upsell ofrecido antes de que el cliente
  // hubiera pedido nada, y su "sí, me gustaría un Abruzzo" se leía como
  // "sí, añádeme algo" → "¿Qué bebida o complemento quieres añadir?".
  for (const f of [
    "¿Quieres empezar a decirme qué te apetece pedir?",
    "¿Qué te apetece pedir?",
    "Muy bien, ¿qué te gustaría pedir?"
  ]) assert.notStrictEqual(intencionDelTurno(f), "sugerencia",
       "confunde la pregunta del pedido con un upsell: " + f);
});

test("pero '¿te apetece un postre?' SÍ es sugerencia", () => {
  assert.strictEqual(intencionDelTurno("¿Te apetece un postre para rematar?"), "sugerencia");
  assert.strictEqual(intencionDelTurno("¿Te apetece algo dulce?"), "sugerencia");
});

test("sin respuesta del cliente, la sugerencia NO cuenta como hecha", () => {
  assert.strictEqual(
    intencionYaCubierta([A("¿Te pongo algo de beber?")], "sugerencia"), false);
});

// ── La dirección ────────────────────────────────────────────────────────────
test("las peticiones de dirección se reconocen todas como una", () => {
  for (const f of [
    "Para el domicilio, ¿a qué dirección te lo llevo?",
    "¿Te lo llevo a Plaza de los Infantes, la de siempre?",
    "Me falta la dirección para el domicilio, ¿me la dices?"
  ]) assert.strictEqual(intencionDelTurno(f), "direccion", "no la clasifica: " + f);
});

test("CASO REAL: dictada la dirección, no se vuelve a pedir ni a confirmar", () => {
  const conv = [
    A("Para el domicilio, ¿a qué dirección te lo llevo?"),
    U("Plaza de los Infantes, edificio 5, segundo C.")
  ];
  assert.strictEqual(intencionYaCubierta(conv, "direccion"), true,
    "le suelta 'la de siempre' con una dirección que acaba de dictar");
});

// ── El tipo de entrega ──────────────────────────────────────────────────────
test("CASO REAL: confirmada la entrega, no se repregunta domicilio/recogida", () => {
  const conv = [
    A("¿Quieres que te lo lleve a Calle Alpandeire, la de siempre?"),
    U("Sí, por favor.")
  ];
  // "te lo llevo a X" ya implica domicilio: la intención de dirección queda hecha.
  assert.strictEqual(intencionYaCubierta(conv, "direccion"), true);
  assert.strictEqual(
    intencionDelTurno("¿Quieres que te lo lleve a domicilio o prefieres pasar a recogerlo?"),
    "tipo_entrega");
});

// ── Teléfono y nombre ───────────────────────────────────────────────────────
test("teléfono y nombre también se clasifican", () => {
  assert.strictEqual(intencionDelTurno("¿me dices un teléfono de contacto?"), "telefono");
  assert.strictEqual(intencionDelTurno("¿A nombre de quién lo pongo?"), "nombre");
});

test("dado el teléfono, no se vuelve a pedir", () => {
  assert.strictEqual(intencionYaCubierta(
    [A("Perfecto, ¿me dices un teléfono de contacto?"), U("El 627186903.")], "telefono"), true);
});

// ── Nada de falsos positivos ────────────────────────────────────────────────
test("un turno normal no tiene intención de pregunta", () => {
  assert.strictEqual(intencionDelTurno("Perfecto, te anoto una Prosciutto."), null);
  assert.strictEqual(intencionDelTurno(""), null);
});

test("el resumen se distingue de una sugerencia", () => {
  assert.strictEqual(
    intencionDelTurno("Resumen: 1 Prosciutto & Funghi. Total 11 euros. ¿Confirmas?"),
    "resumen");
});

// ── El bloque "LO QUE YA SABES" existe ──────────────────────────────────────
test("el backend inyecta 'LO QUE YA SABES' en cada turno", () => {
  const src = require("fs").readFileSync(require.resolve("./marta-llm.service.js"), "utf8");
  assert.ok(/LO QUE YA SABES DE ESTA LLAMADA/.test(src),
    "sin ese bloque el modelo no se entera de lo que el backend ya tiene");
  assert.ok(/dale las gracias en dos palabras y SIGUE/.test(src),
    "falta la orden de agradecer y continuar en vez de repetir el dato");
  assert.ok(/di su nombre SOLO al reconocerle al principio y al despedirte/i.test(src),
    "falta la regla de no repetir el nombre en cada frase");
});

// ── La reposición no se recoge: se lleva ────────────────────────────────────
// REGLA DE sam (09-08): si le has estropeado un pedido a domicilio, se le repone
// a domicilio. Preguntarle si pasa a recogerlo es una segunda bofetada.
test("REGLA DEL OWNER: la reposición va por el mismo canal que el original", () => {
  const src = require("fs").readFileSync(require.resolve("./marta-llm.service.js"), "utf8");
  assert.ok(/EN UNA REPOSICIÓN TODO SE HEREDA DEL PEDIDO ORIGINAL/.test(src),
    "falta la regla en el prompt");
  assert.ok(/PROHIBIDO preguntarle si prefiere pasar a recogerlo/.test(src),
    "falta la prohibición en la directiva de queja");
  assert.ok(/le has estropeado el pedido, no le mandes a por él/i.test(src),
    "falta el motivo, que es lo que hace que el modelo lo respete");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
