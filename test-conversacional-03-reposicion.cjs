/**
 * test-conversacional-03-reposicion.cjs
 *
 * PEDIDO DESTROZADO → REPOSICIÓN. El momento más delicado del negocio.
 *
 * CASO REAL 08-08 que lo motiva:
 *     [user]  Mi pedido ha llegado destrozado.
 *     ...
 *     [agent] ¿Quieres que te lo lleve a domicilio o prefieres pasar a recogerlo?
 *
 *   "Después de hacer un pedido a domicilio y jodérselo, lo último que se le
 *    pregunta al cliente es si quiere pasarse a recogerlo. Si hubiera querido ir
 *    él a recogerlo, habría ido de primeras."                      — sam, 09-08
 *
 * Y el contrapunto, del 07-08: NO se pueden abrir incidencias fantasma. "No hace
 * falta" o "¿qué dato te falta?" llegaron a generar un ticket de "Producto
 * incorrecto" con reposición GRATIS a clientes que solo pedían la cena.
 *
 *   node test-conversacional-03-reposicion.cjs
 */
const assert = require("assert");
const marta = require("./marta-llm.service.js");

let pass = 0, fail = 0;
const paso = (n, fn) => {
  try { fn(); console.log("   ✓ " + n); pass++; }
  catch (e) { console.log("   ✗ " + n + "\n        " + e.message); fail++; }
};
const U = c => ({ role: "user", content: c });
const A = c => ({ role: "assistant", content: c });

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  Llama: 'mi pedido ha llegado destrozado'            ║");
console.log("╚══════════════════════════════════════════════════════╝");

const conv = [
  A("Pizzería La Locanda, te atiende Sarah. ¿En qué puedo ayudarte?"),
  U("Quiero hablar con el encargado. Mi pedido ha llegado destrozado."),
  A("Lo siento mucho, eso no puede pasar. ¿Me das tu teléfono?"),
  U("634425921")
];

paso("se detecta que es una queja de un pedido YA ENTREGADO", () => {
  assert.strictEqual(marta.quejaDePedidoEntregado(conv), true,
    "no lo trata como pedido mal servido: se le quedaría sin compensar");
});

paso("las demás formas de contarlo también se detectan", () => {
  for (const f of [
    "el pedido ha llegado frío",
    "la pizza venía toda aplastada",
    "la comida estaba cruda",
    "me falta una pizza del pedido",
    "me han traído otro pedido distinto"
  ]) assert.strictEqual(marta.quejaDePedidoEntregado([U(f)]), true, "no detecta: " + f);
});

paso("y se nota que está enfadado cuando lo está", () => {
  assert.strictEqual(
    marta.clienteEnfadado([U("Esto es una vergüenza, no pienso pagar")]), true);
  assert.strictEqual(marta.clienteEnfadado([U("Mi pedido llegó frío")]), false,
    "trata como enfadado a quien solo informa");
});

paso("REGLA DEL OWNER: la reposición va por el mismo canal, no se le manda a recogerlo", () => {
  const p = marta.buildSystemPrompt();
  assert.ok(/EN UNA REPOSICIÓN TODO SE HEREDA DEL PEDIDO ORIGINAL/.test(p),
    "falta la regla en el prompt");
  assert.ok(/habr[íi]a ido de primeras/i.test(p),
    "falta el motivo, que es lo que hace que el modelo la respete");
});

paso("el ticket a cocina avisa con el teléfono para llamar al cliente", () => {
  const { buildTextTicket } = require("./kitchen-ticket-builder.service.js");
  const ticket = buildTextTicket({
    orderId: "ORD-TEST-REPO", customerName: "Samuel", phone: "634425921",
    orderType: "delivery", items: [{ displayName: "Abruzzo", quantity: 1 }],
    incidencia: { motivo: "llegó destrozado", alcance: "pedido_completo", quiereReembolso: false }
  }, {});
  assert.ok(/INCIDENCIA/i.test(ticket), "el ticket no avisa de que es una reposición");
  assert.ok(/634425921/.test(ticket), "cocina no tiene el teléfono para llamarle");
});

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  Y AL REVÉS: nada de incidencias fantasma            ║");
console.log("╚══════════════════════════════════════════════════════╝");

paso("CASO REAL: 'no, no hace falta' (rechazando un entrante) NO es una queja", () => {
  assert.strictEqual(marta.quejaDePedidoEntregado([
    U("quiero una pizza carbonara y una B&B"),
    U("Eh, no, no hace falta.")
  ]), false, "vuelve a regalar comida a quien solo está pidiendo la cena");
});

paso("CASO REAL: '¿qué dato te falta?' tampoco", () => {
  assert.strictEqual(marta.quejaDePedidoEntregado([
    U("una pizza carbonara"),
    U("Vale, ¿qué dato te falta?")
  ]), false);
});

paso("un pedido normal con la palabra 'pizza' no dispara nada", () => {
  assert.strictEqual(
    marta.quejaDePedidoEntregado([U("quiero dos pizzas y una Coca-Cola")]), false);
});

paso("un problema SIN entrega previa no basta", () => {
  assert.strictEqual(marta.quejaDePedidoEntregado([U("no quiero la masa quemada")]), false);
});

console.log("\n" + "─".repeat(56));
console.log(pass + " pasos ok / " + fail + " fallidos");
process.exit(fail ? 1 : 0);
