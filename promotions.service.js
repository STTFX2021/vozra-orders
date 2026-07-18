"use strict";

/**
 * VOZRA ORDERS — Motor de promociones
 *
 * Estado actual: PREPARADO Y VACÍO. `provider.promotions` es `[]`, así que
 * `applyPromotions` es un no-op y el total no cambia. Añadir promociones NO
 * requiere tocar este archivo: basta con declarar reglas en
 * `provider-profile.config.js`.
 *
 * Formato de una regla (ver ejemplo comentado en provider-profile.config.js):
 * {
 *   id: "2x1_margherita",
 *   label: "2x1 en Margherita",          // texto que Sarah puede decir en voz
 *   active: true,
 *   type: "percent" | "amount" | "free_item",
 *   value: 50,                            // % (percent) o € (amount); ignorado en free_item
 *   appliesTo: { itemIds: [...], categories: [...], minQuantity: 1 },
 *   conditions: {
 *     orderType: "delivery" | "pickup" | null,
 *     minTotal: 0,
 *     weekdays: [0..6],                   // 0=domingo
 *     fromHHMM: "19:00", toHHMM: "23:00"
 *   },
 *   stackable: false                      // si false, no se combina con otras
 * }
 *
 * Reglas de seguridad del motor:
 *  - El descuento NUNCA puede dejar el total por debajo de 0.
 *  - Si una regla está mal formada, se ignora (no rompe el pedido).
 *  - Sin reglas activas → discounts: [], newTotal === baseTotal.
 */

const { getProvider } = require("./provider-profile.config.js");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function hhmmToMin(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

function nowParts(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone || "Europe/Madrid",
      weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(new Date());
    const get = t => (parts.find(p => p.type === t) || {}).value;
    const wd = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[(get("weekday") || "").toLowerCase()];
    let hh = parseInt(get("hour"), 10); if (hh === 24) hh = 0;
    return { weekday: wd, minutes: hh * 60 + parseInt(get("minute"), 10) };
  } catch (_) {
    return { weekday: null, minutes: null };
  }
}

/** ¿Se cumplen las condiciones temporales/contextuales de la regla? */
function conditionsMet(rule, ctx, timezone) {
  const c = rule.conditions || {};
  if (c.orderType && ctx.orderType && c.orderType !== ctx.orderType) return false;
  if (c.minTotal != null && ctx.baseTotal < c.minTotal) return false;

  const { weekday, minutes } = nowParts(timezone);
  if (Array.isArray(c.weekdays) && c.weekdays.length && weekday != null) {
    if (!c.weekdays.includes(weekday)) return false;
  }
  const from = hhmmToMin(c.fromHHMM);
  const to   = hhmmToMin(c.toHHMM);
  if (from != null && to != null && minutes != null) {
    if (minutes < from || minutes >= to) return false;
  }
  return true;
}

/** Ítems del pedido a los que aplica la regla. */
function matchingItems(rule, items) {
  const a = rule.appliesTo || {};
  const ids  = Array.isArray(a.itemIds) ? a.itemIds : null;
  const cats = Array.isArray(a.categories) ? a.categories : null;
  const minQ = a.minQuantity != null ? a.minQuantity : 1;

  const matched = (items || []).filter(it => {
    if (!it) return false;
    if (ids && !ids.includes(it.id)) return false;
    if (cats && !cats.includes(it.category)) return false;
    return true;
  });
  const totalQty = matched.reduce((s, it) => s + (parseInt(it.quantity, 10) || 1), 0);
  return totalQty >= minQ ? matched : [];
}

function itemsSubtotal(items) {
  return (items || []).reduce((s, it) => {
    const p = typeof it.price === "number" ? it.price : 0;
    const q = parseInt(it.quantity, 10) || 1;
    return s + p * q;
  }, 0);
}

function round2(n) { return Math.round(n * 100) / 100; }

// ─── MOTOR ────────────────────────────────────────────────────────────────────

/**
 * Aplica las promociones activas del proveedor sobre el pedido.
 *
 * @param {Array}  items       ítems ya resueltos (con id, category, price, quantity)
 * @param {Object} ctx         { orderType, baseTotal }
 * @param {string} providerSlug
 * @returns {{ discounts: Array, totalDiscount: number, newTotal: number, labels: string[] }}
 *
 * NUNCA lanza. Sin reglas activas devuelve el total intacto.
 */
function applyPromotions(items, ctx = {}, providerSlug = "la-locanda") {
  const baseTotal = typeof ctx.baseTotal === "number" ? ctx.baseTotal : itemsSubtotal(items);
  const empty = { discounts: [], totalDiscount: 0, newTotal: round2(baseTotal), labels: [] };

  let provider;
  try { provider = getProvider(providerSlug); } catch (_) { return empty; }

  const rules = Array.isArray(provider.promotions) ? provider.promotions.filter(r => r && r.active !== false) : [];
  if (!rules.length) return empty;   // ← camino actual: motor vacío, no-op

  const context = { orderType: ctx.orderType || null, baseTotal };
  const discounts = [];
  let totalDiscount = 0;
  let usedNonStackable = false;

  for (const rule of rules) {
    try {
      if (usedNonStackable) break;
      if (!conditionsMet(rule, context, provider.timezone)) continue;

      const matched = matchingItems(rule, items);
      if (!matched.length) continue;

      const subtotal = itemsSubtotal(matched);
      let amount = 0;

      if (rule.type === "percent") {
        amount = subtotal * (Number(rule.value) || 0) / 100;
      } else if (rule.type === "amount") {
        amount = Number(rule.value) || 0;
      } else if (rule.type === "free_item") {
        // El más barato de los que casan sale gratis.
        const prices = matched
          .map(it => (typeof it.price === "number" ? it.price : 0))
          .sort((x, y) => x - y);
        amount = prices.length ? prices[0] : 0;
      } else {
        continue; // tipo desconocido → regla ignorada
      }

      amount = round2(Math.max(0, Math.min(amount, subtotal)));
      if (amount <= 0) continue;

      discounts.push({ id: rule.id || null, label: rule.label || "Promoción", amount, type: rule.type });
      totalDiscount += amount;
      if (rule.stackable === false) usedNonStackable = true;
    } catch (e) {
      console.error("[PROMO] regla ignorada por error | " + (rule && rule.id) + " | " + e.message);
    }
  }

  totalDiscount = round2(Math.min(totalDiscount, baseTotal)); // nunca negativo
  return {
    discounts,
    totalDiscount,
    newTotal: round2(Math.max(0, baseTotal - totalDiscount)),
    labels: discounts.map(d => d.label)
  };
}

/** Lista las promociones activas (para que Sarah pueda mencionarlas). */
function listActivePromotions(providerSlug = "la-locanda") {
  try {
    const provider = getProvider(providerSlug);
    const rules = Array.isArray(provider.promotions) ? provider.promotions : [];
    return rules.filter(r => r && r.active !== false).map(r => ({ id: r.id, label: r.label }));
  } catch (_) { return []; }
}

module.exports = { applyPromotions, listActivePromotions, itemsSubtotal };
