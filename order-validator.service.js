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

  if (!order.orderType) {
    errors.push({ code: "MISSING_ORDER_TYPE", message: "Falta el tipo de pedido (recogida / domicilio)." });
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

function validatePhone(phone) {
  const warnings = [];
  if (!phone) return warnings;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length !== 9) {
    warnings.push({ code: "PHONE_LENGTH", message: `Teléfono con ${digits.length} dígitos (esperado: 9).` });
  }
  if (!/^[6-9]/.test(digits)) {
    warnings.push({ code: "PHONE_PREFIX", message: "Teléfono no empieza por 6, 7, 8 o 9 (móvil/fijo español)." });
  }
  return warnings;
}

// ─── ALLERGEN CROSS-CHECK ─────────────────────────────────────────────────────

/**
 * Cruza los alérgenos declarados por el cliente con los ingredientes de los items.
 * Detecta también restricciones dietéticas.
 * Retorna { allergenConflicts, dietaryFlags, requiresKitchenReview, allergyRisk }
 */
function crossCheckAllergens(order) {
  const allergyTax = loadAllergyTaxonomy();
  const menuTax    = loadMenuTaxonomy();
  const modsTax    = loadModifiersTaxonomy();

  const result = {
    allergenConflicts: [],   // alérgenos declarados que aparecen en items
    dietaryFlags:      [],   // restricciones dietéticas detectadas
    requiresKitchenReview: false,
    allergyRisk: false
  };

  if (!order.allergies || order.allergies.length === 0) return result;

  // Reunir todos los alérgenos de todos los items del pedido
  const itemAllergenCodes = new Set();
  for (const item of order.items) {
    const menuItem = menuTax.items.find(i => i.id === item.id);
    if (!menuItem) continue;

    // Alérgenos base del item
    for (const a of (menuItem.knownAllergens || [])) itemAllergenCodes.add(norm(a));
    for (const a of (menuItem.traceAllergens || [])) itemAllergenCodes.add(norm(a));

    // Alérgenos añadidos por modificadores
    for (const mod of (item.modifiers || [])) {
      const modDef = (modsTax.modifiers || []).find(m => m.id === mod.modifierId || norm(m.displayName) === norm(mod.value));
      if (modDef) {
        for (const a of (modDef.addedAllergens || [])) itemAllergenCodes.add(norm(a));
      }
    }
  }

  // Cross-check: alérgeno declarado vs items
  for (const declaredLabel of order.allergies) {
    const declaredNorm = norm(declaredLabel);

    // Buscar en highRiskAllergens
    for (const allergen of allergyTax.highRiskAllergens) {
      const matches = allergen.aliases.some(a => norm(a) === declaredNorm || declaredNorm.includes(norm(a)));
      if (matches) {
        result.requiresKitchenReview = true;
        result.allergyRisk = true;

        // Buscar si el código del alérgeno aparece en algún item
        const inItems = itemAllergenCodes.has(norm(allergen.code)) ||
          itemAllergenCodes.has(norm(allergen.label));

        result.allergenConflicts.push({
          allergenCode: allergen.code,
          allergenLabel: allergen.label,
          declaredAs: declaredLabel,
          highRisk: true,
          presentInItems: inItems,
          severity: inItems ? "CONFLICT" : "DECLARED"
        });
        break;
      }
    }

    // Buscar en standardAllergens
    for (const allergen of allergyTax.standardAllergens) {
      const matches = allergen.aliases.some(a => norm(a) === declaredNorm || declaredNorm.includes(norm(a)));
      if (matches) {
        result.requiresKitchenReview = true;
        const inItems = itemAllergenCodes.has(norm(allergen.code)) ||
          itemAllergenCodes.has(norm(allergen.label));

        result.allergenConflicts.push({
          allergenCode: allergen.code,
          allergenLabel: allergen.label,
          declaredAs: declaredLabel,
          highRisk: false,
          presentInItems: inItems,
          severity: inItems ? "CONFLICT" : "DECLARED"
        });
        break;
      }
    }

    // Restricciones dietéticas
    for (const diet of (allergyTax.dietaryRestrictions || [])) {
      const matches = diet.aliases.some(a => norm(a) === declaredNorm || declaredNorm.includes(norm(a)));
      if (matches) {
        result.dietaryFlags.push({ code: diet.code, label: diet.label, declaredAs: declaredLabel });
        result.requiresKitchenReview = true;
        break;
      }
    }
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
  const warnings = [];

  for (const item of (order.items || [])) {
    const menuItem = menuTax.items.find(i => i.id === item.id);
    if (!menuItem) {
      warnings.push({ code: "ITEM_NOT_IN_MENU", message: `Item '${item.id}' no encontrado en el menú.`, itemId: item.id });
      continue;
    }
    if (!menuItem.isAvailable) {
      warnings.push({ code: "ITEM_UNAVAILABLE", message: `'${item.displayName}' no está disponible actualmente.`, itemId: item.id });
    }
    if (item.quantity > 10) {
      warnings.push({ code: "HIGH_QUANTITY", message: `Cantidad inusualmente alta: ${item.quantity}x '${item.displayName}'.`, itemId: item.id });
    }
  }

  return warnings;
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

  // 2. Teléfono
  const phoneWarnings = validatePhone(order.phone);
  warnings.push(...phoneWarnings);

  // 3. Items
  const itemWarnings = validateItems(order);
  warnings.push(...itemWarnings);

  // 4. Alérgenos cross-check
  const { allergenConflicts, dietaryFlags, requiresKitchenReview, allergyRisk } = crossCheckAllergens(order);

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

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    allergenConflicts,
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
  estimateTotal,
  validateItems
};
