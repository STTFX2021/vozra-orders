/**
 * test-antibucle-20260801.cjs
 *
 * CASO REAL que motiva esto (llamada conv_5501kyya…, 01-08-2026):
 *   12 [agent] "...lleva un suplemento de 1,50 por cada extra, ¿quieres que te la ponga así?"
 *   13 [user]  "Sí, por favor."
 *   14 [agent] "...lleva un suplemento de 1,50..., el total es 16,50. ¿Te lo confirmo así?"
 *   15 [user]  "Sí, por favor."
 *   16 [agent] "El total es 16,50, incluyendo el suplemento... ¿Te lo confirmo así?"
 *
 * El cliente confirmó DOS veces y Sarah siguió preguntando. No era culpa del modelo:
 * `calcular_total` devuelve `aviso_suplementos` ("AVISA al cliente… ANTES de confirmar")
 * en CADA llamada, así que en cada turno se le volvía a ordenar avisar.
 *
 *   node test-antibucle-20260801.cjs
 */
const assert = require("assert");
const {
  suplementoYaAvisado,
  esPreguntaDeConfirmacion,
  esAfirmacionSimple,
  repitePreguntaAnterior,
  confirmacionPendienteDeEnviar,
  computeQuote
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

// Transcripción REAL de la llamada que falló.
const LLAMADA_REAL = [
  A("PizzeriaLaLocandaCancelada, te atiende Sarah, ¿en qué te puedo ayudar?"),
  U("Me gustaría hacer un pedido."),
  A("¿Es para recoger en el local o a domicilio?"),
  U("Sería para a domicilio."),
  A("Perfecto, ¿me dices un teléfono de contacto, por favor?"),
  U("Sí, el 634425921."),
  A("Aquí estás, Samuel. ¿Te lo llevo a Calle Alpandeire, la de siempre?"),
  U("Sí, por favor."),
  A("Muy bien, Samuel, ¿qué te gustaría pedir para empezar?"),
  U("Me gustaría pedir una prosciutto con extra de queso y orégano. También una Coca-Cola."),
  A("Hecho, te lo anoto. ¿Quieres que te ponga algo más?"),
  U("Eh, no, no hace falta."),
  A("La Prosciutto con extra de queso y orégano lleva un suplemento de un euro con cincuenta por cada extra, ¿quieres que te la ponga así igualmente?"),
  U("Sí, por favor."),
  A("La Prosciutto con extra de queso y orégano lleva un suplemento de un euro con cincuenta por cada extra, el total es dieciséis euros con cincuenta. ¿Te lo confirmo así?"),
  U("Sí, por favor.")
];

console.log("══ Anti-bucle (caso real conv_5501kyya) ══════════");

test("CASO REAL: en el turno 14 ya se había avisado del suplemento", () => {
  assert.strictEqual(suplementoYaAvisado(LLAMADA_REAL.slice(0, 14)), true);
});

test("CASO REAL: tras el 2º 'sí' el pedido está AUTORIZADO (hay que enviarlo, no repreguntar)", () => {
  assert.strictEqual(confirmacionPendienteDeEnviar(LLAMADA_REAL), true,
    "no detecta la confirmación → el bucle seguiría");
});

test("CASO REAL: el turno 14 repite lo que ya dijo el 12", () => {
  assert.strictEqual(repitePreguntaAnterior(LLAMADA_REAL.slice(0, 15)), true);
});

test("al principio de la llamada no hay aviso de suplemento", () => {
  assert.strictEqual(suplementoYaAvisado(LLAMADA_REAL.slice(0, 12)), false);
});

test("preguntas de confirmación reconocidas", () => {
  for (const t of [
    "El total es 16,50. ¿Te lo confirmo así?",
    "¿Quieres que te la ponga así igualmente?",
    "¿Lo mando a cocina?",
    "¿Está todo correcto?"
  ]) assert.ok(esPreguntaDeConfirmacion(t), "no detecta: " + t);
});

test("una pregunta cualquiera NO cuenta como confirmación", () => {
  for (const t of [
    "¿Es para recoger o a domicilio?",
    "¿Me dices un teléfono de contacto?",
    "¿Qué te gustaría pedir?"
  ]) assert.ok(!esPreguntaDeConfirmacion(t), "falso positivo: " + t);
});

test("afirmaciones simples reconocidas", () => {
  for (const t of ["Sí", "Sí, por favor", "Vale", "Correcto", "Perfecto", "Eso es", "Adelante"])
    assert.ok(esAfirmacionSimple(t), "no detecta: " + t);
});

test("un 'sí' con matiz NO autoriza el envío", () => {
  for (const t of [
    "Sí, pero quítame el orégano",
    "Sí, añade una Coca-Cola",
    "No, espera",
    "Sí, y también un postre"
  ]) assert.ok(!esAfirmacionSimple(t), "falso positivo: " + t);
});

test("no autoriza si la pregunta previa no era de confirmación", () => {
  assert.strictEqual(confirmacionPendienteDeEnviar([
    A("¿Es para recoger o a domicilio?"), U("Sí")
  ]), false);
});

test("no autoriza si el cliente pide algo más", () => {
  assert.strictEqual(confirmacionPendienteDeEnviar([
    A("El total es 16,50. ¿Te lo confirmo así?"), U("Sí, pero añade una Coca-Cola")
  ]), false);
});

test("dos turnos distintos NO se marcan como bucle", () => {
  assert.strictEqual(repitePreguntaAnterior([
    A("¿Es para recoger en el local o a domicilio?"),
    A("Perfecto, ¿me dices un teléfono de contacto, por favor?")
  ]), false);
});

test("computeQuote sigue avisando la PRIMERA vez (no hemos roto el aviso)", () => {
  const q = computeQuote({ items: [
    { menu_item_id: "pizza_margherita", quantity: 1, modifiers: [{ type: "extra", value: "burrata" }] }
  ]});
  assert.ok(q.aviso_suplementos, "ya no avisa nunca: nos hemos pasado de frenada");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
