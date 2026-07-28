"use strict";

// ─── ONTOLOGÍA DE ALÉRGENOS POR PLATO ────────────────────────────────────────
// Para cada (itemId, alérgeno) indica si ese alérgeno proviene de un componente
// RETIRABLE (un topping que se puede quitar, p. ej. langostinos) o INTRÍNSECO
// (está en la masa, la base o la salsa y NO se puede quitar), y de qué ingrediente.
//
// HOY ESTÁ VACÍA A PROPÓSITO. El enganche queda montado, pero sin datos: se
// rellenará con la información específica y verificada de cada restaurante. Mientras
// esté vacía, Sarah DEDUCE de la descripción del plato (comportamiento interino).
// En cuanto un plato tenga entrada aquí, MANDA el dato (determinista), no la deducción.
//
// Formato (ejemplo comentado, NO activo hasta tener datos reales del restaurante):
//   "pizza_abruzzo": {
//     shellfish: { removable: true,  component: "langostinos" },
//     gluten:    { removable: false, component: "masa" }
//   }
const ONTOLOGY = {};

// Devuelve la clasificación de un alérgeno en un plato.
// { known:false }                              -> no hay dato: Sarah deduce.
// { known:true, removable:bool, component:str} -> dato verificado: manda este.
function classifyAllergen(itemId, allergen) {
  const dish = ONTOLOGY[itemId];
  if (!dish || !dish[allergen]) return { known: false };
  const e = dish[allergen];
  return { known: true, removable: !!e.removable, component: e.component || null };
}

// true si existe cualquier dato de ontología (para no inflar el prompt en vacío).
function hasOntologyData() { return Object.keys(ONTOLOGY).length > 0; }

module.exports = { classifyAllergen, hasOntologyData };
