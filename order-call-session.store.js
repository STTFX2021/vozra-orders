"use strict";

const crypto = require("crypto");

/**
 * VOZRA ORDERS — Order Call Session Store
 * Mismo patrón que Vozra Reservations (vapi-call-session.store.js)
 * adaptado al lifecycle de pedidos con 11 estados.
 *
 * Estado en memoria por callId. TTL: 2h.
 */

const TTL_MS = 2 * 60 * 60 * 1000;
const sessions = new Map();

// ─── LIFECYCLE STATES ────────────────────────────────────────────────────────

const ORDER_STATUS = {
  DRAFT: "draft",
  AWAITING_CONFIRMATION: "awaiting_customer_confirmation",
  CUSTOMER_CONFIRMED: "customer_confirmed",
  SENT_TO_KITCHEN: "sent_to_kitchen",
  KITCHEN_ACKNOWLEDGED: "kitchen_acknowledged",
  ACCEPTED_BY_KITCHEN: "accepted_by_kitchen",
  REJECTED_BY_KITCHEN: "rejected_by_kitchen",
  CANCELLED_BY_CUSTOMER: "cancelled_by_customer",
  FAILED_DISPATCH: "failed_dispatch",
  KITCHEN_NOT_ACKNOWLEDGED: "kitchen_not_acknowledged"
};

const VALID_TRANSITIONS = {
  [ORDER_STATUS.DRAFT]: [
    ORDER_STATUS.AWAITING_CONFIRMATION,
    ORDER_STATUS.CANCELLED_BY_CUSTOMER
  ],
  [ORDER_STATUS.AWAITING_CONFIRMATION]: [
    ORDER_STATUS.CUSTOMER_CONFIRMED,
    ORDER_STATUS.DRAFT, // si cliente corrige
    ORDER_STATUS.CANCELLED_BY_CUSTOMER
  ],
  [ORDER_STATUS.CUSTOMER_CONFIRMED]: [
    ORDER_STATUS.SENT_TO_KITCHEN,
    ORDER_STATUS.FAILED_DISPATCH
  ],
  [ORDER_STATUS.SENT_TO_KITCHEN]: [
    ORDER_STATUS.KITCHEN_ACKNOWLEDGED,
    ORDER_STATUS.KITCHEN_NOT_ACKNOWLEDGED
  ],
  [ORDER_STATUS.KITCHEN_ACKNOWLEDGED]: [
    ORDER_STATUS.ACCEPTED_BY_KITCHEN,
    ORDER_STATUS.REJECTED_BY_KITCHEN
  ],
  [ORDER_STATUS.KITCHEN_NOT_ACKNOWLEDGED]: [
    ORDER_STATUS.KITCHEN_ACKNOWLEDGED // si cocina responde tarde
  ],
  // terminales
  [ORDER_STATUS.ACCEPTED_BY_KITCHEN]: [],
  [ORDER_STATUS.REJECTED_BY_KITCHEN]: [],
  [ORDER_STATUS.CANCELLED_BY_CUSTOMER]: [],
  [ORDER_STATUS.FAILED_DISPATCH]: []
};

// ─── SESSION FACTORY ─────────────────────────────────────────────────────────

function createEmptyOrder(callId) {
  return {
    // Metadatos
    orderId: `ORD-${new Date().toISOString().slice(0,10).replace(/-/g,"")}-${String(Math.floor(Math.random()*9000)+1000)}`,
    callId,
    status: ORDER_STATUS.DRAFT,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: Date.now() + TTL_MS,

    // Cliente
    customerName: null,
    phone: null,
    phoneConfirmed: false,
    phoneAttempts: 0,

    // Tipo de pedido
    orderType: null, // "pickup" | "delivery"
    address: {
      street: null,
      number: null,
      floor: null,
      city: null,
      raw: null
    },

    // Productos (array de items)
    items: [],

    // Restricciones
    allergies: [],
    allergyNotes: null,
    allergenConflicts: [],
    requiredAction: null,
    draftItems: [],
    draftRevision: 0,
    draftFingerprint: null,
    validationStatus: "not_validated",
    unresolvedActions: [],
    quoteRevision: null,
    quoteFingerprint: null,
    quotedTotal: null,
    quotedSurcharges: [],
    surchargeAcceptance: "not_required",
    summaryRevision: null,
    summaryFingerprint: null,
    summaryText: null,
    confirmationRevision: null,
    confirmationFingerprint: null,
    confirmedSnapshot: null,
    safeToQuote: false,
    safeToSummarize: false,
    safeToConfirm: false,
    safeToDispatch: false,

    // Pago
    paymentMethod: null,

    // Estimaciones
    estimatedTotal: null,

    // Confidence
    confidence: {
      product: null,
      modifier: null,
      address: null,
      phone: null,
      overall: null
    },

    // Flags de revisión interna
    flags: {
      requiresKitchenReview: false,
      requiresProviderReview: false,
      lowConfidence: false,
      allergyRisk: false,
      addressRisk: false,
      productAmbiguity: false,
      deliveryRisk: false
    },

    // Dispatch
    dispatchChannel: null,
    dispatchAt: null,
    dispatchAckAt: null,
    kitchenAckAt: null,

    // Control de conversación
    turns: 0,
    lastText: null,
    confirmationAttempts: 0,
    notes: null,

    // Ledger de eventos
    events: []
  };
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function nowMs() { return Date.now(); }

function safeCallId(callId) {
  return String(callId || "unknown_call").trim() || "unknown_call";
}

function pruneExpiredSessions() {
  const current = nowMs();
  for (const [id, session] of sessions.entries()) {
    if (!session.expiresAt || session.expiresAt < current) {
      sessions.delete(id);
    }
  }
}

function addEvent(order, eventType, detail = "") {
  order.events.push({
    eventType,
    timestamp: new Date().toISOString(),
    status: order.status,
    detail
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.keys(value).sort().reduce((out, key) => {
    if (value[key] !== undefined) out[key] = stableValue(value[key]);
    return out;
  }, {});
  return value;
}

function transactionSnapshot(value = {}) {
  const address = value.address && Object.values(value.address).some(part => part != null && String(part).trim())
    ? value.address : null;
  return stableValue({
    items: value.items || value.draftItems || [],
    orderType: value.orderType || null,
    address,
    allergies: [...(value.allergies || [])].map(String).sort(),
    paymentMethod: value.paymentMethod || null
  });
}

function fingerprintDraft(value) {
  return crypto.createHash("sha256").update(JSON.stringify(transactionSnapshot(value))).digest("hex");
}

function applyDraftSnapshot(callId, snapshot) {
  const order = getOrCreateOrderSession(callId);
  const canonical = transactionSnapshot(snapshot);
  const fingerprint = fingerprintDraft(canonical);
  if (fingerprint === order.draftFingerprint) return { changed: false, order };
  const updated = updateOrderSession(callId, {
    ...canonical, draftItems: canonical.items,
    draftRevision: order.draftRevision + 1, draftFingerprint: fingerprint,
    validationStatus: "not_validated", unresolvedActions: [],
    quoteRevision: null, quoteFingerprint: null, quotedTotal: null, quotedSurcharges: [],
    surchargeAcceptance: "not_required",
    summaryRevision: null, summaryFingerprint: null, summaryText: null,
    confirmationRevision: null, confirmationFingerprint: null, confirmedSnapshot: null,
    safeToQuote: false, safeToSummarize: false, safeToConfirm: false, safeToDispatch: false,
    status: ORDER_STATUS.DRAFT
  });
  addEvent(updated, "draft_revision", `revision=${updated.draftRevision} fingerprint=${fingerprint}`);
  return { changed: true, order: updated };
}

function recordValidation(callId, validation) {
  const order = getOrCreateOrderSession(callId);
  const actions = [...new Set((((validation || {}).errors) || []).map(e => e.requiredAction || e.code).filter(Boolean))];
  if (validation && validation.requiredAction && !actions.includes(validation.requiredAction)) actions.push(validation.requiredAction);
  const valid = !!(validation && validation.ok === true && actions.length === 0);
  if (order.surchargeAcceptance === "pending" && !actions.includes("obtain_surcharge_acceptance")) actions.push("obtain_surcharge_acceptance");
  const quoteCurrent = order.quoteFingerprint === order.draftFingerprint;
  const surchargeResolved = order.surchargeAcceptance !== "pending";
  const summaryCurrent = order.summaryFingerprint === order.draftFingerprint;
  const confirmationCurrent = order.confirmationFingerprint === order.draftFingerprint;
  return updateOrderSession(callId, { validationStatus: valid ? "valid" : "invalid", unresolvedActions: actions,
    safeToQuote: valid,
    safeToSummarize: valid && quoteCurrent && surchargeResolved,
    safeToConfirm: valid && summaryCurrent && surchargeResolved,
    safeToDispatch: valid && confirmationCurrent && summaryCurrent && surchargeResolved });
}

function recordQuote(callId, total, surcharges = []) {
  const order = getOrCreateOrderSession(callId);
  if (!order.safeToQuote || !order.draftFingerprint) return { ok: false, reason: "draft_not_quotable", order };
  const quotedSurcharges = JSON.parse(JSON.stringify(surcharges));
  const pending = quotedSurcharges.length > 0;
  const updated = updateOrderSession(callId, {
    quoteRevision: order.draftRevision, quoteFingerprint: order.draftFingerprint,
    quotedTotal: total, quotedSurcharges, surchargeAcceptance: pending ? "pending" : "not_required",
    unresolvedActions: pending ? ["obtain_surcharge_acceptance"] : [],
    safeToSummarize: !pending, safeToConfirm: false, safeToDispatch: false
  });
  return { ok: true, order: updated };
}

function acceptSurcharges(callId, fingerprint) {
  const order = getOrCreateOrderSession(callId);
  if (order.surchargeAcceptance !== "pending") return { ok: true, alreadyResolved: true, order };
  if (!fingerprint || fingerprint !== order.quoteFingerprint || fingerprint !== order.draftFingerprint) return { ok: false, reason: "stale_surcharge_acceptance", order };
  return { ok: true, order: updateOrderSession(callId, { surchargeAcceptance: "accepted", unresolvedActions: [], safeToSummarize: order.validationStatus === "valid" }) };
}

function recordSummary(callId, summaryText) {
  const order = getOrCreateOrderSession(callId);
  if (!order.safeToSummarize || order.quoteFingerprint !== order.draftFingerprint) return { ok: false, reason: "draft_not_summarizable", order };
  if (!summaryText || !String(summaryText).trim()) return { ok: false, reason: "summary_not_delivered", order };
  return { ok: true, order: updateOrderSession(callId, {
    summaryRevision: order.draftRevision, summaryFingerprint: order.draftFingerprint, summaryText: String(summaryText).trim(),
    confirmationRevision: null, confirmationFingerprint: null, confirmedSnapshot: null,
    safeToConfirm: true, safeToDispatch: false, status: ORDER_STATUS.AWAITING_CONFIRMATION
  }) };
}

function recordConfirmation(callId, fingerprint) {
  const order = getOrCreateOrderSession(callId);
  if (!order.safeToConfirm || !fingerprint || fingerprint !== order.summaryFingerprint || fingerprint !== order.draftFingerprint) return { ok: false, reason: "stale_or_missing_summary_confirmation", order };
  const confirmedSnapshot = {
    ...transactionSnapshot(order),
    quotedTotal: order.quotedTotal,
    quotedSurcharges: JSON.parse(JSON.stringify(order.quotedSurcharges || []))
  };
  return { ok: true, order: updateOrderSession(callId, {
    confirmationRevision: order.draftRevision, confirmationFingerprint: fingerprint,
    confirmedSnapshot,
    safeToDispatch: true, status: ORDER_STATUS.CUSTOMER_CONFIRMED
  }) };
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

function getOrCreateOrderSession(callId) {
  pruneExpiredSessions();
  const id = safeCallId(callId);
  if (!sessions.has(id)) {
    const order = createEmptyOrder(id);
    addEvent(order, "order_created", `callId=${id}`);
    sessions.set(id, order);
  }
  const session = sessions.get(id);
  session.expiresAt = nowMs() + TTL_MS;
  return session;
}

function updateOrderSession(callId, patch = {}) {
  const order = getOrCreateOrderSession(callId);
  const next = {
    ...order,
    ...patch,
    callId: order.callId,
    orderId: order.orderId,
    updatedAt: new Date().toISOString(),
    expiresAt: nowMs() + TTL_MS,
    events: order.events // preservar ledger
  };
  sessions.set(order.callId, next);
  return next;
}

/**
 * Transiciona el pedido a un nuevo estado.
 * Valida que la transición sea permitida.
 * Retorna { ok, error, order }
 */
function transitionStatus(callId, newStatus) {
  const order = getOrCreateOrderSession(callId);
  const allowed = VALID_TRANSITIONS[order.status] || [];

  if (!allowed.includes(newStatus)) {
    return {
      ok: false,
      error: `Transición inválida: ${order.status} → ${newStatus}. Permitidas: [${allowed.join(", ")}]`,
      order
    };
  }

  const updated = updateOrderSession(callId, { status: newStatus });
  addEvent(updated, "status_change", `${order.status} → ${newStatus}`);
  sessions.set(updated.callId, updated);

  return { ok: true, order: updated };
}

/**
 * Añade un item al pedido.
 * Retorna el pedido actualizado.
 */
function addItemToOrder(callId, item) {
  const order = getOrCreateOrderSession(callId);
  const items = [...(order.items || []), item];
  const updated = updateOrderSession(callId, { items });
  addEvent(updated, "slot_filled", `item añadido: ${item.product}`);
  sessions.set(updated.callId, updated);
  return updated;
}

/**
 * Actualiza un item existente por índice.
 */
function updateItemInOrder(callId, index, patch) {
  const order = getOrCreateOrderSession(callId);
  const items = [...(order.items || [])];
  if (index < 0 || index >= items.length) return order;
  items[index] = { ...items[index], ...patch };
  const updated = updateOrderSession(callId, { items });
  addEvent(updated, "slot_filled", `item[${index}] actualizado`);
  sessions.set(updated.callId, updated);
  return updated;
}

/**
 * Establece un flag de revisión interna.
 */
function setFlag(callId, flagName, value = true) {
  const order = getOrCreateOrderSession(callId);
  const flags = { ...order.flags, [flagName]: value };
  const updated = updateOrderSession(callId, { flags });
  sessions.set(updated.callId, updated);
  return updated;
}

function getOrderSession(callId) {
  pruneExpiredSessions();
  return sessions.get(safeCallId(callId)) || null;
}

function resetOrderSession(callId) {
  const id = safeCallId(callId);
  sessions.delete(id);
  return createEmptyOrder(id);
}

function clearAllSessionsForTests() {
  sessions.clear();
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  ORDER_STATUS,
  VALID_TRANSITIONS,
  getOrCreateOrderSession,
  updateOrderSession,
  transitionStatus,
  addItemToOrder,
  updateItemInOrder,
  setFlag,
  getOrderSession,
  resetOrderSession,
  clearAllSessionsForTests,
  fingerprintDraft,
  transactionSnapshot,
  applyDraftSnapshot,
  recordValidation,
  recordQuote,
  acceptSurcharges,
  recordSummary,
  recordConfirmation
};
