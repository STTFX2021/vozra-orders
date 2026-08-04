"use strict";

const assert = require("assert");
const Module = require("module");

const effects = { persist: 0, dispatch: 0, print: 0, notify: 0, watch: 0, customer: 0 };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /marta-llm\.service\.js$/.test(parent.filename || "")) {
    if (request === "./dispatch-adapter.service.js") return {
      dispatchOrder: async order => {
        effects.dispatch++;
        return { ok: true, delivered: true, channel: "test", order: { ...order, status: "sent_to_kitchen", dispatchChannel: "test" } };
      }
    };
    if (request === "./supabase-store.js") return {
      upsertOrder: async () => { effects.persist++; return { ok: true }; }
    };
    if (request === "./print-queue.store.js") return {
      enqueuePrint: () => { effects.print++; return { ok: true }; }
    };
    if (request === "./customer-notify.service.js") return {
      sendCustomerConfirmation: async () => { effects.notify++; return { ok: true, channel: "test" }; }
    };
    if (request === "./kitchen-ack-monitor.service.js") return {
      startKitchenWatch: () => { effects.watch++; }
    };
    if (request === "./customer-store.js") return {
      getCustomerByPhone: async () => null,
      upsertCustomer: async () => { effects.customer++; return { ok: true }; }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { validateOrder } = require("./order-validator.service.js");
const {
  handleSubmitOrder,
  computeQuote,
  mapToolItem
} = require("./marta-llm.service.js");
const {
  clearAllSessionsForTests,
  getOrCreateOrderSession
} = require("./order-call-session.store.js");
const { buildTextTicket } = require("./kitchen-ticket-builder.service.js");
Module._load = originalLoad;

function reset() {
  clearAllSessionsForTests();
  for (const key of Object.keys(effects)) effects[key] = 0;
}

function noEffects(label) {
  for (const [key, value] of Object.entries(effects)) {
    assert.strictEqual(value, 0, `${label}: efecto operativo inesperado ${key}=${value}`);
  }
}

function rawAbruzzo(modifiers = []) {
  return { menu_item_id: "pizza_abruzzo", quantity: 1, modifiers };
}

function order(items, allergies) {
  return {
    items: items.map(mapToolItem),
    orderType: "pickup",
    customerName: "Ana",
    phone: "612345678",
    allergies
  };
}

function pending(validation) {
  return validation.allergenConflicts.find(conflict => conflict.status === "pending");
}

function resolved(validation) {
  return validation.allergenConflicts.find(conflict => conflict.status === "resolved");
}

(async () => {
  let passed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log("  ok  " + name);
    } catch (error) {
      console.error("  FAIL " + name + "\n       " + error.message);
      throw error;
    }
  };

  console.log("══ Autoridad determinista de alérgenos ══════════");

  await test("1. perfil alérgico + Abruzzo bloquea hasta resolver", async () => {
    reset();
    const session = getOrCreateOrderSession("profile-pending");
    session.registeredName = "Ana";
    session.registeredRestrictions = { allergies: ["langostinos"] };
    const result = await handleSubmitOrder("profile-pending", {
      items: [rawAbruzzo()], order_type: "pickup", phone: "612345678"
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "allergen_conflict_pending");
    assert.strictEqual(result.validation.requiredAction, "resolve_allergen_conflict");
    assert(pending(result.validation));
    assert.strictEqual(result.order.requiredAction, "resolve_allergen_conflict");
    noEffects("perfil + Abruzzo");
  });

  await test("2. Abruzzo sin langostinos queda resuelta sin repreguntar", async () => {
    reset();
    const validation = validateOrder(order([
      rawAbruzzo([{ type: "remove", value: "langostinos" }])
    ], ["langostinos"]));
    assert.strictEqual(validation.ok, true);
    assert.strictEqual(validation.requiredAction, null);
    const conflict = resolved(validation);
    assert(conflict, "falta resolución estructurada");
    assert.strictEqual(conflict.resolution, "removed");
    assert.strictEqual(conflict.classification, "removable");
    assert.deepStrictEqual(validateOrder(order([
      rawAbruzzo([{ type: "remove", value: "langostinos" }])
    ], ["langostinos"])).allergenConflicts, validation.allergenConflicts, "la resolución no es idempotente");

    const ticketOrder = order([rawAbruzzo([{ type: "remove", value: "langostinos" }])], ["langostinos"]);
    ticketOrder.orderId = "ORD-ALLERGY-RESOLVED";
    const ticket = buildTextTicket(ticketOrder, validation);
    assert(/Declarado: langostinos/i.test(ticket), "falta alergia del cliente");
    assert(/SIN LANGOSTINOS/i.test(ticket), "falta modificación del producto");
    assert(/RETIRADO/i.test(ticket), "falta alerta visible de resolución a cocina");
  });

  await test("3 y 6. integración turno a turno reevalúa y reabre", async () => {
    reset();
    const callId = "turn-by-turn";
    const first = computeQuote({ items: [rawAbruzzo()], order_type: "pickup" }, [
      { role: "user", content: "Quiero una Abruzzo" }
    ], callId);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.total_eur, 15);

    const declaredLater = computeQuote({ items: [rawAbruzzo()], order_type: "pickup" }, [
      { role: "user", content: "Quiero una Abruzzo" },
      { role: "user", content: "Soy alérgica a los langostinos" }
    ], callId);
    assert.strictEqual(declaredLater.ok, false);
    assert.strictEqual(declaredLater.total_eur, null, "no debe autorizar resumen con total");
    assert.strictEqual(declaredLater.requiredAction, "resolve_allergen_conflict");

    const removed = computeQuote({
      items: [rawAbruzzo([{ type: "remove", value: "langostinos" }])], order_type: "pickup"
    }, [
      { role: "user", content: "Soy alérgica a los langostinos" },
      { role: "user", content: "Sí, quítalos" }
    ], callId);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(removed.requiredAction, null);
    assert.strictEqual(getOrCreateOrderSession(callId).requiredAction, null);

    const readded = computeQuote({ items: [rawAbruzzo()], order_type: "pickup" }, [
      { role: "user", content: "Soy alérgica a los langostinos" },
      { role: "user", content: "Al final déjala como viene" }
    ], callId);
    assert.strictEqual(readded.ok, false);
    assert.strictEqual(readded.requiredAction, "resolve_allergen_conflict");
    assert.strictEqual(getOrCreateOrderSession(callId).requiredAction, "resolve_allergen_conflict");
  });

  await test("4. submit_order pendiente niega persistencia y dispatch", async () => {
    reset();
    const result = await handleSubmitOrder("model-forces-submit", {
      items: [rawAbruzzo()],
      order_type: "pickup",
      customer_name: "Ana",
      phone: "623456789",
      allergies: ["langostinos"]
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.delivered, false);
    assert.strictEqual(result.reason, "allergen_conflict_pending");
    assert((result.validation.errors || []).some(error => error.code === "ALLERGEN_CONFLICT_PENDING"));
    noEffects("submit pendiente");
  });

  await test("5. B&B sin conflicto no genera alerta falsa", async () => {
    reset();
    const validation = validateOrder(order([
      { menu_item_id: "pizza_bb", quantity: 1, modifiers: [] }
    ], ["langostinos"]));
    assert.strictEqual(validation.ok, true);
    assert.strictEqual(validation.requiredAction, null);
    assert(!validation.allergenConflicts.some(conflict => conflict.severity === "CONFLICT"));
  });

  await test("modificadores añadidos también participan en el cross-check", async () => {
    reset();
    const validation = validateOrder(order([{
      menu_item_id: "pizza_bb",
      quantity: 1,
      modifiers: [{ type: "extra", value: "gambas" }]
    }], ["langostinos"]));
    assert.strictEqual(validation.ok, false);
    assert.strictEqual(validation.requiredAction, "resolve_allergen_conflict");
    const conflict = pending(validation);
    assert(conflict, "el extra alergénico no creó conflicto");
    assert.strictEqual(conflict.source, "modifier");
  });

  console.log(`\n${passed} escenarios ok / 0 fail`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
