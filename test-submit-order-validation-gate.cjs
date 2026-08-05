"use strict";

const assert = require("assert");
const Module = require("module");

const calls = {
  dispatch: 0,
  watch: 0,
  notify: 0,
  print: 0,
  persist: 0,
  customer: 0
};

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /marta-llm\.service\.js$/.test(parent.filename || "")) {
    if (request === "./dispatch-adapter.service.js") return {
      dispatchOrder: async order => {
        calls.dispatch++;
        return {
          ok: true,
          delivered: true,
          channel: "test_kitchen",
          order: { ...order, status: "sent_to_kitchen", dispatchChannel: "test_kitchen" }
        };
      }
    };
    if (request === "./kitchen-ack-monitor.service.js") return {
      startKitchenWatch: () => { calls.watch++; }
    };
    if (request === "./print-queue.store.js") return {
      enqueuePrint: () => { calls.print++; }
    };
    if (request === "./customer-notify.service.js") return {
      sendCustomerConfirmation: async () => { calls.notify++; return { ok: true, channel: "test" }; }
    };
    if (request === "./supabase-store.js") return {
      upsertOrder: async () => { calls.persist++; return { ok: true }; }
    };
    if (request === "./customer-store.js") return {
      getCustomerByPhone: async () => null,
      upsertCustomer: async () => { calls.customer++; return { ok: true }; },
      updateCustomerAllergies: async () => ({ ok: true, allergies: [] })
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { handleSubmitOrder } = require("./marta-llm.service.js");
const { clearAllSessionsForTests, ORDER_STATUS } = require("./order-call-session.store.js");
Module._load = originalLoad;

const validArgs = {
  items: [{ menu_item_id: "pizza_margherita", quantity: 1 }],
  order_type: "pickup",
  customer_name: "Ana",
  phone: "612345678",
  payment_method: "cash",
  save_profile_consent: false
};

function snapshot() {
  return { ...calls };
}

function assertNoOperationalEffects(before, label) {
  assert.deepStrictEqual(snapshot(), before, `${label}: se produjo un efecto lateral operativo`);
}

async function submitConfirmed(callId, args, priorMessages = []) {
  const offered = await handleSubmitOrder(callId, args, priorMessages);
  assert.strictEqual(offered.reason, "upsell_required", `${callId}: debe exigir upselling cuando siga not_offered`);
  const summarized = await handleSubmitOrder(callId, args, [
    ...priorMessages,
    { role: "assistant", content: offered.reply },
    { role: "user", content: "No, seguimos" }
  ]);
  assert.strictEqual(summarized.reason, "summary_required", `${callId}: debe exigir el resumen versionado antes de confirmar`);
  assert.strictEqual(summarized.delivered, false, `${callId}: el resumen no puede producir dispatch`);
  return handleSubmitOrder(callId, args, [
    ...priorMessages,
    { role: "assistant", content: summarized.reply },
    { role: "user", content: "Sí" }
  ]);
}

(async () => {
  clearAllSessionsForTests();

  const invalidBefore = snapshot();
  const invalid = await handleSubmitOrder("p0-invalid", { ...validArgs, customer_name: "" });

  assert.strictEqual(invalid.ok, false, "la validación fallida no debe devolver ok");
  assert.strictEqual(invalid.delivered, false, "la validación fallida no debe figurar como entregada");
  assert.strictEqual(invalid.validationFailed, true, "falta el resultado estructurado validationFailed");
  assert.strictEqual(invalid.retryable, true, "la validación fallida debe permitir reintento");
  assert.strictEqual(invalid.reason, "validation_failed");
  assert.strictEqual(invalid.validation.ok, false);
  assert(!/pedido queda confirmado|va a cocina/i.test(invalid.reply), "la respuesta confirma verbalmente un pedido inválido");
  assertNoOperationalEffects(invalidBefore, "pedido inválido");

  const retried = await submitConfirmed("p0-invalid", validArgs);
  assert.strictEqual(retried.ok, true, "el pedido corregido no pudo reintentarse");
  assert.strictEqual(retried.delivered, true, "el pedido corregido no continuó al dispatch");
  assert.strictEqual(calls.dispatch, 1, "el dispatch válido debe ejecutarse exactamente una vez");
  assert.strictEqual(calls.print, 1, "el pedido válido debe conservar la impresión existente");
  assert.strictEqual(calls.notify, 1, "el pedido válido debe conservar la notificación existente");
  assert(/pedido queda confirmado y va a cocina/i.test(retried.reply), "cambió la confirmación verbal del pedido válido");
  assert(retried.reply.includes("Muchas gracias por escogernos, espero verte pronto de nuevo!"), "cambió la despedida comercial existente");

  clearAllSessionsForTests();
  const valid = await submitConfirmed("p0-valid", { ...validArgs, phone: "623456789" });
  assert.strictEqual(valid.ok, true, "la validación correcta no permite continuar");
  assert.strictEqual(valid.validation.ok, true, "el pedido válido no superó validateOrder");
  assert.strictEqual(calls.dispatch, 2, "el comportamiento válido existente no ejecutó dispatch");

  const perPizzaPhrases = [
    "una Coca-Cola para cada pizza",
    "una para cada pizza",
    "una por pizza",
    "tantas como pizzas",
    "una bebida para cada una"
  ];

  for (const [index, phrase] of perPizzaPhrases.entries()) {
    clearAllSessionsForTests();
    const result = await submitConfirmed(
      `per-pizza-${index}`,
      {
        ...validArgs,
        phone: `71${String(index).padStart(7, "0")}`,
        items: [
          { menu_item_id: "pizza_margherita", quantity: 3 },
          { menu_item_id: "pizza_abruzzo", quantity: 1 },
          { menu_item_id: "coca_cola", quantity: 3 }
        ]
      },
      [{ role: "user", content: phrase }]
    );
    assert.strictEqual(result.ok, true, `${phrase}: el pedido válido no continuó`);
    const coke = result.order.items.find(item => item.id === "coca_cola");
    assert(coke, `${phrase}: falta Coca-Cola en el pedido`);
    assert.strictEqual(coke.quantity, 4, `${phrase}: debe derivar cuatro bebidas de 3+1 pizzas`);
  }

  clearAllSessionsForTests();
  // Vozra PID SOLO TOMA PEDIDOS: una alergia declarada NO bloquea. Se anota (flag +
  // warning ALLERGEN_NOTED + kitchenNote) y el pedido PROCEDE con normalidad.
  const allergyOrder = await submitConfirmed("allergy-abruzzo", {
    ...validArgs,
    phone: "722345678",
    items: [{
      menu_item_id: "pizza_abruzzo",
      quantity: 1,
      modifiers: [{ type: "remove", value: "langostinos" }]
    }],
    allergies: ["marisco"]
  });

  assert.strictEqual(allergyOrder.ok, true, "una alergia NO debe bloquear el pedido (PID solo toma pedidos)");
  assert.notStrictEqual(allergyOrder.validationFailed, true, "una alergia no debe marcar validationFailed");
  assert(allergyOrder.order.allergies.includes("marisco"), "debe conservar la alergia estructurada");
  assert.strictEqual(allergyOrder.validation.flags.requiresKitchenReview, true, "la alergia se anota como flag para cocina");
  assert(
    (allergyOrder.validation.warnings || []).some(w => w.code === "ALLERGEN_NOTED"),
    "la alergia debe quedar como AVISO no bloqueante (ALLERGEN_NOTED)"
  );
  assert(
    !(allergyOrder.validation.errors || []).some(error => error.code === "ALLERGEN_REVIEW_REQUIRED"),
    "NO debe existir ya el error bloqueante ALLERGEN_REVIEW_REQUIRED"
  );
  assert(!/contaminación cruzada|no garantiza/i.test(allergyOrder.reply || ""), "no debe soltar el mensaje de bloqueo por contaminación");

  console.log("✅ P0 validation gate: invalid orders have zero operational effects and remain retryable");
})().catch(err => {
  console.error("❌ P0 validation gate:", err.stack || err.message);
  process.exitCode = 1;
});
