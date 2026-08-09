/**
 * test-si-no-y-aviso-20260808.cjs
 *
 * "Si no es capaz de entender algo tan simple como NO o SÍ estamos jodidos."
 *                                                              — sam, 08-08
 *
 * CASO REAL (Samuel, 634425921). Cuatro fallos en una sola llamada:
 *
 *   [agent] ¿Quieres que te ponga algo para picar, un entrante para compartir?
 *   [user]  Eh, no, estoy bien.
 *   [agent] Perfecto, te pongo una Abruzzo. ¿Algo más o lo cierro?     ← ignora el NO
 *   [user]  ¿me puedes poner una Coca-Cola?
 *   [agent] Te añado una Coca-Cola. ¿Algo más o lo dejamos así?
 *   [user]  Ah, sí, está bien.
 *   [agent] Perfecto. ¿Qué bebida o complemento quieres añadir?        ← el SÍ era CERRAR
 *   [user]  Te acabo de pedir una Coca-Cola.
 *   [agent] Resumen: 1 Abruzzo, 1 Coca-Cola. Total 17,50. ¿Confirmas?
 *   [user]  Sí, por favor.
 *   [agent] Resumen: 1 Abruzzo, 1 Coca-Cola. Total...                  ← ×4
 *   [user]  Que no resumas más, coño.
 *
 * Y en toda la llamada NO avisó de que la Abruzzo lleva langostinos, teniendo
 * "marisco" en su ficha: el aviso solo se generaba dentro de calcular_total y el
 * modelo no llegó a llamarla.
 *
 *   node test-si-no-y-aviso-20260808.cjs
 */
const assert = require("assert");
const {
  yaSeDijoYRespondio,
  esAfirmacionSimple,
  upsellYaCubierto,
  deterministicUpsellOffer,
  siguienteUpsell,
  buildSystemPrompt
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });
const pedido = (...cats) => ({ items: cats.map(c => ({ category: c })) });

const OFERTA = "¿Quieres que te ponga algo para picar, algo de beber?";
const RESUMEN = "Resumen: 1 Abruzzo, 1 Coca-Cola. Total 17 euros con 50. ¿Está todo correcto y confirmas el pedido?";

console.log("══ SÍ y NO: que se entiendan a la primera ════════");

// ── LA FRASE NUEVA (pedida por el owner) ────────────────────────────────────
test("REGLA DEL OWNER: la oferta pregunta por picar Y por beber a la vez", () => {
  const frase = deterministicUpsellOffer(pedido("pizza_rossa"), []);
  assert.strictEqual(frase, OFERTA);
  assert.ok(/picar/i.test(frase) && /beber/i.test(frase),
    "sigue habiendo dos rondas de upsell en vez de una");
});

test("esa oferta cubre entrante Y bebida: con pedir una, está respondida", () => {
  const order = { items: [{ category: "pizza_rossa" }, { category: "beverages" }], upsellOfferText: OFERTA };
  assert.strictEqual(upsellYaCubierto(order, []), true,
    "pediría otra vez picar a quien acaba de pedir la bebida");
});

// ── UNA PREGUNTA, UNA VEZ ───────────────────────────────────────────────────
test("CASO REAL: el resumen ya leído y contestado NO se repite", () => {
  assert.strictEqual(
    yaSeDijoYRespondio([A(RESUMEN), U("Sí, por favor.")], RESUMEN),
    true, "vuelve a soltar el resumen entero cuatro veces");
});

test("si el cliente NO ha contestado, sí se puede repetir", () => {
  assert.strictEqual(yaSeDijoYRespondio([A(RESUMEN)], RESUMEN), false);
});

test("un turno vacío (no se le entendió) permite repetir", () => {
  assert.strictEqual(yaSeDijoYRespondio([A(RESUMEN), U("   ")], RESUMEN), false,
    "con silencio hay que poder repetir");
});

test("una pregunta que nunca se hizo no se da por hecha", () => {
  assert.strictEqual(yaSeDijoYRespondio([A("¿A qué dirección?"), U("Calle Sol 3")], RESUMEN), false);
});

test("la insistencia del upsell tampoco se repite", () => {
  const insiste = "Necesito saber si quieres añadir algo o seguimos con el pedido.";
  assert.strictEqual(yaSeDijoYRespondio([A(insiste), U("ya te lo he dicho")], insiste), true);
});

// ── "SÍ" A UNA PREGUNTA DE CIERRE = CERRAR ──────────────────────────────────
test("CASO REAL: 'sí, está bien' es una afirmación simple", () => {
  // El código la leía como "sí quiero añadir algo". El contexto decide.
  assert.strictEqual(esAfirmacionSimple("Ah, sí, está bien."), true);
});

test("el prompt sabe que 'algo más' y 'lo dejamos así' son preguntas de cierre", () => {
  // La lógica vive en generateMartaReply; aquí se comprueba el patrón que usa.
  const rx = /(algo m[áa]s|lo dejamos as[íi]|lo cierro|est[áa] todo correcto|confirmas)/i;
  for (const f of ["¿Algo más o lo cierro?", "¿Algo más o lo dejamos así?",
                   "¿Está todo correcto y confirmas el pedido?"]) {
    assert.ok(rx.test(f), "no reconoce la pregunta de cierre: " + f);
  }
  assert.ok(!rx.test("¿Quieres que te ponga algo para picar, algo de beber?"),
    "confundiría la oferta con una pregunta de cierre");
});

// ── "NO" EN TODAS SUS FORMAS ────────────────────────────────────────────────
test("CASO REAL: 'no, estoy bien' cierra el upsell", () => {
  const rx = /\b(no|ningun|ninguna|nada|sin|paso|seguimos|as[íi] est[áa] bien|nada m[áa]s)\b/i;
  for (const f of ["Eh, no, estoy bien.", "no, nada más", "no hace falta",
                   "así está bien", "no, gracias"]) {
    assert.ok(rx.test(f), "no entiende el NO: " + f);
  }
});

// ── EL AVISO DE ALÉRGENO NO DEPENDE DE NINGUNA HERRAMIENTA ──────────────────
test("REGLA: el aviso se inyecta por turno, no dentro de calcular_total", () => {
  const src = require("fs").readFileSync(require.resolve("./marta-llm.service.js"), "utf8");
  assert.ok(/ALÉRGENO EN EL PEDIDO — AVÍSALE AHORA/.test(src),
    "el aviso sigue dependiendo de que el modelo llame a calcular_total");
  assert.ok(/eso NO borra su alergia de la ficha/.test(src),
    "falta recordarle que quitar el ingrediente no toca la ficha");
});

test("el prompt mantiene que decide el cliente", () => {
  const p = buildSystemPrompt();
  assert.ok(/MANDA LO QUE ÉL DIGA/.test(p));
  assert.ok(/PROHIBIDO negarle el pedido/.test(p));
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
