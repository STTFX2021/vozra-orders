"use strict";

const assert = require("assert");
const Module = require("module");
const effects = { persist: 0, dispatch: 0, print: 0, notify: 0, watch: 0 };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /marta-llm\.service\.js$/.test(parent.filename || "")) {
    if (request === "./dispatch-adapter.service.js") return { dispatchOrder: async order => { effects.dispatch++; return { ok: true, delivered: true, channel: "test", order: { ...order, status: "sent_to_kitchen", dispatchChannel: "test" } }; } };
    if (request === "./supabase-store.js") return { upsertOrder: async () => { effects.persist++; return { ok: true }; } };
    if (request === "./print-queue.store.js") return { enqueuePrint: () => { effects.print++; } };
    if (request === "./customer-notify.service.js") return { sendCustomerConfirmation: async () => { effects.notify++; return { ok: true }; } };
    if (request === "./kitchen-ack-monitor.service.js") return { startKitchenWatch: () => { effects.watch++; } };
    if (request === "./customer-store.js") return { getCustomerByPhone: async () => null, upsertCustomer: async () => ({ ok: true }), updateCustomerAllergies: async () => ({ ok: true, allergies: [] }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const marta = require("./marta-llm.service.js");
const store = require("./order-call-session.store.js");
const { validateOrder } = require("./order-validator.service.js");
Module._load = originalLoad;

const baseArgs = phone => ({
  items: [{ menu_item_id: "pizza_bb", quantity: 1 }], order_type: "pickup",
  customer_name: "Ana", phone, payment_method: "cash", save_profile_consent: false
});
const finalYes = summary => [{ role: "assistant", content: summary }, { role: "user", content: "Sí" }];
const effectCount = () => Object.values(effects).reduce((a, b) => a + b, 0);

async function summaryFor(callId, args, prior = []) {
  let history = [...prior];
  let result = await marta.handleSubmitOrder(callId, args, history);
  if (result.reason === "upsell_required") {
    history.push({ role: "assistant", content: result.reply }, { role: "user", content: "No, seguimos" });
    result = await marta.handleSubmitOrder(callId, args, history);
  }
  if (result.reason === "surcharge_acceptance_required") {
    history.push({ role: "assistant", content: result.reply }, { role: "user", content: "Sí" });
    result = await marta.handleSubmitOrder(callId, args, history);
  }
  assert.strictEqual(result.reason, "summary_required");
  return { result, history };
}

async function confirmSummary(callId, args, flow) {
  return marta.handleSubmitOrder(callId, args, [...flow.history, ...finalYes(flow.result.reply)]);
}

(async () => {
  store.clearAllSessionsForTests();
  const item = marta.mapToolItem({ menu_item_id: "pizza_bb", quantity: 1 });
  const first = store.applyDraftSnapshot("state", { items: [item], orderType: "pickup", allergies: [], paymentMethod: "cash" });
  assert.strictEqual(first.order.draftRevision, 1);
  const duplicate = store.applyDraftSnapshot("state", { items: [item], orderType: "pickup", allergies: [], paymentMethod: "cash" });
  assert.strictEqual(duplicate.changed, false);
  assert.strictEqual(duplicate.order.draftRevision, 1, "payload repetido incrementó la revisión");
  const fp1 = store.getOrderSession("state").draftFingerprint;
  store.recordValidation("state", { ok: true, errors: [] });
  store.recordQuote("state", 12, []);
  store.recordUpsellOffer("state", "Oferta única");
  store.resolveUpsell("state", "rejected");
  assert.strictEqual(store.getOrderSession("state").quoteRevision, 1);
  assert.strictEqual(store.getOrderSession("state").quoteFingerprint, fp1);
  store.recordSummary("state", "Resumen vigente");
  assert.strictEqual(store.getOrderSession("state").summaryRevision, 1);
  assert.strictEqual(store.getOrderSession("state").summaryFingerprint, fp1);
  store.recordConfirmation("state", fp1);
  assert.strictEqual(store.getOrderSession("state").confirmationRevision, 1);
  assert.strictEqual(store.getOrderSession("state").confirmationFingerprint, fp1);
  assert.strictEqual(store.getOrderSession("state").safeToDispatch, true);
  const changed = store.applyDraftSnapshot("state", { items: [{ ...item, quantity: 2 }], orderType: "pickup", allergies: [], paymentMethod: "cash" });
  assert.strictEqual(changed.order.draftRevision, 2);
  assert.strictEqual(changed.order.quoteFingerprint, null);
  assert.strictEqual(changed.order.summaryFingerprint, null);
  assert.strictEqual(changed.order.confirmationFingerprint, null);
  assert.strictEqual(changed.order.safeToDispatch, false);

  store.clearAllSessionsForTests();
  store.applyDraftSnapshot("extra", { items: [item], orderType: "pickup", allergies: [], paymentMethod: "cash" });
  store.recordValidation("extra", { ok: true, errors: [] });
  store.recordQuote("extra", 13.5, [{ extra: "Ingrediente extra", importe_eur: 1.5 }]);
  store.recordUpsellOffer("extra", "Oferta única");
  store.resolveUpsell("extra", "rejected");
  let extra = store.getOrderSession("extra");
  assert.strictEqual(extra.surchargeAcceptance, "pending");
  assert(extra.unresolvedActions.includes("obtain_surcharge_acceptance"));
  assert.strictEqual(store.recordSummary("extra", "Resumen con extra").ok, false);
  assert.strictEqual(store.acceptSurcharges("extra", "obsolete").ok, false);
  store.recordSurchargeCommunication("extra", "Suplementos en total: 1,50 euros");
  assert.strictEqual(store.acceptSurcharges("extra", extra.draftFingerprint).ok, true);
  assert.strictEqual(store.recordSummary("extra", "Resumen con extra").ok, true);

  const invalidMapped = marta.mapToolItem({ menu_item_id: "producto_que_no_existe", quantity: 1 });
  const invalidValidation = validateOrder({ items: [invalidMapped], orderType: "pickup", customerName: "Ana", phone: "612345678", allergies: [], flags: {} });
  assert.strictEqual(invalidValidation.ok, false);
  assert(invalidValidation.errors.some(e => e.code === "ITEM_NOT_IN_MENU"));

  // A-C. Cotizar no equivale a entregar resumen. Solo el resumen determinista
  // devuelto por runtime habilita una confirmación del turno siguiente.
  store.clearAllSessionsForTests();
  const quotedOnlyArgs = baseArgs("600000001");
  const quotedOnly = marta.computeQuote(quotedOnlyArgs, [{ role: "user", content: "¿Cuánto es mi pedido?" }], "quote-only");
  assert.strictEqual(quotedOnly.ok, true);
  assert.strictEqual(store.getOrderSession("quote-only").quoteFingerprint, store.getOrderSession("quote-only").draftFingerprint);
  assert.strictEqual(store.getOrderSession("quote-only").summaryFingerprint, null, "calcular_total marcó resumen prematuramente");
  const omittedBefore = effectCount();
  const offered = await marta.handleSubmitOrder("quote-only", quotedOnlyArgs, [
    { role: "assistant", content: "El total está calculado." },
    { role: "user", content: "Sí" }
  ]);
  assert.strictEqual(offered.reason, "upsell_required");
  const omitted = await marta.handleSubmitOrder("quote-only", quotedOnlyArgs, [
    { role: "assistant", content: offered.reply }, { role: "user", content: "No, seguimos" }
  ]);
  assert.strictEqual(omitted.reason, "summary_required");
  assert.strictEqual(omitted.requiredAction, "present_current_summary");
  assert.strictEqual(omitted.order.confirmationFingerprint, null);
  assert.strictEqual(effectCount(), omittedBefore, "un sí sin resumen entregado produjo efectos");
  const deliveredSummary = await marta.handleSubmitOrder("quote-only", quotedOnlyArgs, finalYes(omitted.reply));
  assert.strictEqual(deliveredSummary.ok, true);
  assert.strictEqual(deliveredSummary.order.confirmationFingerprint, deliveredSummary.order.draftFingerprint);

  // D-E. La acción externa conserva el estado transaccional exacto.
  assert.strictEqual(marta.submitResultAction({ ok: false, delivered: false, requiredAction: "present_current_summary" }), "present_current_summary");
  assert.strictEqual(marta.submitResultAction({ ok: false, delivered: false, requiredAction: "obtain_surcharge_acceptance" }), "obtain_surcharge_acceptance");

  // F-G. El tipo de pedido es enumerado y fail-closed; ambos valores válidos
  // conservan el flujo resumen → confirmación.
  store.clearAllSessionsForTests();
  const typeEffects = effectCount();
  const missingQuote = marta.computeQuote({ items: [{ menu_item_id: "pizza_bb", quantity: 1 }] }, [{ role: "user", content: "Calcula el total" }], "missing-type-quote");
  assert.strictEqual(missingQuote.ok, false);
  assert.strictEqual(missingQuote.requiredAction, "resolve_order_type");
  assert.strictEqual(store.getOrderSession("missing-type-quote").quoteFingerprint, null);
  assert.strictEqual(store.getOrderSession("missing-type-quote").safeToQuote, false);
  const missingType = await marta.handleSubmitOrder("missing-type", { ...baseArgs("600000002"), order_type: undefined });
  assert.strictEqual(missingType.requiredAction, "resolve_order_type");
  assert.strictEqual(missingType.order.orderType, null);
  const invalidType = await marta.handleSubmitOrder("invalid-type", { ...baseArgs("600000003"), order_type: "takeaway_maybe" });
  assert.strictEqual(invalidType.requiredAction, "resolve_order_type");
  // 16-08: el valor fuera del enum ya NO se guarda en la ficha. Antes se
  // conservaba tal cual ("takeaway_maybe") por diagnóstico, pero un orderType con
  // basura es truthy y engaña a cualquier `if (session.orderType)`. Ahora se
  // normaliza a null y el rastro va al log ([GATE] order_type fuera del enum).
  // LO QUE DE VERDAD PROTEGE ESTE TEST es la línea de arriba: un tipo inválido
  // NUNCA pasa el gate. Eso no ha cambiado.
  assert.strictEqual(invalidType.order.orderType, null);
  assert.strictEqual(effectCount(), typeEffects, "tipo ausente/inválido produjo efectos");
  const pickupSummary = await summaryFor("valid-pickup", baseArgs("600000004"));
  assert.strictEqual((await confirmSummary("valid-pickup", baseArgs("600000004"), pickupSummary)).ok, true);
  const deliveryArgs = { ...baseArgs("600000005"), order_type: "delivery", address: "Calle Mayor 10" };
  const deliverySummary = await summaryFor("valid-delivery", deliveryArgs);
  assert.strictEqual((await confirmSummary("valid-delivery", deliveryArgs, deliverySummary)).ok, true);

  store.clearAllSessionsForTests();
  store.applyDraftSnapshot("ratio", { items: [{ ...item, category: "pizza_bianca", quantity: 5 }], orderType: "pickup" });
  const ratio = marta.resolvePerPizzaQuantities({ items: [{ menu_item_id: "coca_cola", quantity: 1 }] }, [{ role: "user", content: "una Coca-Cola por cada pizza" }], store.getOrderSession("ratio").draftItems);
  assert.strictEqual(ratio.items[0].quantity, 5);

  const infoQuote = marta.computeQuote({ items: [{ menu_item_id: "pizza_bb", quantity: 1 }] }, [{ role: "user", content: "¿Qué lleva la B&B?" }], "info");
  assert.strictEqual(infoQuote.informationalOnly, true);
  assert.strictEqual(store.getOrderSession("info").draftRevision, 0, "una pregunta informativa mutó el borrador");
  marta.computeQuote({ items: [{ menu_item_id: "pizza_bb", quantity: 1 }], order_type: "pickup" }, [{ role: "user", content: "Ponme una B&B" }], "info");
  const bb = store.getOrderSession("info");
  assert.strictEqual(bb.items.length, 1);
  assert.strictEqual(store.applyDraftSnapshot("info", { items: [item], orderType: "pickup" }).order.items.length, 1);

  store.clearAllSessionsForTests();
  const zeroBefore = effectCount();
  const nonexistent = await marta.handleSubmitOrder("bad-product", { ...baseArgs("611111111"), items: [{ menu_item_id: "producto_que_no_existe", quantity: 1 }] });
  assert.strictEqual(nonexistent.ok, false);
  assert.strictEqual(effectCount(), zeroBefore, "producto inexistente produjo efectos");

  const oldFlow = await summaryFor("stale", baseArgs("622222222"));
  const oldSummary = oldFlow.result;
  const staleBefore = effectCount();
  const stale = await marta.handleSubmitOrder("stale", { ...baseArgs("622222222"), items: [{ menu_item_id: "pizza_bb", quantity: 2 }] }, finalYes(oldSummary.reply));
  assert.strictEqual(stale.reason, "summary_required");
  assert.strictEqual(stale.order.confirmationFingerprint, null);
  assert.strictEqual(effectCount(), staleBefore, "confirmación obsoleta produjo efectos");
  const allowed = await marta.handleSubmitOrder("stale", { ...baseArgs("622222222"), items: [{ menu_item_id: "pizza_bb", quantity: 2 }] }, finalYes(stale.reply));
  assert.strictEqual(allowed.ok, true);
  assert.strictEqual(allowed.order.confirmationFingerprint, allowed.order.draftFingerprint);
  assert.strictEqual(allowed.order.safeToDispatch, true);

  const allergenArgs = { ...baseArgs("633333333"), items: [{ menu_item_id: "pizza_abruzzo", quantity: 1, modifiers: [{ type: "remove", value: "langostinos" }] }], allergies: ["langostinos"] };
  const allergenFlow = await summaryFor("allergen-yes", allergenArgs);
  const allergenFirst = allergenFlow.result;
  const allergenBefore = effectCount();
  const notFinal = await marta.handleSubmitOrder("allergen-yes", { ...baseArgs("633333333"), items: [{ menu_item_id: "pizza_abruzzo", quantity: 1, modifiers: [{ type: "remove", value: "langostinos" }] }], allergies: ["langostinos"] }, [{ role: "assistant", content: "¿Retiro los langostinos?" }, { role: "user", content: "Sí" }]);
  assert.strictEqual(notFinal.reason, "final_confirmation_required");
  assert.strictEqual(effectCount(), allergenBefore, "sí de alérgeno confirmó el pedido");

  const surchargeArgs = { ...baseArgs("644444444"), items: [{ menu_item_id: "pizza_bb", quantity: 1, modifiers: [{ type: "extra", value: "cebolla" }] }] };
  const surchargeFlow = await summaryFor("surcharge", surchargeArgs);
  const surcharge3 = await confirmSummary("surcharge", surchargeArgs, surchargeFlow);
  assert.strictEqual(surcharge3.ok, true);

  const onceFlow = await summaryFor("once", baseArgs("655555555"));
  const once1 = onceFlow.result;
  const once2 = await confirmSummary("once", baseArgs("655555555"), onceFlow);
  assert.strictEqual(once2.ok, true);
  const dispatchAfter = effects.dispatch;
  const once3 = await marta.handleSubmitOrder("once", baseArgs("655555555"), finalYes(once1.reply));
  assert.strictEqual(once3.alreadyDone, true);
  assert.strictEqual(effects.dispatch, dispatchAfter, "reintento duplicó dispatch");

  console.log("✅ Transactional authority: revisions, fingerprints, quote, surcharge, summary, confirmation and effects PASS");
})().catch(error => { console.error("❌ Transactional authority:", error.stack || error); process.exitCode = 1; });
