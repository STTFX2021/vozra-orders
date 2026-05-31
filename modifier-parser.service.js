"use strict";

/**
 * VOZRA ORDERS — Modifier Parser
 * Detecta modificadores expresados en lenguaje natural español.
 */

const { normalizeText } = require("./menu-taxonomy-resolver.service.js");

const PATTERNS = {
  remove: [
    /\bsin\s+(?:nada\s+de\s+)?(.+?)(?:\s+por\s+favor)?(?:,|\s+y\s|\s+con\s|\.|$)/i,
    /\bqu[íi]tame?\s+(?:el|la|los|las)?\s*(.+?)(?:\s+por\s+favor)?(?:,|\s+y\s|\.|$)/i,
    /\bno\s+le\s+pongas\s+(?:el|la|los|las)?\s*(.+?)(?:,|\s+y\s|\.|$)/i,
    /\bretira[r]?\s+(?:el|la|los|las)?\s*(.+?)(?:,|\s+y\s|\.|$)/i,
    /\bnada\s+de\s+(.+?)(?:,|\s+y\s|\.|$)/i
  ],
  extra: [
    /\bcon\s+extra\s+de\s+(.+?)(?:,|$|\.)/i,
    /\bcon\s+extra\s+(.+?)(?:,|$|\.)/i,
    /\bextra\s+de\s+(.+?)(?:,|$|\.)/i,
    /\bponle\s+m[aá]s\s+(.+?)(?:,|$|\.)/i,
    /\bun\s+poco\s+m[aá]s\s+de\s+(.+?)(?:,|$|\.)/i
  ],
  double: [
    /\bdoble\s+(?:de\s+)?(.+?)(?:,|$|\.)/i,
    /\bcon\s+doble\s+(?:de\s+)?(.+?)(?:,|$|\.)/i,
    /\bel\s+doble\s+de\s+(.+?)(?:,|$|\.)/i,
    /\bdos\s+veces\s+(?:m[aá]s\s+)?(.+?)(?:,|$|\.)/i
  ],
  add: [
    /\ba[ñn][aá]dele?\s+(.+?)(?:,|$|\.)/i,
    /\bponle\s+(.+?)(?:,|$|\.)/i,
    /\bcon\s+(.+?)(?:,|$|\.)/i,
    /\b(?:tambi[eé]n\s+)?quiero\s+(.+?)(?:,|$|\.)/i,
    /\ba[ñn]ade\s+(.+?)(?:,|$|\.)/i
  ],
  change_size: [
    /\bmejor\s+(peque[ñn]a|mediana|grande|familiar|gigante)/i,
    /\bc[aá]mbi(?:ala|ame)\s+(?:a|la|por\s+una?)?\s*(peque[ñn]a|mediana|grande|familiar)/i,
    /\bla\s+quiero\s+(peque[ñn]a|mediana|grande|familiar)/i,
    /\bponla\s+(peque[ñn]a|mediana|grande|familiar)/i,
    /\bde\s+(peque[ñn]a|mediana|grande|familiar)\s+(?:a|por)\s+(peque[ñn]a|mediana|grande|familiar)/i,
    /\b(peque[ñn]a|mediana|grande|familiar)\s+mejor/i
  ],
  change_cooking: [
    /\bpoco\s+hecha\b/i, /\bbien\s+hecha\b/i, /\bmuy\s+hecha\b/i,
    /\bcrujiente\b/i, /\bblanda\b/i, /\bmasa\s+fina\b/i, /\bmasa\s+gruesa\b/i,
    /\bborde\s+relleno\b/i, /\bsin\s+cortar\b/i, /\bcortada?\b/i
  ],
  restriction: [
    /\bsin\s+gluten\b/i, /\bbase\s+sin\s+gluten\b/i, /\bceliac[ao]\b/i, /\bcel[íi]ac[ao]\b/i,
    /\bsin\s+lactosa\b/i, /\bintoleran(?:te|cia)\s+(?:a\s+la\s+)?lactosa\b/i,
    /\bvegana?\b/i, /\bvegetariana?\b/i,
    /\bsin\s+(?:frutos\s+secos|cacahuetes|marisco|huevo|soja)\b/i,
    /\balergi[ao]\s+(?:a\s+(?:los?|las?)\s+)?(.+?)(?:,|$|\.)/i
  ]
};

const SIZE_MAP = {
  "pequeña": "pequeña", "pequeño": "pequeña", "chica": "pequeña", "mini": "pequeña",
  "mediana": "mediana", "mediano": "mediana", "normal": "mediana",
  "grande": "grande", "grandota": "grande",
  "familiar": "familiar", "gigante": "familiar", "extra grande": "familiar"
};

const COOKING_MAP = {
  "poco hecha": "poco_hecha", "poco hecho": "poco_hecha",
  "bien hecha": "bien_hecha", "bien hecho": "bien_hecha",
  "muy hecha": "muy_hecha", "muy hecho": "muy_hecha",
  "crujiente": "crujiente", "blanda": "blanda", "blando": "blanda",
  "masa fina": "masa_fina", "masa gruesa": "masa_gruesa",
  "borde relleno": "borde_relleno", "sin cortar": "sin_cortar",
  "cortada": "cortada", "cortado": "cortada"
};

function parseModifiers(text) {
  const modifiers = [];
  const norm = normalizeText(text);

  for (const pattern of PATTERNS.remove) {
    const match = norm.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim().replace(/\s+/g, " ");
      if (!SIZE_MAP[value]) modifiers.push({ type: "remove", value, raw: match[0].trim(), confidence: 0.9 });
    }
  }
  for (const pattern of PATTERNS.extra) {
    const match = norm.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim().replace(/^de\s+/, "").trim();
      if (!SIZE_MAP[value]) modifiers.push({ type: "extra", value, raw: match[0].trim(), confidence: 0.9 });
    }
  }
  for (const pattern of PATTERNS.double) {
    const match = norm.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim().replace(/^de\s+/, "").trim();
      modifiers.push({ type: "double", value, raw: match[0].trim(), confidence: 0.9 });
    }
  }
  for (const pattern of PATTERNS.change_size) {
    const match = norm.match(pattern);
    if (match) {
      const captured = match[match.length - 1];
      const sizeValue = SIZE_MAP[normalizeText(captured)];
      if (sizeValue) modifiers.push({ type: "change_size", value: sizeValue, raw: match[0].trim(), confidence: 0.95 });
    }
  }
  for (const cookingKey of Object.keys(COOKING_MAP)) {
    if (norm.includes(cookingKey)) {
      modifiers.push({ type: "change_cooking", value: COOKING_MAP[cookingKey], raw: cookingKey, confidence: 0.95 });
    }
  }
  for (const pattern of PATTERNS.restriction) {
    if (pattern.test(norm)) {
      const match = norm.match(pattern);
      const value = match && match[1] ? match[1].trim() : match[0].trim();
      modifiers.push({ type: "restriction", value, raw: match[0].trim(), confidence: 0.95 });
    }
  }

  const alreadyCaptured = new Set(modifiers.map(m => m.raw));
  const conPattern = /\bcon\s+(?!extra\b)(.+?)(?:,|$|\.| y )/i;
  const conMatch = norm.match(conPattern);
  if (conMatch && conMatch[1]) {
    const value = conMatch[1].trim();
    if (!SIZE_MAP[value] && !alreadyCaptured.has(conMatch[0].trim()) &&
        !Object.keys(COOKING_MAP).some(k => value.includes(k)) && value.length > 2) {
      modifiers.push({ type: "add", value, raw: conMatch[0].trim(), confidence: 0.7 });
    }
  }

  const seen = new Set();
  return modifiers.filter(m => {
    const key = `${m.type}:${m.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function detectSize(text) {
  const norm = normalizeText(text);
  for (const [alias, size] of Object.entries(SIZE_MAP)) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(norm)) return size;
  }
  return null;
}

function detectQuantity(text) {
  const norm = normalizeText(text);
  const wordMap = { "una": 1, "un": 1, "uno": 1, "dos": 2, "un par": 2, "par": 2,
    "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10 };
  for (const [word, num] of Object.entries(wordMap)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|\\s)${escaped}(\\s|$)`, "i").test(norm)) return num;
  }
  const digitMatch = norm.match(/\b([1-9][0-9]?)\b/);
  if (digitMatch) return parseInt(digitMatch[1], 10);
  return null;
}

function detectCancellation(text) {
  return /\b(cancela|dejalo|d[eé]jalo|no quiero nada|olv[íi]dalo|nada|cancel)\b/.test(normalizeText(text));
}
function detectConfirmation(text) {
  return /\b(s[íi]|correcto|eso es|perfecto|adelante|vale|ok|de acuerdo|exacto|genial|bien|as[íi] es)\b/.test(normalizeText(text));
}
function detectTransferRequest(text) {
  return /\b(hablar con alguien|hablar con una persona|ponme con|p[aá]same con|quiero hablar con|responsable|encargado|gerente|persona real|no quiero hablar con un robot)\b/.test(normalizeText(text));
}
function detectOrderType(text) {
  const norm = normalizeText(text);
  if (/\b(recoger|recogida|recojo|para llevar|en persona|paso a recoger|lo recojo)\b/.test(norm)) return "pickup";
  if (/\b(domicilio|a casa|a mi casa|me lo traes|lo traes|para que me lo traigan|delivery|reparto|a la direcci[oó]n)\b/.test(norm)) return "delivery";
  return null;
}

module.exports = { parseModifiers, detectSize, detectQuantity, detectCancellation,
  detectConfirmation, detectTransferRequest, detectOrderType, SIZE_MAP, COOKING_MAP };
