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

  // POLÍTICA DEL OWNER (28-07, reafirmada el 08-08): el alérgeno se ADVIERTE y
  // se ASESORA, pero NO bloquea. Decide el cliente. Este test comprobaba lo
  // contrario — bloquear — y por eso la llamada del 07-08 se fue en un bucle de
  // cuatro turnos con una Abruzzo que el cliente quería igual.
  await test("1. perfil alérgico + Abruzzo se AVISA pero NO bloquea", async () => {
    reset();
    const session = getOrCreateOrderSession("profile-pending");
    session.registeredName = "Ana";
    session.registeredRestrictions = { allergies: ["langostinos"] };
    const result = await handleSubmitOrder("profile-pending", {
      items: [rawAbruzzo()], order_type: "pickup", phone: "612345678"
    });
    assert.notStrictEqual(result.reason, "allergen_conflict_pending",
      "el alérgeno vuelve a tumbar el pedido");
    assert.notStrictEqual(result.validation.requiredAction, "resolve_allergen_conflict",
      "sigue exigiendo resolver el alérgeno antes de seguir");
    // El conflicto tiene que seguir VISIBLE para poder advertirlo y para el ticket.
    assert(pending(result.validation), "se ha perdido el aviso: ya no podría advertir");
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
    // Se avisa, pero el cálculo sigue: el pedido no se detiene por el alérgeno.
    assert.strictEqual(declaredLater.ok, true, "el alérgeno vuelve a frenar el cálculo");
    assert.strictEqual(declaredLater.requiredAction, null, "sigue exigiendo resolverlo");
    assert((declaredLater.allergenAdvisory || []).length > 0,
      "sin aviso, Sarah no tendría con qué advertir al cliente");

    const removed = computeQuote({
      items: [rawAbruzzo([{ type: "remove", value: "langostinos" }])], order_type: "pickup"
    }, [
      { role: "user", content: "Soy alérgica a los langostinos" },
      { role: "user", content: "Sí, quítalos" }
    ], callId);
    assert.strictEqual(removed.ok, true);
    assert.strictEqual(removed.requiredAction, null);
    assert.strictEqual(getOrCreateOrderSession(callId).requiredAction, null);

    // EL CLIENTE MANDA. "Al final déjala como viene" es una decisión suya: se le
    // sirve. Antes esto devolvía ok:false y le dejaba sin cenar.
    const readded = computeQuote({ items: [rawAbruzzo()], order_type: "pickup" }, [
      { role: "user", content: "Soy alérgica a los langostinos" },
      { role: "user", content: "Al final déjala como viene" }
    ], callId);
    assert.strictEqual(readded.ok, true,
      "el cliente ha dicho que la quiere así y se le sigue negando el pedido");
    assert.strictEqual(readded.requiredAction, null);
    assert((readded.allergenAdvisory || []).length > 0,
      "el alérgeno debe seguir constando para que llegue al ticket de cocina");
  });

  await test("4. submit_order con alérgeno declarado NO se niega: va a cocina anotado", async () => {
    reset();
    const result = await handleSubmitOrder("model-forces-submit", {
      items: [rawAbruzzo()],
      order_type: "pickup",
      customer_name: "Ana",
      phone: "623456789",
      allergies: ["langostinos"]
    });
    assert.notStrictEqual(result.reason, "allergen_conflict_pending",
      "el pedido se sigue rechazando por el alérgeno");
    assert(!(result.validation.errors || []).some(e => e.code === "ALLERGEN_CONFLICT_PENDING"),
      "el alérgeno sigue siendo un ERROR bloqueante en vez de un aviso");
    assert((result.validation.warnings || []).some(w => w.code === "ALLERGEN_CONFLICT_PENDING"),
      "el alérgeno tiene que quedar como AVISO, para advertirlo y para el ticket");
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
    // Lo que importa es que el extra alergénico SE DETECTE para poder advertirlo.
    // Ya no tumba el pedido: advertir sí, decidir por el cliente no.
    const conflict = pending(validation);
    assert(conflict, "el extra alergénico no creó conflicto: no se podría advertir");
    assert.strictEqual(conflict.source, "modifier");
    assert.strictEqual(validation.ok, true, "un extra alergénico vuelve a tumbar el pedido");
    assert.strictEqual(validation.requiredAction, null);
    assert(validation.warnings.some(w => w.code === "ALLERGEN_CONFLICT_PENDING"),
      "el conflicto del modificador tiene que quedar como aviso para cocina");
  });

  console.log(`\n${passed} escenarios ok / 0 fail`);
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
