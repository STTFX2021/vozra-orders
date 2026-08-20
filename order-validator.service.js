"use strict";

/**
 * VOZRA ORDERS — Order Validator
 * Fase 4: Valida el pedido completo antes de generar el ticket y hacer dispatch.
 *
 * Responsabilidades:
 *  1. Verificar que todos los slots mínimos estén presentes (según orderType)
 *  2. Cross-check alérgenos declarados vs ingredientes de los items pedidos
 *  3. Detectar restricciones dietéticas y marcar flags de revisión
 *  4. Calcular el precio estimado total
 *  5. Producir un ValidationResult { ok, errors, warnings, flags, estimatedTotal }
 *
 * NO modifica el pedido — solo lo evalúa y devuelve el resultado.
 */

const fs   = require("fs");
const path = require("path");
const { classifyAllergen } = require("./allergen-ontology.service.js");
const { parsePhoneNumberFromString } = require("libphonenumber-js");

// ─── TAXONOMY LOADERS ────────────────────────────────────────────────────────

let _allergyTax = null;
let _menuTax    = null;
let _modsTax    = null;

function loadAllergyTaxonomy() {
  if (!_allergyTax) {
    const p = path.join(__dirname, "data", "taxonomies", "allergy-taxonomy.v1.json");
    _allergyTax = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  }
  return _allergyTax;
}

function loadMenuTaxonomy() {
  if (!_menuTax) {
    const p = path.join(__dirname, "data", "taxonomies", "menu-taxonomy.v1.json");
    _menuTax = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  }
  return _menuTax;
}

function loadModifiersTaxonomy() {
  if (!_modsTax) {
    const p = path.join(__dirname, "data", "taxonomies", "modifiers-taxonomy.v1.json");
    _modsTax = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  }
  return _modsTax;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function norm(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

// ─── SLOT VALIDATION ─────────────────────────────────────────────────────────

/**
 * Verifica que el pedido tenga todos los slots mínimos obligatorios.
 * Retorna array de errores (vacío = OK).
 */
function validateRequiredSlots(order) {
  const errors = [];

  if (!order.items || order.items.length === 0) {
    errors.push({ code: "MISSING_ITEMS", message: "El pedido no tiene ningún producto." });
  }

  if (!order.orderType || !["pickup", "delivery"].includes(order.orderType)) {
    errors.push({
      code: order.orderType ? "INVALID_ORDER_TYPE" : "MISSING_ORDER_TYPE",
      requiredAction: "resolve_order_type",
      message: "Falta resolver el tipo de pedido (recogida / domicilio)."
    });
  }

  if (!order.customerName || order.customerName.trim().length < 2) {
    errors.push({ code: "MISSING_NAME", message: "Falta el nombre del cliente." });
  }

  if (!order.phone) {
    errors.push({ code: "MISSING_PHONE", message: "Falta el número de teléfono." });
  }

  if (order.orderType === "delivery") {
    if (!order.address || !order.address.raw) {
      errors.push({ code: "MISSING_ADDRESS", message: "Pedido a domicilio sin dirección." });
    } else if (!order.address.number) {
      errors.push({ code: "MISSING_ADDRESS_NUMBER", message: "Dirección sin número de calle." });
    }
  }

  return errors;
}

// ─── PHONE VALIDATION ────────────────────────────────────────────────────────

/**
 * BLOQUEA. Hasta el 20-08 esto solo devolvía WARNINGS, y `ok` solo mira `errors`:
 * el sistema DETECTABA el teléfono malo, escribía un aviso que no leía nadie, y
 * despachaba igual. Caso real (llamada de prueba "Pedro Porro"): un teléfono de
 * SIETE dígitos entró a cocina como bueno. Un pedido a domicilio con un teléfono
 * que no existe es un pedido que no puedes rescatar si algo sale mal.
 *
 * Se valida con libphonenumber-js, que ya estaba en package.json y solo se usaba
 * en el formulario de demo de la web: en el flujo de pedidos no validaba nada.
 * Se usa a propósito en vez de contar dígitos a mano, para no dejar en la calle
 * al turista que da un número extranjero perfectamente válido.
 *
 * Devuelve { errors, warnings }.
 */
function validatePhone(phone) {
  const errors = [], warnings = [];
  if (!phone) return { errors, warnings };
  const raw = String(phone).trim();
  const digits = raw.replace(/\D/g, "");

  let parsed = null;
  try { parsed = parsePhoneNumberFromString(raw, "ES"); } catch (_) { parsed = null; }

  if (parsed && parsed.isValid()) {
    if (parsed.country === "ES" && !/^[6-9]/.test(String(parsed.nationalNumber))) {
      warnings.push({ code: "PHONE_PREFIX", message: "Teléfono español que no empieza por 6, 7, 8 o 9." });
    }
    return { errors, warnings };
  }

  errors.push({
    code: "PHONE_LENGTH",
    requiredAction: "resolve_phone",
    message: `Teléfono no válido (${digits.length} dígitos). No se despacha un pedido con un teléfono que no existe.`
  });
  return { errors, warnings };
}

// ─── ALLERGEN CROSS-CHECK ─────────────────────────────────────────────────────

/**
 * Cruza los alérgenos declarados por el cliente con los ingredientes de los items.
 * Detecta también restricciones dietéticas.
 * Retorna { allergenConflicts, dietaryFlags, requiresKitchenReview, allergyRisk }
 */
function allergenMatchesMenuCode(allergen, menuCode) {
  const code = norm(allergen && allergen.code);
  const menu = norm(menuCode);
  if (!code || !menu) return false;
  if (code === menu || norm(allergen.label) === menu) return true;
  if ((allergen.aliases || []).some(alias => norm(alias) === menu)) return true;
  const equivalents = {
    crustaceans: ["crustacean", "shellfish"],
    molluscs: ["mollusc", "shellfish"],
    eggs: ["egg"],
    milk: ["milk", "dairy"],
    nuts: ["nuts"],
    peanuts: ["peanut", "peanuts"],
    sulphites: ["sulphite", "sulphites", "sulfite", "sulfites"]
  };
  return (equivalents[code] || []).includes(menu);
}

function allergenComponent(menuItem, allergen, classification) {
  const description = norm(menuItem && menuItem.description);
  const aliases = (allergen.aliases || [])
    .map(alias => norm(alias))
    .filter(alias => alias.length >= 4 && description.includes(alias))
    .sort((a, b) => b.length - a.length);
  return aliases[0] || (classification && classification.component) || norm(allergen.label);
}

function modifierRemovesAllergen(item, allergen, component) {
  const candidates = new Set([
    norm(component),
    norm(allergen.code),
    norm(allergen.label),
    ...(allergen.aliases || []).map(alias => norm(alias))
  ].filter(Boolean));
  return (item.modifiers || []).some(mod => {
    if (!mod || norm(mod.type) !== "remove") return false;
    const value = norm(mod.value);
    if (!value) return false;
    for (const candidate of candidates) {
      if (candidate.length >= 3 && (value.includes(candidate) || candidate.includes(value))) return true;
    }
    return false;
  });
}

function detectDeclaredAllergies(conversationMessages) {
  const allergyTax = loadAllergyTaxonomy();
  const userText = (conversationMessages || [])
    .filter(message => message && message.role === "user" && message.content)
    .map(message => norm(message.content))
    .join(" ");
  if (!/(alerg|intoler|celiac|no puedo comer|no puedo tomar|me sienta mal)/.test(userText)) return [];
  const found = [];
  for (const allergen of [...(allergyTax.highRiskAllergens || []), ...(allergyTax.standardAllergens || [])]) {
    const alias = (allergen.aliases || []).map(a => norm(a)).find(a => a.length >= 3 && userText.includes(a));
    if (alias && !found.includes(alias)) found.push(alias);
  }
  return found;
}

function crossCheckAllergens(order) {
  const allergyTax = loadAllergyTaxonomy();
  const menuTax = loadMenuTaxonomy();
  const modsTax = loadModifiersTaxonomy();
  const result = {
    allergenConflicts: [],
    dietaryFlags: [],
    requiresKitchenReview: false,
    allergyRisk: false,
    requiredAction: null
  };
  if (!order.allergies || order.allergies.length === 0) return result;

  const definitions = [
    ...(allergyTax.highRiskAllergens || []).map(a => ({ ...a, highRisk: true })),
    ...(allergyTax.standardAllergens || []).map(a => ({ ...a, highRisk: false }))
  ];

  for (const declaredLabel of order.allergies) {
    const declaredNorm = norm(declaredLabel);
    const allergen = definitions.find(def =>
      (def.aliases || []).some(alias => {
        const a = norm(alias);
        return a === declaredNorm || declaredNorm.includes(a) || a.includes(declaredNorm);
      })
    );

    if (allergen) {
      result.requiresKitchenReview = true;
      result.allergyRisk = result.allergyRisk || allergen.highRisk;
      let present = false;

      for (const item of (order.items || [])) {
        const lookupIds = (item.halfAndHalf && item.halfAndHalf.a && item.halfAndHalf.b)
          ? [item.halfAndHalf.a.id, item.halfAndHalf.b.id]
          : [item.id];
        for (const itemId of lookupIds) {
          const menuItem = (menuTax.items || []).find(candidate => candidate.id === itemId);
          if (!menuItem) continue;
          const sources = [];
          for (const code of (menuItem.knownAllergens || [])) sources.push({ code, kind: "ingredient", component: null });
          for (const code of (menuItem.traceAllergens || [])) {
            if (!sources.some(source => norm(source.code) === norm(code))) sources.push({ code, kind: "trace", component: null });
          }
          for (const mod of (item.modifiers || [])) {
            const modDef = (modsTax.modifiers || []).find(def =>
              def.id === mod.modifierId || norm(def.displayName) === norm(mod.value) ||
              (def.nlpKeywords || []).some(keyword => norm(keyword) === norm(mod.value))
            );
            for (const code of ((modDef && modDef.addedAllergens) || [])) {
              sources.push({ code, kind: "modifier", component: mod.value });
            }
          }
          const matchedSource = sources.find(source => allergenMatchesMenuCode(allergen, source.code));
          if (!matchedSource) continue;

          present = true;
          const ontology = classifyAllergen(menuItem, norm(matchedSource.code));
          const classification = matchedSource.kind === "ingredient"
            ? ontology
            : { known: true, removable: matchedSource.kind === "modifier", component: matchedSource.component || "trazas" };
          const component = matchedSource.component || allergenComponent(menuItem, allergen, classification);
          const removed = !!classification.removable && modifierRemovesAllergen(item, allergen, component);
          const status = removed ? "resolved" : (classification.removable ? "pending" : "not_removable");
          const conflict = {
            conflictId: `${item.id || itemId}:${itemId}:${norm(allergen.code)}`,
            itemId: item.id || itemId,
            sourceItemId: itemId,
            itemName: item.displayName || menuItem.displayName,
            allergenCode: allergen.code,
            allergenLabel: allergen.label,
            declaredAs: declaredLabel,
            highRisk: !!allergen.highRisk,
            presentInItems: true,
            severity: "CONFLICT",
            source: matchedSource.kind,
            classification: classification.removable ? "removable" : "intrinsic",
            component,
            status,
            resolution: removed ? "removed" : null,
            requiredAction: status === "pending" ? "resolve_allergen_conflict" : null
          };
          result.allergenConflicts.push(conflict);
        }
      }

      if (!present) {
        result.allergenConflicts.push({
          allergenCode: allergen.code,
          allergenLabel: allergen.label,
          declaredAs: declaredLabel,
          highRisk: !!allergen.highRisk,
          presentInItems: false,
          severity: "DECLARED",
          status: "clear",
          resolution: null,
          requiredAction: null
        });
      }
    }

    for (const diet of (allergyTax.dietaryRestrictions || [])) {
      if ((diet.aliases || []).some(alias => declaredNorm.includes(norm(alias)))) {
        result.dietaryFlags.push({ code: diet.code, label: diet.label, declaredAs: declaredLabel });
        result.requiresKitchenReview = true;
        break;
      }
    }
  }

  if (result.allergenConflicts.some(conflict => conflict.status === "pending")) {
    result.requiredAction = "resolve_allergen_conflict";
  }
  return result;
}
// ─── PRICE ESTIMATION ────────────────────────────────────────────────────────

/**
 * Calcula el precio estimado total del pedido.
 * Retorna { estimatedTotal, breakdown, currency }
 */
function estimateTotal(order) {
  const menuTax = loadMenuTaxonomy();
  const modsTax = loadModifiersTaxonomy();
  const currency = menuTax.currency || "EUR";

  let total = 0;
  const breakdown = [];

  for (const item of order.items) {
    // Pizza mitad y mitad: el precio (la mitad más cara) ya viene calculado en item.price.
    if (item.halfAndHalf && item.price != null) {
      const qty = item.quantity || 1;
      const itemTotal = (item.price || 0) * qty;
      breakdown.push({ label: item.displayName, qty, unitPrice: item.price, subtotal: itemTotal });
      total += itemTotal;
      continue;
    }
    const menuItem = menuTax.items.find(i => i.id === item.id);
    if (!menuItem) {
      breakdown.push({ label: item.displayName || item.id, qty: item.quantity || 1, unitPrice: null, subtotal: null, note: "precio no encontrado" });
      continue;
    }

    const unitPrice = menuItem.price || 0;
    const qty = item.quantity || 1;
    let itemTotal = unitPrice * qty;
    const modLines = [];

    // Modificadores con precio
    for (const mod of (item.modifiers || [])) {
      if (mod.type === "restriction" || mod.type === "change_cooking") continue;
      let modDef = (modsTax.modifiers || []).find(m =>
        m.id === mod.modifierId ||
        norm(m.displayName) === norm(mod.value) ||
        (m.nlpKeywords || []).some(kw => norm(kw) === norm(mod.value))
      );
      // Fallback: un "extra"/"add" que no coincide con ningún topping premium concreto
      // (queso, cebolla, champiñón...) se factura como "Ingrediente extra" genérico.
      if (!modDef && (mod.type === "extra" || mod.type === "add")) {
        modDef = (modsTax.modifiers || []).find(m => m.id === "mod_ingrediente_extra");
      }
      if (modDef && modDef.price > 0) {
        itemTotal += modDef.price * qty;
        modLines.push({ label: modDef.displayName, price: modDef.price });
      }
    }

    breakdown.push({
      label: item.displayName,
      qty,
      unitPrice,
      modifiers: modLines,
      subtotal: itemTotal
    });

    total += itemTotal;
  }

  return {
    estimatedTotal: Math.round(total * 100) / 100,
    breakdown,
    currency
  };
}

// ─── ITEM INTEGRITY ──────────────────────────────────────────────────────────

/**
 * Verifica que cada item del pedido exista en el menú y esté disponible.
 */
function validateItems(order) {
  const menuTax = loadMenuTaxonomy();
  const errors = [];
  const warnings = [];

  for (const item of (order.items || [])) {
    const menuItem = menuTax.items.find(i => i.id === item.id);
    if (!menuItem) {
      errors.push({ code: "ITEM_NOT_IN_MENU", requiredAction: "resolve_invalid_product", message: `Item '${item.id}' no encontrado en el menú.`, itemId: item.id });
      continue;
    }
    if (!menuItem.isAvailable) {
      errors.push({ code: "ITEM_UNAVAILABLE", requiredAction: "resolve_invalid_product", message: `'${item.displayName}' no está disponible actualmente.`, itemId: item.id });
    }
    if (menuItem.price == null || !Number.isFinite(Number(menuItem.price))) {
      errors.push({ code: "ITEM_PRICE_MISSING", requiredAction: "resolve_invalid_product", message: `'${item.displayName}' no tiene un precio operativo válido.`, itemId: item.id });
    }
    if (item.quantity > 10) {
      warnings.push({ code: "HIGH_QUANTITY", message: `Cantidad inusualmente alta: ${item.quantity}x '${item.displayName}'.`, itemId: item.id });
    }
  }

  return { errors, warnings };
}

// ─── MAIN VALIDATOR ───────────────────────────────────────────────────────────

/**
 * Valida el pedido completo.
 * @param {Object} order — sesión del pedido (del store)
 * @returns {Object} ValidationResult
 *   {
 *     ok: boolean,                  — false si hay errores bloqueantes
 *     errors: Array,                — errores que impiden el dispatch
 *     warnings: Array,              — avisos no bloqueantes
 *     allergenConflicts: Array,     — alérgenos cross-check
 *     dietaryFlags: Array,          — restricciones dietéticas
 *     flags: Object,                — flags de revisión actualizados
 *     estimatedTotal: number,
 *     priceBreakdown: Array,
 *     currency: string
 *   }
 */
function validateOrder(order) {
  const errors   = [];
  const warnings = [];

  // 1. Slots mínimos
  const slotErrors = validateRequiredSlots(order);
  errors.push(...slotErrors);

  // 2. Teléfono — BLOQUEA desde el 20-08 (antes solo avisaba y se despachaba igual)
  const phoneCheck = validatePhone(order.phone);
  errors.push(...phoneCheck.errors);
  warnings.push(...phoneCheck.warnings);

  // 3. Items
  const itemIntegrity = validateItems(order);
  errors.push(...itemIntegrity.errors);
  warnings.push(...itemIntegrity.warnings);

  // 4. Alérgenos cross-check
  const { allergenConflicts, dietaryFlags, requiresKitchenReview, allergyRisk, requiredAction } = crossCheckAllergens(order);

  // POLÍTICA DEL OWNER (28-07, reafirmada el 08-08): EL ALÉRGENO NO BLOQUEA.
  //
  // "advertir que están ahí, asesorar y recomendar otros platos u opciones si se
  //  pueden eliminar, pero el cliente manda: si dice que lo quiere así, se hace
  //  así. Siempre se respeta la decisión del cliente, y en el ticket que va a
  //  cocina se pone el alérgeno, como ya hace." — sam, 2026-08-08
  //
  // Esto ya estaba decidido el 28-07 y escrito en PROJECT_STATE §7 ("NO hay gate
  // de bloqueo/revisión"). El 03-08 se reintrodujo como "autoridad determinista"
  // y volvió a bloquear: un conflicto pendiente tiraba el pedido con
  // ALLERGEN_CONFLICT_PENDING aunque el cliente hubiera dicho "déjala como
  // viene". Caso real 07-08: Abruzzo con langostinos → cuatro turnos en bucle y
  // pedido sin cerrar.
  //
  // Ahora es WARNING: se advierte y se asesora en la conversación, el conflicto
  // viaja al ticket de cocina, y el pedido SIGUE. Nuestro trabajo es informar,
  // no decidir por el cliente.
  const pendingAllergenConflicts = allergenConflicts.filter(conflict => conflict.status === "pending");
  if (pendingAllergenConflicts.length) {
    warnings.push({
      code: "ALLERGEN_CONFLICT_PENDING",
      message: "Ingrediente alergénico presente: hay que advertirlo y ofrecer quitarlo o cambiar de plato. Decide el cliente.",
      conflictIds: pendingAllergenConflicts.map(conflict => conflict.conflictId)
    });
  }
  if (requiresKitchenReview && allergenConflicts.length) {
    warnings.push({
      code: "ALLERGEN_NOTED",
      message: "Alergia declarada anotada para cocina."
    });
  }
  // 5. Precio estimado
  const { estimatedTotal, breakdown, currency } = estimateTotal(order);

  // 6. Flags consolidados (merge con los flags existentes del pedido)
  const flags = {
    ...(order.flags || {}),
    requiresKitchenReview: requiresKitchenReview || !!(order.flags && order.flags.requiresKitchenReview),
    allergyRisk:           allergyRisk           || !!(order.flags && order.flags.allergyRisk),
    lowConfidence:         !!(order.flags && order.flags.lowConfidence),
    addressRisk:           !!(order.flags && order.flags.addressRisk),
    productAmbiguity:      !!(order.flags && order.flags.productAmbiguity),
    deliveryRisk:          !!(order.flags && order.flags.deliveryRisk),
    requiresProviderReview: !!(order.flags && order.flags.requiresProviderReview)
  };

  // Warning adicional si hay conflicto de alérgeno presente en items
  for (const conflict of allergenConflicts) {
    if (conflict.severity === "CONFLICT") {
      warnings.push({
        code: "ALLERGEN_IN_ITEMS",
        message: `Alérgeno '${conflict.allergenLabel}' declarado por el cliente está presente en los items pedidos.`,
        allergenCode: conflict.allergenCode
      });
    }
  }

  // Warning si hay alérgenos de alto riesgo sin base sin gluten solicitada
  const hasGlutenAllergen = allergenConflicts.some(c => c.allergenCode === "GLUTEN");
  const hasGlutenFreeMod  = (order.items || []).some(i =>
    (i.modifiers || []).some(m => norm(m.value).includes("gluten"))
  );
  if (hasGlutenAllergen && !hasGlutenFreeMod) {
    warnings.push({
      code: "GLUTEN_NO_GF_BASE",
      message: "Cliente declaró intolerancia al gluten pero no solicitó base sin gluten explícitamente."
    });
  }

  // `requiredAction` NO propaga "resolve_allergen_conflict": el alérgeno se
  // advierte y se asesora, pero no detiene el pedido (ver bloque de arriba).
  // El conflicto sigue viajando en `allergenConflicts` y en los warnings, que es
  // lo que alimenta la advertencia al cliente y la nota del ticket de cocina.
  const requiredActionSinAlergenos =
    requiredAction === "resolve_allergen_conflict" ? null : requiredAction;

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    allergenConflicts,
    requiredAction: requiredActionSinAlergenos,
    allergenAdvisory: allergenConflicts.filter(c => c && c.status === "pending"),
    dietaryFlags,
    flags,
    estimatedTotal,
    priceBreakdown: breakdown,
    currency
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  validateOrder,
  validateRequiredSlots,
  validatePhone,
  crossCheckAllergens,
  detectDeclaredAllergies,
  estimateTotal,
  validateItems
};
