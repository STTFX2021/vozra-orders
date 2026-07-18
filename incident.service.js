"use strict";

/**
 * VOZRA ORDERS — Incidencias y derivación al personal
 *
 * Cubre la rama "CONSULTA SOBRE UN PEDIDO" del workflow:
 *   1. Sarah localiza el pedido por teléfono (consultar_pedido)
 *   2. Identifica el motivo (estado, retraso, producto incorrecto/faltante,
 *      modificación, otra incidencia)
 *   3. Registra la incidencia (registrar_incidencia)
 *   4. Si no puede resolverla → deriva al personal
 *
 * Garantía de aviso: el registro en Supabase es "mejor esfuerzo" (puede estar
 * desactivado), pero la DERIVACIÓN al canal de personal (Telegram) es el
 * mecanismo que asegura que un humano se entera. Si ambos fallan, se devuelve
 * ok:false para que Sarah sea honesta con el cliente y no prometa una gestión
 * que no ha ocurrido.
 */

const { insertIncident, findOrdersByPhone } = require("./supabase-store.js");
const { getProvider } = require("./provider-profile.config.js");
const { sendTelegram } = require("./dispatch-adapter.service.js");

// Motivos admitidos (alineados con el workflow).
const INCIDENT_REASONS = [
  "estado_pedido",
  "retraso",
  "producto_incorrecto",
  "producto_faltante",
  "modificacion_pedido",
  "otra_incidencia"
];

const REASON_LABEL = {
  estado_pedido:       "Estado del pedido",
  retraso:             "Retraso",
  producto_incorrecto: "Producto incorrecto",
  producto_faltante:   "Producto faltante",
  modificacion_pedido: "Modificación del pedido",
  otra_incidencia:     "Otra incidencia"
};

function normalizeReason(reason) {
  const r = String(reason || "").toLowerCase().trim();
  return INCIDENT_REASONS.includes(r) ? r : "otra_incidencia";
}

/** Estado del pedido en lenguaje natural, para que Sarah lo diga al cliente. */
const STATUS_SPOKEN = {
  customer_confirmed:       "confirmado, entrando en cocina",
  sent_to_kitchen:          "enviado a cocina",
  kitchen_acknowledged:     "recibido por cocina",
  accepted_by_kitchen:      "aceptado y en preparación",
  rejected_by_kitchen:      "rechazado por cocina",
  kitchen_not_acknowledged: "enviado a cocina, pendiente de confirmar",
  failed_dispatch:          "con un problema de envío a cocina",
  cancelled_by_customer:    "cancelado"
};

function spokenStatus(status) {
  return STATUS_SPOKEN[status] || "en proceso";
}

/**
 * Busca los pedidos recientes de un teléfono y los devuelve resumidos
 * en un formato que el LLM puede leer en voz sin exponer datos internos.
 *
 * @returns {Promise<{encontrado:boolean, pedidos?:Array, motivo?:string}>}
 */
async function lookupOrdersForCustomer(phone, limit = 3) {
  const r = await findOrdersByPhone(phone, limit);
  if (!r.ok) {
    return { encontrado: false, motivo: r.skipped ? "sistema_no_disponible" : "error_consulta" };
  }
  const orders = Array.isArray(r.orders) ? r.orders : [];
  if (!orders.length) return { encontrado: false, motivo: "sin_pedidos" };

  return {
    encontrado: true,
    pedidos: orders.map(o => ({
      order_id:     o.order_id,
      estado:       spokenStatus(o.status),
      estado_raw:   o.status,
      tipo:         o.order_type === "delivery" ? "domicilio" : "recoger",
      total_eur:    o.estimated_total,
      entregado_a_cocina: !!o.delivered,
      creado:       o.created_at || null,
      productos:    Array.isArray(o.items)
        ? o.items.map(i => `${i.quantity || 1}x ${i.displayName || i.id || "producto"}`)
        : []
    }))
  };
}

/**
 * Registra una incidencia y, si procede, la deriva al personal.
 *
 * @param {Object} data
 *   { orderId, phone, customerName, reason, detail, escalate, providerSlug }
 * @returns {Promise<{ok:boolean, registrada:boolean, derivada:boolean, error?:string}>}
 */
async function registerIncident(data = {}) {
  const providerSlug = data.providerSlug || "la-locanda";
  const reason = normalizeReason(data.reason);
  const escalate = data.escalate !== false; // por defecto, derivar

  // 1) Registro durable (mejor esfuerzo)
  let registrada = false;
  try {
    const r = await insertIncident({
      orderId:      data.orderId || null,
      phone:        data.phone || null,
      customerName: data.customerName || null,
      reason,
      detail:       data.detail || null,
      resolvedBy:   escalate ? "staff" : "assistant",
      escalated:    escalate,
      providerSlug
    });
    registrada = !!(r && r.ok);
    if (r && r.skipped) console.log("[INCID] registro omitido | " + r.reason);
    else if (r && !r.ok) console.error("[INCID] registro falló | " + r.error);
  } catch (e) {
    console.error("[INCID] error registrando | " + e.message);
  }

  // 2) Derivación al personal (el canal que garantiza que un humano se entera)
  let derivada = false;
  if (escalate) {
    try {
      const provider = getProvider(providerSlug);
      const esc = provider.staffEscalation || {};
      if (esc.enabled !== false) {
        const tg = (provider.dispatchChannels || []).find(c => c.type === "telegram" && c.enabled);
        if (tg) {
          const lines = [
            "⚠️ INCIDENCIA — atención del personal",
            "─────────────────────────────",
            "Motivo: " + (REASON_LABEL[reason] || reason),
            data.orderId     ? "Pedido: " + data.orderId : null,
            data.customerName? "Cliente: " + data.customerName : null,
            data.phone       ? "Teléfono: " + data.phone : null,
            data.detail      ? "Detalle: " + data.detail : null,
            "─────────────────────────────",
            esc.note || "Requiere atención del personal."
          ].filter(Boolean).join("\n");

          await sendTelegram(tg.config, lines, { orderId: null });
          derivada = true;
        }
      }
    } catch (e) {
      console.error("[INCID] derivación falló | " + e.message);
    }
  }

  const ok = registrada || derivada || !escalate;
  return { ok, registrada, derivada };
}

module.exports = {
  lookupOrdersForCustomer,
  registerIncident,
  spokenStatus,
  normalizeReason,
  INCIDENT_REASONS,
  REASON_LABEL
};
