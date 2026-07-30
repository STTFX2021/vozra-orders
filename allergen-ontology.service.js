"use strict";

// ─── ONTOLOGÍA DE ALÉRGENOS ──────────────────────────────────────────────────
// Clasifica, para cada (plato, alérgeno), si el alérgeno es RETIRABLE (viene de un
// topping que se puede quitar, p. ej. langostinos sobre una pizza) o INTRÍNSECO
// (va en la masa, la base o la salsa y NO se puede quitar). Es DETERMINISTA: usa
// los parámetros que ya están en la taxonomía (categoría + alérgeno + descripción),
// NO lo adivina el LLM.
//
// Dos capas:
//   1) OVERRIDES → datos validados por el restaurante, por plato. MANDAN sobre la regla.
//   2) Reglas por defecto (classifyByRule) → seguras: ante la duda, INTRÍNSECO
//      (que fuerza "recomendar alternativa", la rama segura).
//
// ⚠️ Las reglas son una inferencia (v1) a partir de la taxonomía. Antes de un piloto
// con clientes alérgicos REALES, el restaurante debe validar y afinar OVERRIDES.
// Nunca se afirma que un plato sea "seguro": solo si un alérgeno se puede quitar o no.

// Overrides validados por restaurante. Formato:
//   "pizza_abruzzo": { shellfish: { removable: true, component: "langostinos" } }
const OVERRIDES = {};

function R(removable, component) {
  return { known: true, removable: !!removable, component: component || null };
}

// Regla determinista por categoría + tipo de alérgeno + descripción.
function classifyByRule(item, allergen) {
  const cat  = (item && item.category) || "";
  const desc = String((item && item.description) || "").toLowerCase();
  const isPizza = /^pizza_/.test(cat);
  switch (allergen) {
    // SIEMPRE intrínsecos: están en la estructura del plato, no se pueden quitar.
    case "gluten": return R(false, "masa/base/pasta");
    case "egg":    return R(false, "huevo (masa/salsa/rebozado)");
    case "dairy":  return R(false, "queso/lácteo integrado");
    // Marisco/moluscos: topping retirable SOLO en pizza; núcleo del plato en pasta/risotto/ensalada.
    case "shellfish":
    case "crustaceans":
    case "molluscs":
      return isPizza ? R(true, "marisco (topping)") : R(false, "marisco (base del plato)");
    // Pescado: anchoa/atún como topping de pizza es retirable; en salsa césar o plato de pescado, no.
    case "fish":
      if (/c[eé]sar|caesar/.test(desc)) return R(false, "pescado (salsa césar)");
      return isPizza ? R(true, "pescado (topping)") : R(false, "pescado (base del plato)");
    // Frutos secos: en el pesto es intrínseco; espolvoreados por encima, retirables.
    case "nuts":
    case "peanuts":
      if (/pesto/.test(desc)) return R(false, "frutos secos (en el pesto)");
      return R(true, "frutos secos (por encima)");
    // Resto (apio, mostaza, sulfitos, soja, sésamo, altramuces): por defecto intrínseco (salsas/aliños).
    default:
      return R(false, "en salsa/aliño");
  }
}

// Clasifica un alérgeno de un plato. `item` = objeto del menú (id, category, description).
function classifyAllergen(item, allergen) {
  if (!item || !allergen) return { known: false };
  const ov = OVERRIDES[item.id];
  if (ov && ov[allergen]) return Object.assign({ known: true, source: "override" }, ov[allergen]);
  return Object.assign({ source: "rule" }, classifyByRule(item, allergen));
}

// Lista de alérgenos declarados del plato que SON retirables (para anotar la carta).
function removableAllergens(item) {
  return ((item && item.knownAllergens) || []).filter(a => classifyAllergen(item, a).removable);
}

module.exports = { classifyAllergen, classifyByRule, removableAllergens, OVERRIDES };
