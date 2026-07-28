"use strict";

/**
 * Regresiones de los fixes del 2026-07-28 (Vozra PID).
 * Cubre a nivel de contrato/lógica determinista:
 *   1. Alergia: sin "Oye" en el prompt; lógica retirable/intrínseco presente.
 *   2. Upselling: detector determinista upsellAlreadyOffered.
 *   4. Tiempos: sin ETA inventada; copy de "el restaurante te confirmará".
 *   + Enganche de ontología de alérgenos (vacío hoy).
 * Los aspectos puramente conversacionales (que el LLM obedezca) se verifican en
 * llamada real; aquí verificamos que la REGLA y el CÓDIGO determinista existen.
 */

const assert = require("assert");
const {
  buildSystemPrompt,
  upsellAlreadyOffered
} = require("./marta-llm.service.js");
const { classifyAllergen, hasOntologyData } = require("./allergen-ontology.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("✅ " + name); pass++; }
  catch (e) { console.log("❌ " + name + "\n   " + e.message); fail++; }
}

const prompt = buildSystemPrompt();

console.log("══ Fixes 2026-07-28 — contrato de prompt ═════════");

// ── FALLO 1: ALERGIAS ────────────────────────────────────────────────────────
test("F1 el prompt NO enseña a empezar alertas con 'Oye'", () => {
  assert.ok(!/"Oye, la Carbonara/i.test(prompt), "sigue el ejemplo 'Oye, la Carbonara'");
  assert.ok(/NUNCA empieces el aviso con "Oye"/i.test(prompt), "falta la prohibición de 'Oye'");
});
test("F1 no repetir como descubrimiento lo que el cliente declara", () => {
  assert.ok(/NUNCA le repitas como si fuera un descubrimiento/i.test(prompt));
});
test("F1 lógica retirable vs intrínseco presente", () => {
  assert.ok(/RETIRABLE/.test(prompt) && /INTR[IÍ]NSECO/i.test(prompt), "faltan las dos ramas");
  assert.ok(/recomi[eé]ndale otro plato/i.test(prompt), "falta recomendar alternativa en intrínseco");
});
test("F1 deduce si la carta no marca el dato (ontología interina)", () => {
  assert.ok(/ded[uú]celo con sentido com[uú]n/i.test(prompt));
});
test("F1 no afirmar 100% seguro por su cuenta", () => {
  assert.ok(/NO afirmes que un plato es 100% seguro/i.test(prompt));
});

// ── FALLO 4: TIEMPOS INVENTADOS ──────────────────────────────────────────────
test("F4 el prompt YA NO manda sumar tiempo de preparación", () => {
  assert.ok(!/s[uú]male el tiempo de preparaci[oó]n/i.test(prompt), "sigue la instrucción de sumar minutos");
});
test("F4 prohíbe inventar minutos/hora", () => {
  assert.ok(/PROHIBIDO inventar minutos/i.test(prompt));
});
test("F4 usa el copy aprobado sin cifras", () => {
  assert.ok(/El restaurante te confirmar[aá] el tiempo estimado/i.test(prompt));
});
test("F4 no dice 'está en camino'", () => {
  assert.ok(/NUNCA digas que est[aá] "en camino"/i.test(prompt));
});

// ── FALLO 2: UPSELLING UNA VEZ (detector determinista) ───────────────────────
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });
test("F2 detecta oferta de bebida", () => {
  assert.strictEqual(upsellAlreadyOffered([A("¿Te pongo algo de beber?")]), true);
});
test("F2 detecta oferta de postre", () => {
  assert.strictEqual(upsellAlreadyOffered([A("¿Te apetece un Tiramisú de postre?")]), true);
});
test("F2 detecta oferta de entrante para compartir", () => {
  assert.strictEqual(upsellAlreadyOffered([A("¿Te pongo un entrante para compartir?")]), true);
});
test("F2 NO dispara en un resumen normal con bebida ya pedida", () => {
  assert.strictEqual(upsellAlreadyOffered([A("Te confirmo: una Carbonara y una Coca-Cola, para recoger. Son diecinueve euros.")]), false);
});
test("F2 NO dispara en saludo ni al tomar platos", () => {
  assert.strictEqual(upsellAlreadyOffered([A("¡Claro! ¿Es para recoger o a domicilio?"), A("Marchando una Diavola.")]), false);
});
test("F2 caso real: ofreció bebida en un turno previo del historial", () => {
  const hist = [A("Marchando."), U("una coca-cola"), A("Perfecto. ¿Algo de beber más para acompañar?")];
  assert.strictEqual(upsellAlreadyOffered(hist), true);
});
test("F2 el prompt mantiene 'EXACTAMENTE UNA vez'", () => {
  assert.ok(/EXACTAMENTE UNA vez/i.test(prompt));
});

// ── ENGANCHE DE ONTOLOGÍA (montado, vacío hoy) ───────────────────────────────
test("ONTO vacía hoy → hasOntologyData()=false", () => {
  assert.strictEqual(hasOntologyData(), false);
});
test("ONTO sin dato devuelve known:false (Sarah deduce)", () => {
  assert.deepStrictEqual(classifyAllergen("pizza_abruzzo", "shellfish"), { known: false });
});

console.log("══ RESUMEN ═══════════════════════════════════════");
console.log("✅ Pasados: " + pass + "   ❌ Fallidos: " + fail);
process.exit(fail ? 1 : 0);
