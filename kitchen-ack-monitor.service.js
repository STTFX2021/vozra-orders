"use strict";

/**
 * VOZRA ORDERS — Kitchen ACK Monitor
 * Fase 6: Vigila que cocina confirme la recepción de la comanda.
 *
 * Flujo:
 *   1. Tras dispatchOrder exitoso → pedido en sent_to_kitchen
 *   2. Monitor registra el pedido y arranca el timer
 *   3. Si cocina hace ACK (markKitchenAck) → kitchen_acknowledged → accepted_by_kitchen
 *   4. Si pasan warningMs sin ACK → alerta leve al proveedor
 *   5. Si pasan criticalMs sin ACK → alerta crítica, status kitchen_not_acknowledged
 *
 * "ACK de cocina" en MVP = llamada manual a markKitchenAck(orderId).
 * En producción = reacción/respuesta en Telegram/Discord detectada por webhook.
 *
 * El monitor corre en memoria (no requiere BD externa en MVP).
 * En producción se persiste el estado en Supabase (Fase 7+).
 */

const {
  getOrCreateOrderSession,
  updateOrderSession,
  ORDER_STATUS
} = require("./order-call-session.store.js");

const { getProvider } = require("./provider-profile.config.js");

// ─── ESTADO DEL MONITOR ───────────────────────────────────────────────────────

// Map: orderId → MonitorEntry
// MonitorEntry: { orderId, callId, dispatchedAt, providerSlug, timers, status, alerts }
const _monitored = new Map();

// ─── ALERT HANDLER ────────────────────────────────────────────────────────────

// Por defecto los avisos van a console. En producción: reemplazar con dispatch a canal del proveedor.
let _alertHandler = (level, orderId, message) => {
  const icon = level === "critical" ? "🚨" : "⚠️";
  console.warn(`[KitchenACK] ${icon} ${level.toUpperCase()} | ${orderId} | ${message}`);
};

/**
 * Permite inyectar un handler personalizado (usado en tests y en producción).
 * @param {Function} fn (level, orderId, message) => void
 */
function setAlertHandler(fn) {
  _alertHandler = fn;
}

// ─── MONITOR CORE ─────────────────────────────────────────────────────────────

/**
 * Registra un pedido para monitoreo ACK.
 * Llamar justo después de un dispatch exitoso.
 *
 * @param {string} orderId
 * @param {string} callId
 * @param {string} providerSlug
 * @returns {Object} entry — la entrada del monitor
 */
function watchOrder(orderId, callId, providerSlug = "la-locanda") {
  if (_monitored.has(orderId)) return _monitored.get(orderId);

  const provider = getProvider(providerSlug);
  const { warningMs, criticalMs } = provider.ackTimeout;

  const entry = {
    orderId,
    callId,
    providerSlug,
    dispatchedAt:  new Date().toISOString(),
    dispatchedAtMs: Date.now(),
    status:         "watching",   // watching | warned | critical | acked | cancelled
    alerts:         [],
    timers:         {}
  };

  // ── Timer de advertencia ─────────────────────────────────────────────────
  entry.timers.warning = setTimeout(() => {
    if (entry.status !== "watching") return; // ya fue acked o cancelado
    entry.status = "warned";
    const msg = `Cocina no ha confirmado en ${Math.round(warningMs/60000)} minutos.`;
    entry.alerts.push({ level: "warning", message: msg, at: new Date().toISOString() });
    _alertHandler("warning", orderId, msg);

    // Registrar en el ledger del pedido
    const order = getOrCreateOrderSession(callId);
    order.events.push({
      eventType: "ack_warning",
      timestamp: new Date().toISOString(),
      status:    order.status,
      detail:    msg
    });
  }, warningMs);

  // ── Timer crítico ────────────────────────────────────────────────────────
  entry.timers.critical = setTimeout(() => {
    if (entry.status === "acked" || entry.status === "cancelled") return;
    entry.status = "critical";
    const msg = `Cocina sin confirmar tras ${Math.round(criticalMs/60000)} minutos. Escalando.`;
    entry.alerts.push({ level: "critical", message: msg, at: new Date().toISOString() });
    _alertHandler("critical", orderId, msg);

    // Actualizar status del pedido
    updateOrderSession(callId, { status: ORDER_STATUS.KITCHEN_NOT_ACKNOWLEDGED });
    const order = getOrCreateOrderSession(callId);
    order.events.push({
      eventType: "ack_critical",
      timestamp: new Date().toISOString(),
      status:    ORDER_STATUS.KITCHEN_NOT_ACKNOWLEDGED,
      detail:    msg
    });
  }, criticalMs);

  _monitored.set(orderId, entry);
  return entry;
}

/**
 * Registra el ACK de cocina — para el monitor y transiciona el pedido.
 *
 * En producción: llamado por el webhook del canal (Telegram/Discord)
 * cuando cocina reacciona/responde al mensaje.
 *
 * En MVP: llamado manualmente por el operario o en tests.
 *
 * @param {string} orderId
 * @param {"acknowledged"|"accepted"|"rejected"} ackType
 * @returns {{ ok, entry, order }}
 */
function markKitchenAck(orderId, ackType = "acknowledged") {
  const entry = _monitored.get(orderId);
  if (!entry) {
    return { ok: false, error: `Pedido '${orderId}' no está siendo monitorizado.` };
  }
  if (entry.status === "acked") {
    return { ok: true, entry, alreadyAcked: true };
  }

  // Cancelar timers pendientes
  clearTimeout(entry.timers.warning);
  clearTimeout(entry.timers.critical);
  entry.status = "acked";
  entry.ackedAt = new Date().toISOString();

  // Determinar nuevo status del pedido según tipo de ACK
  const newStatus = ackType === "rejected"
    ? ORDER_STATUS.REJECTED_BY_KITCHEN
    : ackType === "accepted"
    ? ORDER_STATUS.ACCEPTED_BY_KITCHEN
    : ORDER_STATUS.KITCHEN_ACKNOWLEDGED;

  const order = updateOrderSession(entry.callId, {
    status:       newStatus,
    kitchenAckAt: new Date().toISOString()
  });

  order.events.push({
    eventType: `kitchen_${ackType}`,
    timestamp: new Date().toISOString(),
    status:    newStatus,
    detail:    `ACK type: ${ackType}`
  });

  return { ok: true, entry, order, newStatus };
}

/**
 * Cancela el monitoreo de un pedido (p.ej., si fue cancelado por el cliente).
 */
function cancelWatch(orderId) {
  const entry = _monitored.get(orderId);
  if (!entry) return false;
  clearTimeout(entry.timers.warning);
  clearTimeout(entry.timers.critical);
  entry.status = "cancelled";
  _monitored.delete(orderId);
  return true;
}

/**
 * Devuelve el estado del monitor para un pedido.
 */
function getWatchStatus(orderId) {
  return _monitored.get(orderId) || null;
}

/**
 * Lista todos los pedidos en monitoreo activo.
 */
function listWatched() {
  return Array.from(_monitored.values());
}

/**
 * Limpia el monitor (para tests).
 */
function clearAllWatches() {
  for (const entry of _monitored.values()) {
    clearTimeout(entry.timers.warning);
    clearTimeout(entry.timers.critical);
  }
  _monitored.clear();
}

// ─── FLUJO COMPLETO: POST-DISPATCH ────────────────────────────────────────────

/**
 * Helper de alto nivel: llama a watchOrder justo tras un dispatch exitoso.
 * Retorna la entry del monitor.
 *
 * Uso típico:
 *   const dispatchResult = await dispatchOrder(order, v);
 *   if (dispatchResult.ok) {
 *     startKitchenWatch(dispatchResult.order, "la-locanda");
 *   }
 */
function startKitchenWatch(order, providerSlug = "la-locanda") {
  if (!order || !order.orderId || !order.callId) {
    throw new Error("startKitchenWatch: order inválido (falta orderId o callId).");
  }
  if (order.status !== ORDER_STATUS.SENT_TO_KITCHEN) {
    throw new Error(`startKitchenWatch: status=${order.status} (esperado: sent_to_kitchen).`);
  }
  return watchOrder(order.orderId, order.callId, providerSlug);
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  watchOrder,
  markKitchenAck,
  cancelWatch,
  getWatchStatus,
  listWatched,
  clearAllWatches,
  startKitchenWatch,
  setAlertHandler
};
