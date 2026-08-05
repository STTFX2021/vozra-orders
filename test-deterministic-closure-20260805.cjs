"use strict";

const assert = require("assert");
const Module = require("module");

const effects = { dispatch: 0, persist: 0, print: 0, notify: 0, customer: 0, allergyWrites: 0 };
let profileReadFails = false;
let profileWriteFails = false;
let allergyWriteFails = false;
let storedAllergies = [];

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent && /marta-llm\.service\.js$/.test(parent.filename || "")) {
    if (request === "./dispatch-adapter.service.js") return { dispatchOrder: async order => {
      effects.dispatch++;
      return { ok: true, delivered: true, channel: "test", order: { ...order, status: "sent_to_kitchen", dispatchChannel: "test" } };
    } };
    if (request === "./supabase-store.js") return { upsertOrder: async () => { effects.persist++; return { ok: true }; } };
    if (request === "./print-queue.store.js") return { enqueuePrint: () => { effects.print++; } };
    if (request === "./customer-notify.service.js") return { sendCustomerConfirmation: async () => { effects.notify++; return { ok: true }; } };
    if (request === "./kitchen-ack-monitor.service.js") return { startKitchenWatch: () => {} };
    if (request === "./customer-store.js") return {
      getCustomerByPhone: async phone => {
        if (profileReadFails) throw new Error("profile read failed");
        return storedAllergies.length ? { phone, name: "Ana", restrictions: { allergies: [...storedAllergies], preferences: [] } } : null;
      },
      upsertCustomer: async data => {
        effects.customer++;
        if (profileWriteFails) return { ok: false, reason: "profile_write_failed" };
        if (data.restrictions) storedAllergies = [...data.restrictions.allergies];
        return { ok: true };
      },
      updateCustomerAllergies: async data => {
        effects.allergyWrites++;
        if (allergyWriteFails) return { ok: false, reason: "allergy_write_failed" };
        const removed = new Set((data.removeAllergies || []).map(x => String(x).toLowerCase()));
        storedAllergies = [...new Set([...storedAllergies, ...(data.addAllergies || [])])].filter(x => !removed.has(String(x).toLowerCase()));
        return { ok: true, allergies: [...storedAllergies] };
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const marta = require("./marta-llm.service.js");
const store = require("./order-call-session.store.js");
Module._load = originalLoad;

const argsFor = (phone, extra = false) => ({
  items: [{ menu_item_id: "pizza_bb", quantity: 1, modifiers: extra ? [{ type: "extra", value: "cebolla" }] : [] }],
  order_type: "pickup", customer_name: "Ana", phone, payment_method: "cash", save_profile_consent: false
});

async function reachSummary(callId, args, base = []) {
  const offer = await marta.handleSubmitOrder(callId, args, base);
  assert.strictEqual(offer.reason, "upsell_required");
  const history = [...base, { role: "assistant", content: offer.reply }, { role: "user", content: "No, seguimos" }];
  let next = await marta.handleSubmitOrder(callId, args, history);
  if (next.reason === "surcharge_acceptance_required") {
    history.push({ role: "assistant", content: next.reply }, { role: "user", content: "Sí" });
    next = await marta.handleSubmitOrder(callId, args, history);
  }
  assert.strictEqual(next.reason, "summary_required");
  return { summary: next, history };
}

async function dispatchFromSummary(callId, args, flow) {
  return marta.handleSubmitOrder(callId, args, [
    ...flow.history,
    { role: "assistant", content: flow.summary.reply },
    { role: "user", content: "Sí" }
  ]);
}

(async () => {
  store.clearAllSessionsForTests();

  const first = await marta.handleSubmitOrder("upsell-once", argsFor("600100001"));
  assert.strictEqual(first.reason, "upsell_required");
  const second = await marta.handleSubmitOrder("upsell-once", argsFor("600100001"));
  assert.strictEqual(second.reason, "upsell_decision_required");
  assert.strictEqual(store.getOrderSession("upsell-once").upsellState, "offered");

  store.clearAllSessionsForTests();
  const extraArgs = argsFor("600100002", true);
  const extraOffer = await marta.handleSubmitOrder("extras", extraArgs);
  const base = [{ role: "assistant", content: extraOffer.reply }, { role: "user", content: "No, seguimos" }];
  const total = await marta.handleSubmitOrder("extras", extraArgs, base);
  assert.strictEqual(total.reason, "surcharge_acceptance_required");
  assert(/suplementos en total/i.test(total.reply));
  assert(!/desglose/i.test(total.reply));
  const detail = await marta.handleSubmitOrder("extras", extraArgs, [...base, { role: "assistant", content: total.reply }, { role: "user", content: "¿Me das el desglose?" }]);
  assert(/desglose de suplementos/i.test(detail.reply));
  const oldFingerprint = detail.order.draftFingerprint;
  const changedArgs = { ...extraArgs, items: [{ ...extraArgs.items[0], quantity: 2 }] };
  const changed = await marta.handleSubmitOrder("extras", changedArgs, [{ role: "assistant", content: detail.reply }, { role: "user", content: "Sí" }]);
  assert.notStrictEqual(changed.order.draftFingerprint, oldFingerprint);
  assert.notStrictEqual(changed.order.surchargeAcceptance, "accepted");

  store.clearAllSessionsForTests();
  const mutationArgs = argsFor("600100003");
  const flow = await reachSummary("mutation", mutationArgs);
  const revisedArgs = { ...mutationArgs, items: [{ menu_item_id: "pizza_bb", quantity: 2 }] };
  const revised = await marta.handleSubmitOrder("mutation", revisedArgs, [{ role: "assistant", content: flow.summary.reply }, { role: "user", content: "Sí" }]);
  assert.strictEqual(revised.reason, "summary_required");
  assert.strictEqual(revised.order.confirmationFingerprint, null);
  assert.strictEqual(revised.order.upsellState, "rejected");

  store.clearAllSessionsForTests();
  const closeArgs = argsFor("600100004");
  const closeFlow = await reachSummary("closure", closeArgs);
  const closed = await dispatchFromSummary("closure", closeArgs, closeFlow);
  assert.strictEqual(closed.ok, true);
  assert.strictEqual(closed.endCall, true);
  assert.strictEqual(closed.order.closureState, "ended");
  assert.strictEqual(closed.order.farewellCount, 1);
  assert.strictEqual(closed.order.endCallIssued, true);
  const dispatchCount = effects.dispatch;
  const repeated = await marta.handleSubmitOrder("closure", closeArgs, []);
  assert.strictEqual(repeated.alreadyDone, true);
  assert.strictEqual(repeated.reply, "");
  assert.strictEqual(repeated.endCall, true);
  assert.strictEqual(effects.dispatch, dispatchCount);
  assert.strictEqual(store.getOrderSession("closure").farewellCount, 1);

  assert.strictEqual(marta.explicitConsentEvidence([{ role: "user", content: "Sí" }]), null);
  const evidence = marta.explicitConsentEvidence([
    { role: "assistant", content: "¿Quieres que guarde tu nombre y dirección? Solo si me das permiso." },
    { role: "user", content: "Sí" }
  ]);
  assert(evidence && evidence.assistantText && evidence.userText);
  assert.strictEqual(store.recordConsentDecision("consent", "granted", null).ok, false);
  assert.strictEqual(store.recordConsentDecision("consent", "granted", evidence).ok, true);

  store.clearAllSessionsForTests();
  const forcedArgs = { ...argsFor("600100005"), save_profile_consent: true };
  const forcedFlow = await reachSummary("forced-consent", forcedArgs);
  const customersBefore = effects.customer;
  await dispatchFromSummary("forced-consent", forcedArgs, forcedFlow);
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(effects.customer, customersBefore, "el booleano del modelo persistió sin evidencia");
  assert.notStrictEqual(store.getOrderSession("forced-consent").consentState, "granted");

  store.clearAllSessionsForTests();
  const verifiedArgs = { ...argsFor("600100008"), save_profile_consent: true };
  const verifiedFlow = await reachSummary("verified-consent", verifiedArgs);
  const consentHistory = [
    ...verifiedFlow.history,
    { role: "assistant", content: verifiedFlow.summary.reply }, { role: "user", content: "Sí" },
    { role: "assistant", content: "¿Quieres que guarde tu nombre y dirección? Solo si me das permiso." }, { role: "user", content: "Sí" }
  ];
  const verified = await marta.handleSubmitOrder("verified-consent", verifiedArgs, consentHistory);
  assert.strictEqual(verified.ok, true);
  assert.strictEqual(verified.order.consentState, "granted");
  assert(verified.order.consentEvidence && verified.order.consentEvidence.assistantText);
  assert.strictEqual(verified.order.profilePersistenceStatus, "stored");

  store.clearAllSessionsForTests();
  profileWriteFails = true;
  const failedProfileArgs = { ...argsFor("600100009"), save_profile_consent: true };
  const failedProfileFlow = await reachSummary("profile-write", failedProfileArgs);
  const failedProfile = await marta.handleSubmitOrder("profile-write", failedProfileArgs, [
    ...failedProfileFlow.history,
    { role: "assistant", content: failedProfileFlow.summary.reply }, { role: "user", content: "Sí" },
    { role: "assistant", content: "¿Quieres que guarde tus datos? Solo si me das permiso." }, { role: "user", content: "Sí" }
  ]);
  assert.strictEqual(failedProfile.ok, true, "el fallo del perfil no debe deshacer un pedido ya enviado");
  assert.strictEqual(failedProfile.order.profilePersistenceStatus, "failed");
  assert.strictEqual(failedProfile.order.profilePersistenceError, "profile_write_failed");
  profileWriteFails = false;

  storedAllergies = [];
  store.clearAllSessionsForTests();
  store.getOrCreateOrderSession("allergy-1").registeredRestrictions = { allergies: [] };
  store.getOrCreateOrderSession("allergy-1").registeredFound = true;
  const saved = await marta.synchronizeAllergiesForTurn("allergy-1", [{ role: "user", content: "Soy alérgica al marisco" }], "600100006");
  assert.strictEqual(saved.ok, true);
  assert(storedAllergies.includes("marisco"));
  const recovered = store.getOrCreateOrderSession("allergy-2");
  recovered.registeredRestrictions = { allergies: [...storedAllergies] };
  recovered.registeredFound = true;
  const unchanged = await marta.synchronizeAllergiesForTurn("allergy-2", [{ role: "user", content: "Quiero una pizza" }], "600100006");
  assert.strictEqual(unchanged.ok, true);
  assert(recovered.registeredRestrictions.allergies.includes("marisco"));

  allergyWriteFails = true;
  const failedWrite = await marta.synchronizeAllergiesForTurn("allergy-2", [{ role: "user", content: "También soy alérgica al gluten" }], "600100006");
  assert.strictEqual(failedWrite.ok, false);
  assert.strictEqual(failedWrite.requiredAction, "resolve_allergy_persistence");
  allergyWriteFails = false;

  const newCustomer = await marta.synchronizeAllergiesForTurn("allergy-new", [{ role: "user", content: "Soy alérgica a los frutos secos" }], "600100010");
  assert.strictEqual(newCustomer.ok, true);
  assert.strictEqual(newCustomer.deferred, true);
  assert.strictEqual(newCustomer.order.allergyPersistenceStatus, "deferred_until_consent");

  profileReadFails = true;
  const failedRead = await marta.generateMartaReply("profile-read", [{ role: "user", content: "Hola" }], "600100007");
  assert.strictEqual(failedRead.requiredAction, "resolve_profile_read");
  profileReadFails = false;

  console.log("✅ Deterministic closure: allergy profile, upsell, extras, versioning, summary, consent and End Call PASS");
})().catch(error => {
  console.error("❌ Deterministic closure:", error.stack || error);
  process.exitCode = 1;
});
