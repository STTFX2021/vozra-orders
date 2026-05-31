"use strict";

/**
 * VOZRA ORDERS — Kitchen Ticket Builder
 * Fase 4: Genera la comanda de cocina en dos formatos:
 *
 *  1. TEXT  — texto plano legible para WhatsApp/Telegram/impresora
 *  2. JSON  — estructura para dispatch digital y almacenamiento
 *
 * Recibe el pedido (validado) + el ValidationResult de order-validator.
 * NO hace validación propia — eso es responsabilidad del validator.
 */

// ─── FORMATTERS ───────────────────────────────────────────────────────────────

const SEP  = "─────────────────────────────────────";
const SEP2 = "═════════════════════════════════════";

function timeNow() {
  return new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

function dateNow() {
  return new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatModifier(mod) {
  switch (mod.type) {
    case "remove":         return `SIN ${mod.value.toUpperCase()}`;
    case "extra":          return `+ EXTRA ${mod.value.toUpperCase()}`;
    case "double":         return `+ DOBLE ${mod.value.toUpperCase()}`;
    case "add":            return `+ CON ${mod.value.toUpperCase()}`;
    case "change_cooking": return `* ${mod.value.replace(/_/g, " ").toUpperCase()}`;
    case "change_size":    return `* TAMAÑO: ${mod.value.toUpperCase()}`;
    case "note":           return `# NOTA: ${mod.value}`;
    default:               return `> ${mod.value}`;
  }
}

function formatPrice(amount, currency = "EUR") {
  if (amount == null) return "—";
  return `${Number(amount).toFixed(2)} ${currency}`;
}

// ─── TEXT TICKET ──────────────────────────────────────────────────────────────

/**
 * Genera el ticket en texto plano.
 * Formato optimizado para leer en pantalla de cocina, WhatsApp o Telegram.
 */
function buildTextTicket(order, validationResult = {}) {
  const lines = [];
  const isDelivery = order.orderType === "delivery";
  const typeLabel  = isDelivery ? "🛵 DOMICILIO" : "🏠 RECOGIDA";
  const time       = timeNow();
  const date       = dateNow();
  const { estimatedTotal, currency, allergenConflicts, dietaryFlags, flags, warnings } = validationResult;

  // ── CABECERA ─────────────────────────────────────────────────────────────
  lines.push(SEP2);
  lines.push(`🍕 PEDIDO ${order.orderId}`);
  lines.push(`📅 ${date}  ⏰ ${time}h`);
  lines.push(`${typeLabel}`);
  lines.push(SEP);

  // ── CLIENTE ──────────────────────────────────────────────────────────────
  lines.push(`👤 ${order.customerName}  📞 ${order.phone}`);
  if (isDelivery && order.address) {
    lines.push(`📍 ${order.address.raw}`);
    if (order.address.floor) lines.push(`   Piso/puerta: ${order.address.floor}`);
  }
  lines.push(SEP);

  // ── PRODUCTOS ────────────────────────────────────────────────────────────
  lines.push("PRODUCTOS:");
  lines.push("");
  for (const item of order.items) {
    const sizePart = item.size ? ` [${item.size.toUpperCase()}]` : "";
    lines.push(`  ${item.quantity || 1}× ${item.displayName.toUpperCase()}${sizePart}`);
    for (const mod of (item.modifiers || [])) {
      if (mod.type !== "restriction") {
        lines.push(`     ${formatModifier(mod)}`);
      }
    }
    if (item.kitchenNote) lines.push(`     # ${item.kitchenNote}`);
  }
  lines.push("");

  // ── PRECIO ───────────────────────────────────────────────────────────────
  if (estimatedTotal != null) {
    lines.push(SEP);
    lines.push(`💶 TOTAL ESTIMADO: ${formatPrice(estimatedTotal, currency)}`);
  }
  lines.push(SEP);

  // ── ALERGIAS Y RESTRICCIONES ──────────────────────────────────────────────
  const hasAllergies   = order.allergies && order.allergies.length > 0;
  const hasConflicts   = allergenConflicts && allergenConflicts.length > 0;
  const hasDietary     = dietaryFlags && dietaryFlags.length > 0;

  if (hasAllergies || hasDietary) {
    if (flags && flags.allergyRisk) {
      lines.push("⚠️⚠️  ALERGIA GRAVE — REQUIERE CONFIRMACIÓN DE COCINA  ⚠️⚠️");
    } else {
      lines.push("⚠️  ALERGIAS / RESTRICCIONES:");
    }

    if (hasAllergies) {
      lines.push(`   Declarado: ${order.allergies.join(", ")}`);
    }
    if (order.allergyNotes) {
      lines.push(`   Nota cliente: "${order.allergyNotes}"`);
    }
    if (hasConflicts) {
      for (const c of allergenConflicts) {
        const icon = c.severity === "CONFLICT" ? "🚨" : "ℹ️";
        lines.push(`   ${icon} ${c.allergenLabel}${c.severity === "CONFLICT" ? " → PRESENTE EN ITEMS" : " (declarado)"}`);
      }
    }
    if (hasDietary) {
      lines.push(`   🥗 Dieta: ${dietaryFlags.map(d => d.label).join(", ")}`);
    }
    lines.push(SEP);
  } else {
    lines.push("✅ Sin alergias declaradas");
    lines.push(SEP);
  }

  // ── FLAGS DE REVISIÓN ─────────────────────────────────────────────────────
  const activeFlags = flags ? Object.entries(flags).filter(([, v]) => v).map(([k]) => k) : [];
  if (activeFlags.length > 0) {
    lines.push(`🚩 REVISIÓN: ${activeFlags.join(", ")}`);
    lines.push(SEP);
  }

  // ── WARNINGS DE VALIDACIÓN ────────────────────────────────────────────────
  if (warnings && warnings.length > 0) {
    lines.push("📋 NOTAS SISTEMA:");
    for (const w of warnings) {
      lines.push(`   · ${w.message}`);
    }
    lines.push(SEP);
  }

  // ── PIE ───────────────────────────────────────────────────────────────────
  lines.push("✅ Confirmado por cliente");
  lines.push(SEP2);

  return lines.join("\n");
}

// ─── JSON TICKET ──────────────────────────────────────────────────────────────

/**
 * Genera el ticket en formato JSON estructurado.
 * Para dispatch digital, almacenamiento en BD, y kitchen display systems.
 */
function buildJsonTicket(order, validationResult = {}) {
  const { estimatedTotal, currency, allergenConflicts, dietaryFlags, flags, warnings } = validationResult;

  return {
    // Metadatos
    ticketId:    `TKT-${order.orderId}`,
    orderId:     order.orderId,
    callId:      order.callId,
    generatedAt: new Date().toISOString(),
    status:      order.status,

    // Cliente
    customer: {
      name:  order.customerName,
      phone: order.phone
    },

    // Tipo y dirección
    orderType: order.orderType,
    address:   order.orderType === "delivery" ? order.address : null,

    // Productos
    items: (order.items || []).map(item => ({
      id:          item.id,
      displayName: item.displayName,
      category:    item.category,
      quantity:    item.quantity || 1,
      size:        item.size || null,
      unitPrice:   item.price || null,
      modifiers:   (item.modifiers || []).filter(m => m.type !== "restriction").map(m => ({
        type:  m.type,
        value: m.value,
        raw:   m.raw || null
      })),
      kitchenNote:       item.kitchenNote || null,
      productConfidence: item.productConfidence || null
    })),

    // Precio
    pricing: {
      estimatedTotal: estimatedTotal || null,
      currency:       currency || "EUR",
      breakdown:      validationResult.priceBreakdown || []
    },

    // Seguridad alimentaria
    foodSafety: {
      hasAllergyDeclaration: !!(order.allergies && order.allergies.length > 0),
      allergies:             order.allergies || [],
      allergyNotes:          order.allergyNotes || null,
      allergenConflicts:     allergenConflicts || [],
      dietaryRestrictions:   dietaryFlags || [],
      requiresKitchenReview: !!(flags && flags.requiresKitchenReview),
      allergyRisk:           !!(flags && flags.allergyRisk)
    },

    // Flags y warnings
    flags:    flags || {},
    warnings: warnings || [],

    // Dispatch (se rellena por el dispatcher)
    dispatch: {
      channel:    order.dispatchChannel || null,
      sentAt:     order.dispatchAt      || null,
      ackAt:      order.dispatchAckAt   || null,
      kitchenAck: order.kitchenAckAt    || null
    }
  };
}

// ─── FACADE ───────────────────────────────────────────────────────────────────

/**
 * Genera ambos formatos del ticket (texto + JSON).
 * @param {Object} order           — sesión del pedido confirmada
 * @param {Object} validationResult — resultado de validateOrder()
 * @returns {{ text: string, json: Object }}
 */
function buildTicket(order, validationResult = {}) {
  return {
    text: buildTextTicket(order, validationResult),
    json: buildJsonTicket(order, validationResult)
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  buildTicket,
  buildTextTicket,
  buildJsonTicket
};
