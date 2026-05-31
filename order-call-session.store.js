"use strict";

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
  clearAllSessionsForTests
};
