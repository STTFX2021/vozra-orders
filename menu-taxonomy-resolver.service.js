"use strict";

/**
 * VOZRA ORDERS — Menu Taxonomy Resolver
 */

const fs = require("fs");
const path = require("path");

const TAXONOMY_DIR = path.join(__dirname, "data", "taxonomies");
const MENU_PATH    = path.join(TAXONOMY_DIR, "menu-taxonomy.v1.json");
const MODS_PATH    = path.join(TAXONOMY_DIR, "modifiers-taxonomy.v1.json");

let _menu = null;
let _mods = null;

function loadMenu() {
  if (!_menu) { _menu = JSON.parse(fs.readFileSync(MENU_PATH, "utf8").replace(/^﻿/, "")); }
  return _menu;
}
function loadModifiers() {
  if (!_mods) { _mods = JSON.parse(fs.readFileSync(MODS_PATH, "utf8").replace(/^﻿/, "")); }
  return _mods;
}

function normalizeText(value = "") {
  return String(value).toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

// Palabras función del español que NUNCA pueden actuar como keyword por sí solas
// (evita que "te" -> Té, "solo" -> Café espresso, etc. envenenen el matching).
const KEYWORD_STOPWORDS = new Set(["te", "solo", "con", "sin", "de", "del", "la", "el", "los", "las", "un", "una", "uno", "dos", "mas", "más", "que", "por", "para", "eso", "esa", "ese"]);

function termMatches(normalizedText, normalizedTerm) {
  if (!normalizedText || !normalizedTerm) return false;
  // Términos cortos o palabras función: solo pueden matchear por igualdad exacta
  // (ruta nlpKeyword_exact aguas arriba), nunca dentro de una frase.
  if (normalizedTerm.length < 4 || KEYWORD_STOPWORDS.has(normalizedTerm)) return false;
  const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(normalizedText)) return true;
  // Substring libre solo para términos largos (>=5): "te" dentro de "tomate" NO.
  return normalizedTerm.length >= 5 && normalizedText.includes(normalizedTerm);
}

function resolveMenuItems(text) {
  const menu = loadMenu();
  const norm = normalizeText(text);
  const results = [];
  for (const item of menu.items) {
    if (!item.isAvailable) continue;
    let confidence = 0, matchedBy = null;
    if (normalizeText(item.displayName) === norm) { confidence = 1.0; matchedBy = "displayName_exact"; }
    else if (item.displayNameEN && normalizeText(item.displayNameEN) === norm) { confidence = 1.0; matchedBy = "displayNameEN_exact"; }
    else if (item.nlpKeywords && item.nlpKeywords.some(kw => normalizeText(kw) === norm)) { confidence = 0.95; matchedBy = "nlpKeyword_exact"; }
    else if (termMatches(norm, normalizeText(item.displayName))) { confidence = 0.9; matchedBy = "displayName_contains"; }
    else if (item.nlpKeywords) {
      for (const kw of item.nlpKeywords) {
        if (termMatches(norm, normalizeText(kw))) { confidence = 0.85; matchedBy = `nlpKeyword_contains:${kw}`; break; }
        const nkw = normalizeText(kw);
        if (nkw.length >= 5 && !KEYWORD_STOPWORDS.has(nkw) && norm.includes(nkw)) { confidence = Math.max(confidence, 0.75); matchedBy = matchedBy || `nlpKeyword_inText:${kw}`; }
      }
    }
    if (confidence > 0) {
      results.push({ id: item.id, displayName: item.displayName, category: item.category, price: item.price,
        knownAllergens: item.knownAllergens, traceAllergens: item.traceAllergens,
        modifierGroups: item.modifierGroups, modifierNote: item.modifierNote || null,
        dietaryTags: item.dietaryTags, isHouseFavourite: item.isHouseFavourite,
        proactiveRecommend: item.proactiveRecommend || false, suggestedModifiers: item.suggestedModifiers || [],
        confidence, matchedBy });
    }
  }
  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

function resolveItem(text) {
  const candidates = resolveMenuItems(text);
  if (candidates.length === 0) return { item: null, confidence: 0, ambiguous: false, candidates: [] };
  const best = candidates[0];
  const closeMatches = candidates.filter(c => c.confidence >= best.confidence - 0.1);
  const ambiguous = closeMatches.length > 1 && best.confidence < 0.95;
  return { item: best, confidence: best.confidence, ambiguous, candidates: candidates.slice(0, 3) };
}

function validateModifier(itemId, modifierId) {
  const mods = loadModifiers();
  const menu = loadMenu();
  const item = menu.items.find(i => i.id === itemId);
  if (!item) return { valid: false, reason: `Item '${itemId}' no encontrado.` };
  const modifier = mods.modifiers.find(m => m.id === modifierId && m.isAvailable);
  if (!modifier) return { valid: false, reason: `Modificador '${modifierId}' no disponible.` };
  const rule = mods.modifierRules ? mods.modifierRules.find(r => r.modifierId === modifierId) : null;
  if (!rule) return { valid: true, modifier, rule: null, reason: null };
  if (rule.excludes && rule.excludes.includes(itemId)) return { valid: false, reason: `${modifier.displayName} no aplica a '${item.displayName}'.` };
  const appliesToCategories = rule.appliesTo;
  if (!appliesToCategories.includes(item.category) && !appliesToCategories.includes(itemId)) return { valid: false, reason: `${modifier.displayName} no aplica a '${item.category}'.` };
  if (modifier.duplicateRiskItemIds && modifier.duplicateRiskItemIds.includes(itemId)) return { valid: true, duplicate: true, reason: `'${item.displayName}' ya incluye '${modifier.displayName}'.`, modifier, rule };
  return { valid: true, modifier, rule, reason: null };
}

function calculatePrice(itemId, modifierIds = []) {
  const menu = loadMenu(), mods = loadModifiers();
  const item = menu.items.find(i => i.id === itemId);
  if (!item) throw new Error(`Item '${itemId}' no encontrado.`);
  const breakdown = [{ label: item.displayName, price: item.price }];
  let modifiersTotal = 0;
  for (const modId of modifierIds) {
    const mod = mods.modifiers.find(m => m.id === modId);
    if (!mod) continue;
    breakdown.push({ label: mod.displayName, price: mod.price });
    modifiersTotal += mod.price;
  }
  return { base: item.price, modifiersTotal, total: item.price + modifiersTotal, breakdown };
}

function getByCategory(category) {
  return loadMenu().items.filter(i => i.category === category && i.isAvailable).sort((a, b) => a.sortOrder - b.sortOrder);
}
function getHouseFavourites() { return loadMenu().items.filter(i => i.isHouseFavourite && i.isAvailable); }
function resolveIntent(text) {
  const menu = loadMenu(), norm = normalizeText(text), intentMap = menu.intentCategoryMap || {};
  for (const [intentKey, intent] of Object.entries(intentMap)) {
    if (norm.includes(normalizeText(intentKey.replace(/_/g, " ")))) return { intentKey, ...intent };
  }
  return null;
}
function getUpsell(itemId) { return (loadModifiers().upsellRules || []).find(r => r.triggerItemId === itemId) || null; }
function getMenuMetadata() {
  const menu = loadMenu();
  return { restaurantId: menu.restaurantId, restaurantName: menu.restaurantName, currency: menu.currency,
    allergenPolicy: menu.allergenPolicy, groupMenuThreshold: menu.groupMenuThreshold, maxModifiersPerPizza: menu.maxModifiersPerPizza };
}

module.exports = { normalizeText, resolveMenuItems, resolveItem, validateModifier, calculatePrice,
  getByCategory, getHouseFavourites, resolveIntent, getUpsell, getMenuMetadata };
