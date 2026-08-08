/**
 * test-alergia-ficha-vs-plato-20260808.cjs
 *
 * QUITAR UN INGREDIENTE DEL PLATO ≠ BORRAR LA ALERGIA DE LA FICHA.
 *
 * CASO REAL 08-08 (Samuel, 634425921). Con "marisco" en su ficha:
 *     [user]  ¿tú sabías que tengo alergia a los langostinos o no?
 *     [agent] Te tengo apuntada la alergia a langostinos. Esa pizza lleva
 *             langostinos, pero si la quieres igual, te la anoto. ¿La quieres tal cual?
 *     [user]  No. ¿Le podéis quitar los langostinos?
 *     [agent] ¿Te pongo algo para picar, un entrante para compartir?     ← le ignora
 *     [user]  Te he preguntado que si le podéis quitar los langostinos a la pizza.
 *     [agent] He eliminado esa alergia de tu ficha.                      ← DESTRUYE EL DATO
 *
 * El disparador era el regex `quita` a secas en detectRemovedAllergies, más la
 * descripción de la tool eliminar_alergia_guardada. El cliente pedía una
 * modificación de COCINA y se le borró un dato de seguridad alimentaria.
 *
 * REGLA DEL OWNER (08-08): la ficha solo cambia cuando el cliente lo notifica
 * EXPRESAMENTE. Así queda registrada y se le puede advertir la próxima vez.
 *
 *   node test-alergia-ficha-vs-plato-20260808.cjs
 */
const assert = require("assert");
const { detectRemovedAllergies, buildSystemPrompt } = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const U = c => ({ role: "user", content: c });
const GUARDADAS = ["marisco", "langostinos"];

console.log("══ La ficha no se toca por quitar un ingrediente ══");

// ── Lo que NO debe tocar la ficha ───────────────────────────────────────────
test("CASO REAL: '¿le podéis quitar los langostinos?' NO borra la alergia", () => {
  assert.deepStrictEqual(
    detectRemovedAllergies([U("No. ¿Le podéis quitar los langostinos?")], GUARDADAS),
    [], "vuelve a borrarle la alergia por pedir la pizza sin el ingrediente");
});

test("las demás formas de pedirlo en cocina tampoco la borran", () => {
  for (const f of [
    "quítale los langostinos a la pizza",
    "que no lleve marisco la pizza",
    "sin langostinos, por favor",
    "me la pones sin marisco de encima",
    "quita el marisco de la salsa"
  ]) assert.deepStrictEqual(detectRemovedAllergies([U(f)], GUARDADAS), [],
       "toca la ficha con una petición de cocina: " + f);
});

// ── Lo que SÍ debe tocarla ──────────────────────────────────────────────────
test("'ya no soy alérgico al marisco' SÍ la borra", () => {
  assert.deepStrictEqual(
    detectRemovedAllergies([U("ya no soy alérgico al marisco")], GUARDADAS),
    ["marisco"]);
});

test("las demás bajas explícitas también", () => {
  for (const f of [
    "eso del marisco estaba mal apuntado",
    "ya no tengo alergia al marisco",
    "bórrala de mi ficha, lo del marisco",
    "quita esa alergia, el marisco fue un error"
  ]) assert.ok(detectRemovedAllergies([U(f)], GUARDADAS).length > 0,
       "no reconoce una baja explícita: " + f);
});

test("una frase cualquiera no toca nada", () => {
  assert.deepStrictEqual(detectRemovedAllergies([U("ponme dos pizzas")], GUARDADAS), []);
});

// ── La operativa de cocina en el prompt ─────────────────────────────────────
test("REGLA DEL OWNER: el topping no se pone y punto", () => {
  const p = buildSystemPrompt();
  assert.ok(/NO SE PONE Y PUNTO/.test(p), "falta la regla del topping");
});

test("REGLA DEL OWNER: salsa con alérgeno → se SUSTITUYE, según el alérgeno", () => {
  const p = buildSystemPrompt();
  assert.ok(/SE SUSTITUYE por otra salsa o base/i.test(p),
    "falta la sustitución que resuelve el caso de pasta/risotto/salsa");
  // La salsa de tomate es el ejemplo del MARISCO, no la respuesta a todo.
  assert.ok(/si es MARISCO, salsa de tomate/i.test(p), "falta el ejemplo concreto del marisco");
  assert.ok(/si es GLUTEN, base sin gluten/i.test(p), "falta la sustitución del gluten");
  assert.ok(/Te la hago con \[alternativa\] en vez de/i.test(p), "falta la fórmula para decírselo");
});

test("la regla sirve para TODOS los alérgenos, no solo el marisco", () => {
  const p = buildSystemPrompt();
  assert.ok(/sirve para TODOS los al[ée]rgenos/i.test(p));
});

test("el prompt distingue quitar ingrediente de borrar la ficha", () => {
  const p = buildSystemPrompt();
  assert.ok(/QUITAR UN INGREDIENTE ≠ QUITAR LA ALERGIA DE SU FICHA/.test(p),
    "el modelo no tiene forma de distinguir las dos cosas");
  assert.ok(/su alergia SIGUE guardada/i.test(p));
});

test("la base sin gluten solo se ofrece si él lo menciona", () => {
  const p = buildSystemPrompt();
  assert.ok(/Solo sacas el tema de la base sin gluten si el cliente menciona/i.test(p));
  assert.ok(/cuatro euros con cincuenta/i.test(p), "falta el suplemento de la base sin gluten");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
