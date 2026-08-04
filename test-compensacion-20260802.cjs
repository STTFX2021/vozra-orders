/**
 * test-compensacion-20260802.cjs
 *
 * POLÍTICA DEL OWNER (02-08): si el pedido llegó mal, se le ofrece el MISMO pedido
 * GRATIS, e incluso un 10% de descuento si el local lo acepta.
 *
 * CASO REAL que lo motiva — cliente con la pizza destrozada:
 *   [user]  la comida me ha llegado fría y destrozada... la pizza está reventada
 *   [agent] Lamento mucho lo ocurrido... ¿Quieres que te ayude con un nuevo pedido
 *           para compensar?
 *   [user]  Sí, pero el pedido es gratuito o ¿cómo va?
 *   [agent] No, Samuel Tineo, el pedido nuevo NO es gratuito...      ← INACEPTABLE
 *   [user]  la habéis cagado vosotros... no te voy a pagar otro pedido
 *   [agent] Tu enfado, Samuel Tineo.                                  ← frase ROTA
 *
 * Dos causas: (1) el prompt solo decía "no prometas nada" y Sarah obedeció;
 * (2) el sanitizador se comió el "Entiendo." de "Entiendo. Tu enfado…".
 *
 *   node test-compensacion-20260802.cjs
 */
const assert = require("assert");
const {
  quejaDePedidoEntregado,
  clienteEnfadado,
  sanitizeReply,
  buildSystemPrompt,
  freeReplacementAuthorized,
  handleSubmitOrder,
  SUBMIT_ORDER_TOOL
} = require("./marta-llm.service.js");
const { buildTextTicket } = require("./kitchen-ticket-builder.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const U = c => ({ role: "user", content: c });

console.log("══ Compensación por pedido mal servido ═══════════");

// ── 1. Detección de la queja ────────────────────────────────────────────────
test("CASO REAL: detecta la pizza destrozada", () => {
  assert.strictEqual(quejaDePedidoEntregado([
    U("me gustaría hablar con el mánager porque la comida me ha llegado fría y destrozada. La pizza está reventada.")
  ]), true);
});

test("detecta las variantes típicas", () => {
  for (const q of [
    "el pedido ha llegado frío",
    "me falta una pizza del pedido",
    "me han traído otro pedido distinto",
    "la pizza venía toda aplastada",
    "la comida estaba cruda"
  ]) assert.strictEqual(quejaDePedidoEntregado([U(q)]), true, "no detecta: " + q);
});

test("un pedido normal NO se confunde con una queja", () => {
  for (const q of [
    "quiero una pizza prosciutto y una Coca-Cola",
    "¿me puedes decir los horarios?",
    "quiero una pizza pero sin cebolla"
  ]) assert.strictEqual(quejaDePedidoEntregado([U(q)]), false, "falso positivo: " + q);
});

test("CASO REAL: detecta el enfado", () => {
  assert.strictEqual(clienteEnfadado([
    U("la habéis cagado vosotros. Me habéis traído una pizza reventada, no te voy a pagar otro pedido")
  ]), true);
});

test("un cliente que solo informa NO se marca como enfadado", () => {
  assert.strictEqual(clienteEnfadado([U("el pedido ha llegado un poco frío")]), false);
});

// ── 2. La política está en el prompt ────────────────────────────────────────
test("la reposición gratuita queda fail-closed por defecto", () => {
  const p = buildSystemPrompt();
  assert.ok(/PEDIDO MAL SERVIDO/.test(p), "falta la sección");
  assert.ok(/NO puedes ofrecer reposición gratuita/.test(p),
    "ofrece una compensación económica sin autorización del restaurante");
  assert.strictEqual(freeReplacementAuthorized(), false,
    "el runtime permite reposición gratuita sin configuración explícita");
});

test("la autorización de reposición es configurable por restaurante", () => {
  assert.strictEqual(freeReplacementAuthorized({ compensacion: { reposicion_gratis: true } }), true);
  assert.strictEqual(freeReplacementAuthorized({ compensacion: { reposicion_gratis: false } }), false);
  assert.strictEqual(freeReplacementAuthorized({}), false);
});

test("el prompt contempla el 10% pero no lo promete sin autorización", () => {
  const p = buildSystemPrompt();
  assert.ok(/10%/.test(p), "no menciona el descuento");
  assert.ok(/aprobar el local|NO lo prometas como seguro/.test(p),
    "promete un descuento que el local no ha autorizado");
});

test("el prompt deriva la compensación cuando está desactivada", () => {
  const p = buildSystemPrompt();
  assert.ok(!/Para reembolsos NO prometas nada/.test(p), "sigue el texto que causó el fallo");
  assert.ok(!/SÍ puedes compensar con comida/.test(p), "contradice el gate fail-closed");
  assert.ok(/deriva al encargado/.test(p), "no deriva la decisión económica");
  assert.ok(/no te escondas detrás de las normas/.test(p), "puede volver a escudarse en las normas");
});

test("la incidencia queda registrada y escalada", () => {
  assert.ok(/registrar_incidencia con escalar=true/.test(buildSystemPrompt()));
});

// ── 2b. Reembolso: tranquilizar sin autorizar dinero ───────────────────────
test("ante un reembolso, tranquiliza y deriva al encargado", () => {
  const p = buildSystemPrompt();
  assert.ok(/su dinero lo va a tener/.test(p), "no tranquiliza al cliente");
  assert.ok(/encargado le va a llamar/.test(p), "no anuncia la llamada del encargado");
  assert.ok(/no le vuelve a pasar/.test(p), "no explica por qué interesa al negocio");
  assert.ok(!/no puedo autorizar dinero/i.test(p), "sigue escondiéndose tras las normas");
});

// ── 2c. El ticket de cocina lleva la alerta ────────────────────────────────
test("CASO REAL: el ticket avisa a cocina con el teléfono para llamar", () => {
  const ticket = buildTextTicket({
    orderId: "ORD-TEST-1", orderType: "delivery",
    customerName: "Samuel", phone: "600000000",
    address: { raw: "Calle Alpandeire 3" },
    items: [{ menuItemId: "pizza_prosciutto", displayName: "Prosciutto", quantity: 1 }],
    incidencia: { motivo: "la pizza llegó destrozada y fría", quiereReembolso: true }
  }, {});
  assert.ok(/INCIDENCIA/.test(ticket), "el ticket no avisa de la incidencia");
  assert.ok(/NO SE COBRA/.test(ticket), "cocina podría cobrarlo");
  assert.ok(/LLAMAR AL CLIENTE: 600000000/.test(ticket), "falta el teléfono para llamar");
  assert.ok(/destrozada/.test(ticket), "no dice qué pasó");
  assert.ok(/PIDE REEMBOLSO/.test(ticket), "no avisa de que quiere el dinero");
  // La alerta va ANTES que la cabecera del pedido: es lo primero que se lee.
  assert.ok(ticket.indexOf("INCIDENCIA") < ticket.indexOf("ORD-TEST-1"),
    "la alerta no está arriba del todo");
});

test("un item sin displayName NO tumba el ticket (el pedido debe llegar)", () => {
  const ticket = buildTextTicket({
    orderId: "ORD-TEST-3", orderType: "pickup", customerName: "Samuel", phone: "600000000",
    items: [{ menuItemId: "pizza_prosciutto", quantity: 1 }]   // sin displayName a propósito
  }, {});
  assert.ok(/ORD-TEST-3/.test(ticket), "revienta y cocina se queda sin comanda");
});

test("un pedido normal NO lleva alerta de incidencia", () => {
  const ticket = buildTextTicket({
    orderId: "ORD-TEST-2", orderType: "pickup",
    customerName: "Samuel", phone: "600000000",
    items: [{ menuItemId: "pizza_prosciutto", name: "Prosciutto", quantity: 1 }]
  }, {});
  assert.ok(!/INCIDENCIA/.test(ticket), "mete una alerta donde no la hay");
  assert.ok(!/NO SE COBRA/.test(ticket), "diría que un pedido normal no se cobra");
});

test("submit_order acepta el campo incidencia", () => {
  const p = SUBMIT_ORDER_TOOL.function.parameters.properties;
  assert.ok(p.incidencia, "el modelo no puede marcar el pedido como reposición");
  assert.ok(p.incidencia.properties.quiere_reembolso, "falta quiere_reembolso");
});

// ── 3. El sanitizador ya no rompe la empatía ───────────────────────────────
test("CASO REAL: 'Entiendo. Tu enfado...' NO se queda en 'Tu enfado'", () => {
  const r = sanitizeReply("Entiendo. Tu enfado es totalmente comprensible, Samuel.");
  assert.ok(/^Entiendo/.test(r), "sigue comiéndose el verbo: " + r);
});

test("protege las continuaciones con determinante", () => {
  for (const frase of [
    "Entiendo. Tu pedido llegó mal y lo vamos a arreglar.",
    "Entiendo. Lo que ha pasado no debería pasar.",
    "Entiendo. Eso es un fallo nuestro."
  ]) assert.ok(/^Entiendo/.test(sanitizeReply(frase)), "rompe: " + frase);
});

test("pero sigue quitando la muletilla de verdad", () => {
  const r = sanitizeReply("Entiendo. Perfecto, te lo apunto.");
  assert.ok(!/^Entiendo/.test(r), "ya no limpia la muletilla: " + r);
});

test("y sigue quitando 'Entendido...' con puntos suspensivos", () => {
  const r = sanitizeReply("Entendido... Te lo apunto.");
  assert.ok(!/^Entendido/.test(r), "no limpia: " + r);
});

(async () => {
  try {
    const result = await handleSubmitOrder("TEST-COMP-FAIL-CLOSED", {
      items: [{ menu_item_id: "pizza_prosciutto", quantity: 1 }],
      order_type: "pickup",
      phone: "600000000",
      incidencia: { motivo: "pedido mal servido" }
    });
    assert.strictEqual(result.delivered, false);
    assert.strictEqual(result.reason, "free_replacement_not_authorized");
    console.log("  ok  el runtime no despacha una reposición sin autorización");
    pass++;
  } catch (e) {
    console.log("  FAIL el runtime no despacha una reposición sin autorización\n       " + e.message);
    fail++;
  }
  console.log("");
  console.log(pass + " ok / " + fail + " fail");
  process.exit(fail ? 1 : 0);
})();
