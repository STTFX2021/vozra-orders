"use strict";

/**
 * VOZRA ORDERS — Order Slot Filler
 * Procesa cada turno del cliente y actualiza la sesión del pedido.
 * Combina menu-taxonomy-resolver + modifier-parser + session store.
 *
 * Patrón inspirado en vapi-reservation-slot-filler.service.js de Vozra Reservations
 * pero orientado a items de pedido en lugar de slots de fecha/hora/personas.
 */

const {
  getOrCreateOrderSession,
  updateOrderSession,
  addItemToOrder,
  updateItemInOrder,
  setFlag,
  ORDER_STATUS,
  transitionStatus
} = require("./order-call-session.store.js");

const {
  resolveItem,
  validateModifier,
  calculatePrice,
  normalizeText,
  getMenuMetadata
} = require("./menu-taxonomy-resolver.service.js");

const {
  parseModifiers,
  detectSize,
  detectQuantity,
  detectCancellation,
  detectConfirmation,
  detectTransferRequest,
  detectOrderType
} = require("./modifier-parser.service.js");

const fs = require("fs");
const path = require("path");

// ─── ALLERGY TAXONOMY ────────────────────────────────────────────────────────

let _allergyTax = null;
function loadAllergyTaxonomy() {
  if (!_allergyTax) {
    const p = path.join(__dirname, "..", "data", "taxonomies", "allergy-taxonomy.v1.json");
    _allergyTax = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  }
  return _allergyTax;
}

// Palabras que indican que el cliente está declarando una restricción alimentaria
// (no solo mencionando un ingrediente como modificador)
const ALLERGY_INTENT_PATTERNS = [
  /\balergi[ao]\b/i,
  /\bintoleran(te|cia)\b/i,
  /\bceliac[ao]\b/i,
  /\bcel[íi]ac[ao]\b/i,
  /\bceliaqu[ií]a\b/i,
  /\bsin\s+gluten\b/i,
  /\bbase\s+sin\s+gluten\b/i,
  /\bno\s+puedo\s+(comer|tomar)\b/i,
  /\bno\s+tolero\b/i,
  /\bme\s+(sienta|cae)\s+(mal|fatal)\b/i,
  /\bme\s+pone\s+malo\b/i,
  /\bsoy\s+(vegano|vegetariano|celiaco)\b/i,
  /\btengo\s+(?:alergia|intolerancia)\b/i
];

function hasAllergyIntent(text) {
  return ALLERGY_INTENT_PATTERNS.some(p => p.test(text));
}

function detectAllergyRisk(text) {
  const allergyTax = loadAllergyTaxonomy();
  const norm = normalizeText(text);

  let allergyRisk = false;
  const detectedAllergies = [];

  // Comprobar triggers de escalado crítico (siempre activos)
  const escalationTriggered = allergyTax.escalationTriggers.some(t =>
    norm.includes(normalizeText(t))
  );

  // SOLO buscar alérgenos si hay intención explícita de alergia O trigger de escalado
  const shouldCheckAllergens = hasAllergyIntent(text) || escalationTriggered;

  if (shouldCheckAllergens) {
    // Alérgenos de alto riesgo
    for (const allergen of allergyTax.highRiskAllergens) {
      const triggered = allergen.aliases.some(alias => norm.includes(normalizeText(alias)));
      if (triggered) {
        allergyRisk = true;
        detectedAllergies.push({ code: allergen.code, label: allergen.label, highRisk: true });
      }
    }

    // Alérgenos estándar
    for (const allergen of allergyTax.standardAllergens) {
      const triggered = allergen.aliases.some(alias => norm.includes(normalizeText(alias)));
      if (triggered) {
        detectedAllergies.push({ code: allergen.code, label: allergen.label, highRisk: false });
      }
    }

    // Restricciones dietéticas (vegano, vegetariano, halal, kosher, etc.)
    for (const diet of (allergyTax.dietaryRestrictions || [])) {
      const triggered = diet.aliases.some(alias => norm.includes(normalizeText(alias)));
      if (triggered) {
        detectedAllergies.push({ code: diet.code, label: diet.label, highRisk: false, isDietary: true });
      }
    }
  }

  if (escalationTriggered) allergyRisk = true;

  return { allergyRisk, escalationTriggered, detectedAllergies };
}

// ─── ADDRESS PARSER ───────────────────────────────────────────────────────────

function parseAddress(text) {
  const norm = normalizeText(text);

  // Patrón básico: calle + número + piso opcional + ciudad opcional
  const streetPattern = /(?:calle|c\/|avenida|av\.|avda\.?|plaza|paseo|ronda|urbanizacion|urb\.?)\s+([a-zà-ɏ\s]+?)(?:\s+n[uú]mero|\s+n[.°]?|\s+,|\s+\d)/i;
  const numberPattern = /\b(\d+)\b/;
  const floorPattern = /\b(\d+[.°]?[a-z]?)\s*(?:piso|planta|[a-z]$)/i;

  const streetMatch = text.match(streetPattern);
  const numbers = text.match(/\b\d+\b/g) || [];
  const floorMatch = text.match(/(\d+[°.]?\s*[a-zA-Z]?)\s*(?:piso|planta|bajo|[aA]|[bB]|[cC])/i);

  // Detectar ciudad (lista básica de ciudades españolas comunes)
  const cities = ["madrid", "barcelona", "sevilla", "valencia", "málaga", "malaga", "granada",
    "marbella", "estepona", "fuengirola", "mijas", "torremolinos", "cancelada", "benahavis"];
  let city = null;
  for (const c of cities) {
    if (norm.includes(c)) { city = c.charAt(0).toUpperCase() + c.slice(1); break; }
  }

  return {
    street: streetMatch ? streetMatch[1].trim() : null,
    number: numbers[0] || null,
    floor: floorMatch ? floorMatch[0].trim() : null,
    city,
    raw: text.trim()
  };
}

// ─── NAME / PHONE PARSERS ─────────────────────────────────────────────────────

function extractPhone(text) {
  const digits = text.replace(/\s+/g, "").replace(/[^0-9+]/g, "");
  if (digits.length >= 9) return digits;
  return null;
}

function scorePhone(phone) {
  if (!phone) return 0;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && /^[6-9]/.test(digits)) return 0.99;
  if (digits.length === 9) return 0.85;
  if (digits.length >= 7) return 0.60;
  return 0.2;
}

function scoreAddress(address) {
  if (!address) return 0;
  let score = 0;
  if (address.street) score += 0.4;
  if (address.number) score += 0.4;
  if (address.floor) score += 0.1;
  if (address.city) score += 0.1;
  return score;
}

// ─── MARTA RESPONSES ─────────────────────────────────────────────────────────

function buildMartaResponse(order, turnResult) {
  const { action, item, modifier, missing } = turnResult;

  switch (action) {
    case "greet":
      return "¡Hola! La Locanda de Cancelada, soy Marta. ¿Qué te pongo?";

    case "ask_order_type":
      return "¿Para recoger o lo quieres a domicilio?";

    case "item_added":
      return `Perfecto, te pongo ${item.quantity > 1 ? item.quantity + "x " : "una "}${item.displayName}${item.size ? " " + item.size : ""}. ¿Algo más o con eso te vale?`;

    case "item_modified":
      return `Anotado, ${modifier.type === "remove" ? "sin " + modifier.value : modifier.type === "extra" ? "con extra de " + modifier.value : modifier.value}. ¿Algo más?`;

    case "item_ambiguous":
      const opts = turnResult.candidates.slice(0,3).map(c => c.displayName).join(", ");
      return `¿Te refieres a la ${opts}? ¿Cuál de ellas quieres?`;

    case "item_not_found":
      return "Lo siento, no tengo ese plato en la carta. ¿Me dices cuál quieres? Tengo pizzas, pasta, risotto, ensaladas y segundos.";

    case "ask_name":
      return "¿A nombre de quién lo pongo?";

    case "ask_phone":
      return "¿Y tu número por si hay alguna incidencia?";

    case "ask_address":
      return "¿A qué dirección te lo llevamos?";

    case "ask_address_number":
      return "¿Me dices el número de la calle?";

    case "confirm_order": {
      const lines = order.items.map(item => {
        const mods = (item.modifiers || []).map(m => {
          if (m.type === "remove") return `sin ${m.value}`;
          if (m.type === "extra") return `con extra de ${m.value}`;
          if (m.type === "double") return `con doble ${m.value}`;
          return m.value;
        }).join(", ");
        return `${item.quantity || 1}x ${item.displayName}${item.size ? " " + item.size : ""}${mods ? " (" + mods + ")" : ""}`;
      }).join(", ");
      const delivery = order.orderType === "delivery"
        ? ` Para domicilio en ${order.address?.raw || "tu dirección"}.`
        : " Para recoger.";
      // Calcular precio estimado para incluirlo en la confirmación
      let totalStr = "";
      try {
        const { estimateTotal } = require("./order-validator.service.js");
        const pricing = estimateTotal(order);
        if (pricing.estimatedTotal > 0) {
          totalStr = ` Total aproximado: ${pricing.estimatedTotal.toFixed(2)} €.`;
        }
      } catch(_) {}
      return `Te confirmo: ${lines}.${delivery}${totalStr} A nombre de ${order.customerName}. ¿Todo correcto?`;
    }

    case "allergy_noted":
      return "Lo anoto para cocina. Ellos confirmarán que pueden prepararlo de forma segura. ¿Algo más en el pedido?";

    case "allergy_risk":
      return "Lo anoto como alergia importante para cocina. Es imprescindible que el equipo lo confirme antes de preparar. ¿Continúo con el pedido?";

    case "transfer_requested":
      return "Claro, ahora mismo te paso. Un momento.";

    case "cancelled":
      return "Sin problema. Si cambias de idea, llámanos. ¡Hasta luego!";

    case "ask_more":
      return "¿Algo más o con eso te vale?";

    default:
      return "¿Me repites eso? No te he entendido bien.";
  }
}

// ─── STRIP MODIFIER FRAGMENTS ────────────────────────────────────────────────

/**
 * Elimina del texto los fragmentos que son modificadores conocidos,
 * dejando solo el nombre del producto y datos de cantidad/tamaño.
 * Permite que el item resolver encuentre "barbacoa" en
 * "ponme una grande de barbacoa sin cebolla y con extra de queso"
 */
function stripModifierFragments(text) {
  return text
    // Quitar fragmentos "sin X"
    .replace(/\bsin\s+[\wáéíóúüñ\s]+/gi, " ")
    // Quitar "con extra de X", "con extra X", "extra de X"
    .replace(/\bcon\s+extra\s+de\s+[\wáéíóúüñ\s]+/gi, " ")
    .replace(/\bcon\s+extra\s+[\wáéíóúüñ]+/gi, " ")
    .replace(/\bextra\s+de\s+[\wáéíóúüñ\s]+/gi, " ")
    // Quitar "doble X", "con doble X"
    .replace(/\b(?:con\s+)?doble\s+(?:de\s+)?[\wáéíóúüñ\s]+/gi, " ")
    // Quitar "ponle X", "añádele X"
    .replace(/\b(?:ponle|añ[aá]dele?|a[ñn]ade?)\s+[\wáéíóúüñ\s]+/gi, " ")
    // Quitar verbos de acción al inicio ("ponme", "dame", "quiero", "pon")
    .replace(/^\s*(?:ponme|dame|quiero|pon|poner|añade|quítame)\s+/i, " ")
    // Limpiar espacios múltiples
    .replace(/\s+/g, " ")
    .trim();
}

// ─── TURN PROCESSOR PRINCIPAL ─────────────────────────────────────────────────

/**
 * Procesa un turno de conversación.
 * @param {string} callId
 * @param {string} text — lo que dijo el cliente
 * @returns {{ order, response, action, needsInput }}
 */
function processTurn(callId, text) {
  let order = getOrCreateOrderSession(callId);
  const norm = normalizeText(text);

  // ── CANCELACIÓN ──────────────────────────────────────────────────────────
  if (detectCancellation(text)) {
    order = updateOrderSession(callId, { status: ORDER_STATUS.CANCELLED_BY_CUSTOMER });
    return { order, response: buildMartaResponse(order, { action: "cancelled" }), action: "cancelled", needsInput: false };
  }

  // ── TRANSFERENCIA ────────────────────────────────────────────────────────
  if (detectTransferRequest(text)) {
    return { order, response: buildMartaResponse(order, { action: "transfer_requested" }), action: "transfer_requested", needsInput: false };
  }

  // ── CONFIRMACIÓN (si estábamos esperándola) ───────────────────────────────
  if (order.status === ORDER_STATUS.AWAITING_CONFIRMATION) {
    if (detectConfirmation(text)) {
      order = updateOrderSession(callId, { status: ORDER_STATUS.CUSTOMER_CONFIRMED });
      return {
        order,
        response: "¡Perfecto! Te lo paso a cocina ahora mismo. El tiempo puede variar según el volumen de pedidos. Si hay cualquier problema, te llamamos al número que me has dado. ¡Hasta luego!",
        action: "customer_confirmed",
        needsInput: false
      };
    }
    // Si no confirma → volver a draft para corregir
    order = updateOrderSession(callId, { status: ORDER_STATUS.DRAFT, confirmationAttempts: (order.confirmationAttempts || 0) + 1 });
  }

  // ── TIPO DE PEDIDO ───────────────────────────────────────────────────────
  if (!order.orderType) {
    const orderType = detectOrderType(text);
    if (orderType) {
      order = updateOrderSession(callId, { orderType });
    }
  }

  // ── ALERGIAS ─────────────────────────────────────────────────────────────
  const { allergyRisk, escalationTriggered, detectedAllergies } = detectAllergyRisk(text);
  if (detectedAllergies.length > 0) {
    const allergyList = detectedAllergies.map(a => a.label);
    const existingAllergies = order.allergies || [];
    const newAllergies = [...new Set([...existingAllergies, ...allergyList])];
    order = updateOrderSession(callId, {
      allergies: newAllergies,
      allergyNotes: text.trim()
    });
    // Toda alergia detectada requiere revisión de cocina
    order = setFlag(callId, "requiresKitchenReview", true);
    if (allergyRisk) {
      order = setFlag(callId, "allergyRisk", true);
      return {
        order,
        response: buildMartaResponse(order, { action: "allergy_risk" }),
        action: "allergy_risk",
        needsInput: true
      };
    }
    return {
      order,
      response: buildMartaResponse(order, { action: "allergy_noted" }),
      action: "allergy_noted",
      needsInput: true
    };
  }

  // ── CHANGE_SIZE ANTICIPADO ───────────────────────────────────────────────
  // Detectar cambio de tamaño ANTES del bloque de nombre para evitar que
  // "mejor ponla grande" se capture como nombre en lugar de modificador de tamaño.
  if (order.items.length > 0) {
    const earlySize = detectSize(text);
    const hasSizeChange = parseModifiers(text).some(m => m.type === "change_size");
    if (earlySize && hasSizeChange) {
      const lastIdx = order.items.length - 1;
      order = updateItemInOrder(callId, lastIdx, { size: earlySize });
      const existingMods = order.items[lastIdx].modifiers || [];
      const sizeMod = { type: "change_size", value: earlySize, raw: text.trim(), confidence: 0.95 };
      order = updateItemInOrder(callId, lastIdx, { modifiers: [...existingMods, sizeMod] });
      return {
        order,
        response: `Anotado, cambio a tamaño ${earlySize}. ¿Algo más?`,
        action: "item_modified",
        needsInput: true
      };
    }
  }

  // ── NOMBRE DEL CLIENTE ────────────────────────────────────────────────────
  if (!order.customerName && order.items.length > 0) {
    // Limpiar prefijos comunes antes de guardar el nombre
    let nameCandidate = text.trim()
      .replace(/^(?:me\s+llamo|soy|mi\s+nombre\s+es|me\s+llamas)\s+/i, "")
      .trim();
    // Aceptar si es corto, no contiene números y no parece un producto
    const { item: possibleItem } = resolveItem(nameCandidate);
    if (!possibleItem && nameCandidate.length > 1 && nameCandidate.length < 40
        && !/\d/.test(nameCandidate) && !detectOrderType(text)) {
      order = updateOrderSession(callId, { customerName: nameCandidate });
      // Si ya tenemos todo lo mínimo, pedir teléfono
      if (!order.phone) {
        return { order, response: buildMartaResponse(order, { action: "ask_phone" }), action: "ask_phone", needsInput: true };
      }
    }
  }

  // ── TELÉFONO ──────────────────────────────────────────────────────────────
  if (!order.phone && order.customerName) {
    const phone = extractPhone(text);
    if (phone) {
      const phoneScore = scorePhone(phone);
      order = updateOrderSession(callId, {
        phone,
        "confidence.phone": phoneScore
      });
      if (phoneScore < 0.7) {
        order = setFlag(callId, "addressRisk", false); // No addressRisk sino phone
      }
    }
  }

  // ── DIRECCIÓN (solo si delivery, y solo cuando ya tenemos nombre y teléfono) ─
  if (order.orderType === "delivery" && order.customerName && order.phone && !order.address?.number) {
    const address = parseAddress(text);
    // Si ya tenemos address.raw (incompleta sin número), aceptar cualquier respuesta con dígitos
    const isAddressCompletion = !!(order.address && order.address.raw && /\d/.test(text));
    // Si es inicio de dirección, requerir palabra clave de calle
    const looksLikeAddress = isAddressCompletion || address.street ||
      /\b(calle|c\/|avenida|av\.|avda\.?|plaza|paseo|urb\.?|urbanizacion|piso|bajo|izquierda|derecha|portal|bloque|escalera|apartamento|n[uú]mero|n[uú]m\.?)\b/i.test(text);
    if (looksLikeAddress) {
      const addrScore = scoreAddress(address);
      order = updateOrderSession(callId, { address });
      if (addrScore < 0.8) {
        order = setFlag(callId, "addressRisk", true);
        if (!address.number) {
          return { order, response: buildMartaResponse(order, { action: "ask_address_number" }), action: "ask_address_number", needsInput: true };
        }
      } else {
        order = setFlag(callId, "addressRisk", false);
      }
    }
  }

  // ── MULTI-ITEM: dividir en " y " / " más " para capturar varios productos ──
  // "una margarita y una barbacoa" → procesar cada fragmento por separado
  const itemSeparators = /\s+(?:y|mas|más|también|tambien|y\s+también|y\s+tambien)\s+(?:una?|dos|tres|cuatro)\s/i;
  if (itemSeparators.test(text) && !order.customerName) {
    // Dividir solo en el primer separador para evitar romper "sin cebolla y con extra"
    const parts = text.split(itemSeparators);
    if (parts.length >= 2) {
      let lastResult = { order, response: null, action: "ask_more", needsInput: true };
      // Prefijo para restaurar cantidad/tamaño en cada parte
      for (const part of parts) {
        const partClean = part.trim();
        if (!partClean || partClean.length < 3) continue;
        const { item: pItem, confidence: pConf } = resolveItem(stripModifierFragments(partClean));
        if (pItem && pConf >= 0.7) {
          const qty  = detectQuantity(partClean) || 1;
          const sz   = detectSize(partClean);
          const mods = parseModifiers(partClean).filter(m => m.type !== "restriction");
          order = addItemToOrder(callId, {
            id: pItem.id, displayName: pItem.displayName, category: pItem.category,
            price: pItem.price, quantity: qty, size: sz || null,
            modifiers: mods, allergyFlags: [], kitchenNote: null, productConfidence: pConf
          });
          lastResult = {
            order,
            response: `Perfecto, apunto ${qty > 1 ? qty + "x " : "una "}${pItem.displayName}${sz ? " " + sz : ""}. ¿Algo más?`,
            action: "item_added",
            needsInput: true
          };
        }
      }
      if (order.items.length > 0) {
        // Actualizar respuesta para confirmar todos los items añadidos
        const itemList = order.items.map(i => `${i.quantity > 1 ? i.quantity + "x " : ""}${i.displayName}${i.size ? " " + i.size : ""}`).join(", ");
        lastResult.response = `Apuntado: ${itemList}. ¿Algo más o con eso te vale?`;
        return lastResult;
      }
    }
  }

  // ── ITEM DEL MENÚ ─────────────────────────────────────────────────────────
  // Limpiar el texto de fragmentos de modificadores antes de resolver el item
  // para que "ponme una grande de barbacoa sin cebolla" → busca "barbacoa"
  const textForItemLookup = stripModifierFragments(text);
  const { item: resolvedItem, confidence, ambiguous, candidates } = resolveItem(textForItemLookup);

  if (ambiguous && confidence < 0.85) {
    return {
      order,
      response: buildMartaResponse(order, { action: "item_ambiguous", candidates }),
      action: "item_ambiguous",
      needsInput: true
    };
  }

  if (resolvedItem && confidence >= 0.7) {
    // Detectar cantidad y tamaño del mismo turno
    const quantity = detectQuantity(text) || 1;
    const size = detectSize(text);

    // Detectar modificadores
    const mods = parseModifiers(text);

    // Filtrar modificadores que sean restrictions (ya procesados arriba)
    const itemModifiers = mods.filter(m => m.type !== "restriction");

    const newItem = {
      id: resolvedItem.id,
      displayName: resolvedItem.displayName,
      category: resolvedItem.category,
      price: resolvedItem.price,
      quantity,
      size: size || null,
      modifiers: itemModifiers,
      allergyFlags: [],
      kitchenNote: null,
      productConfidence: confidence
    };

    // Marcar ambigüedad si confianza baja
    const hasAmbiguity = confidence < 0.8;
    if (hasAmbiguity) order = setFlag(callId, "productAmbiguity", true);

    order = addItemToOrder(callId, newItem);

    return {
      order,
      response: buildMartaResponse(order, { action: "item_added", item: newItem }),
      action: "item_added",
      needsInput: true
    };
  }

  // ── MODIFICADOR A ÍTEM EXISTENTE ─────────────────────────────────────────
  // Si no es un item nuevo pero sí hay modificadores → aplicar al último item
  const mods = parseModifiers(text);
  if (mods.length > 0 && order.items.length > 0) {
    const lastIndex = order.items.length - 1;
    const lastItem = order.items[lastIndex];
    const existingMods = lastItem.modifiers || [];
    order = updateItemInOrder(callId, lastIndex, {
      modifiers: [...existingMods, ...mods]
    });
    return {
      order,
      response: buildMartaResponse(order, { action: "item_modified", modifier: mods[0] }),
      action: "item_modified",
      needsInput: true
    };
  }

  // ── FLUJOS DE RECOGIDA DE DATOS ───────────────────────────────────────────

  // Si tenemos items pero falta tipo de pedido
  if (order.items.length > 0 && !order.orderType) {
    return { order, response: buildMartaResponse(order, { action: "ask_order_type" }), action: "ask_order_type", needsInput: true };
  }

  // Si falta nombre
  if (order.items.length > 0 && order.orderType && !order.customerName) {
    return { order, response: buildMartaResponse(order, { action: "ask_name" }), action: "ask_name", needsInput: true };
  }

  // Si falta teléfono
  if (order.customerName && !order.phone) {
    return { order, response: buildMartaResponse(order, { action: "ask_phone" }), action: "ask_phone", needsInput: true };
  }

  // Si es domicilio y falta dirección
  if (order.orderType === "delivery" && order.phone && !order.address?.number) {
    return { order, response: buildMartaResponse(order, { action: "ask_address" }), action: "ask_address", needsInput: true };
  }

  // ── ¿ESTÁ EL PEDIDO LISTO PARA CONFIRMAR? ────────────────────────────────
  if (isOrderReadyToConfirm(order)) {
    order = updateOrderSession(callId, { status: ORDER_STATUS.AWAITING_CONFIRMATION });
    return {
      order,
      response: buildMartaResponse(order, { action: "confirm_order" }),
      action: "confirm_order",
      needsInput: true
    };
  }

  // Respuesta por defecto — pedir más
  return { order, response: buildMartaResponse(order, { action: "ask_more" }), action: "ask_more", needsInput: true };
}

// ─── VALIDACIÓN ───────────────────────────────────────────────────────────────

function isOrderReadyToConfirm(order) {
  if (!order.items || order.items.length === 0) return false;
  if (!order.orderType) return false;
  if (!order.customerName) return false;
  if (!order.phone) return false;
  if (order.orderType === "delivery" && !order.address?.number) return false;
  if (order.status === ORDER_STATUS.AWAITING_CONFIRMATION) return false;
  if (order.status === ORDER_STATUS.CUSTOMER_CONFIRMED) return false;
  return true;
}

/**
 * Genera el resumen del pedido en texto limpio para la comanda.
 */
function buildKitchenTicket(order) {
  const lines = [];
  const icon = order.orderType === "delivery" ? "[DOMICILIO]" : "[RECOGIDA]";
  const time = new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

  lines.push("PEDIDO " + order.orderId + " -- " + time + "h");
  lines.push("---------------------------------------------");
  lines.push(icon);
  lines.push("Cliente: " + order.customerName + " | Tel: " + order.phone);

  if (order.orderType === "delivery" && order.address && order.address.raw) {
    lines.push("Direccion: " + order.address.raw);
  }

  lines.push("---------------------------------------------");
  lines.push("PRODUCTOS:");
  lines.push("");

  for (const item of order.items) {
    const sizePart = item.size ? " " + item.size.toUpperCase() : "";
    lines.push((item.quantity || 1) + "x " + item.displayName.toUpperCase() + sizePart);
    for (const m of (item.modifiers || [])) {
      if (m.type === "remove")        lines.push("   - SIN " + m.value);
      else if (m.type === "extra")    lines.push("   + EXTRA " + m.value);
      else if (m.type === "double")   lines.push("   + DOBLE " + m.value);
      else if (m.type === "add")      lines.push("   + CON " + m.value);
      else if (m.type === "change_cooking") lines.push("   * " + m.value.replace(/_/g, " ").toUpperCase());
      else if (m.type === "note")     lines.push("   # NOTA: " + m.value);
    }
    if (item.kitchenNote) lines.push("   # NOTA COCINA: " + item.kitchenNote);
  }

  lines.push("---------------------------------------------");

  if (order.allergies && order.allergies.length > 0) {
    const allergyLabel = order.flags && order.flags.allergyRisk ? "!! ALERGIA GRAVE" : "! ALERGIA";
    lines.push(allergyLabel + ": " + order.allergies.join(", "));
    if (order.allergyNotes) lines.push("   Nota: " + order.allergyNotes);
  } else {
    lines.push("Sin alergias declaradas");
  }

  if (order.paymentMethod) lines.push("Pago: " + order.paymentMethod);

  const activeFlags = Object.entries(order.flags || {}).filter(function(entry) { return entry[1]; });
  if (activeFlags.length > 0) {
    lines.push(">> REVISION: " + activeFlags.map(function(e) { return e[0]; }).join(", "));
  }

  lines.push("");
  lines.push("[OK] Confirmado por cliente");

  return lines.join("\n");
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  processTurn,
  isOrderReadyToConfirm,
  buildKitchenTicket,
  parseAddress,
  extractPhone,
  detectAllergyRisk,
  hasAllergyIntent
};
