"use strict";

/**
 * VOZRA ORDERS — Perfil de cliente recurrente (Supabase / Postgres)
 *
 * Guarda, SOLO CON CONSENTIMIENTO EXPLÍCITO del cliente, su nombre + dirección
 * de reparto asociados a su teléfono, para que en la siguiente llamada Sarah
 * pueda saludarle por su nombre y CONFIRMAR la dirección en vez de preguntarla.
 *
 * Privacidad (GDPR): solo se persiste si `consent === true`. `getCustomerByPhone`
 * solo devuelve perfiles con consentimiento. El restaurante es el responsable del
 * dato; debe poder borrarlo a petición (DELETE por phone).
 *
 * Reutiliza el mismo patrón REST (PostgREST) y las mismas env que supabase-store.js.
 * Tabla: <schema>.customers  (schema por defecto vozra_orders). Clave: phone.
 * Si faltan URL/KEY → no-op seguro (skipped), nunca rompe el flujo del pedido.
 */

const https = require("https");

const SCHEMA = process.env.SUPABASE_ORDERS_SCHEMA || "vozra_orders";

function cfg() {
  return {
    url: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  };
}
function isEnabled() {
  const { url, key } = cfg();
  return !!(url && key);
}

function request(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const { url, key } = cfg();
    if (!url || !key) return reject(new Error("Supabase no configurado (URL/SERVICE_ROLE_KEY)"));
    const payload = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const u = new URL(url + path);
    const headers = {
      "apikey": key,
      "Authorization": "Bearer " + key,
      "Content-Type": "application/json",
      "Accept-Profile": SCHEMA,
      "Content-Profile": SCHEMA,
      ...(extraHeaders || {})
    };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, status: res.statusCode, body: data });
          else reject(new Error("Supabase HTTP " + res.statusCode + ": " + data.slice(0, 300)));
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("Supabase request timeout (8s)")));
    if (payload) req.write(payload);
    req.end();
  });
}

// Normaliza el teléfono a solo dígitos con prefijo, para casar entre llamadas.
function normalizePhone(phone) {
  if (!phone) return null;
  const p = String(phone).trim().replace(/[^\d+]/g, "");
  return p || null;
}

// Normaliza el objeto de restricciones a { allergies:[], preferences:[] }.
function parseRestrictions(raw) {
  let r = raw;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch (_) { r = null; } }
  r = r && typeof r === "object" ? r : {};
  const arr = v => Array.isArray(v) ? v.filter(x => x != null && String(x).trim()).map(x => String(x).trim()) : [];
  return { allergies: arr(r.allergies), preferences: arr(r.preferences) };
}

// Une (sin duplicados, case-insensitive) las restricciones existentes con las nuevas.
function mergeRestrictions(existing, incoming) {
  const a = parseRestrictions(existing);
  const b = parseRestrictions(incoming);
  const uniq = (x, y) => {
    const seen = new Set(x.map(s => s.toLowerCase()));
    const out = x.slice();
    for (const it of y) if (!seen.has(it.toLowerCase())) { seen.add(it.toLowerCase()); out.push(it); }
    return out;
  };
  return { allergies: uniq(a.allergies, b.allergies), preferences: uniq(a.preferences, b.preferences) };
}

/**
 * Devuelve el perfil del cliente por teléfono SOLO si dio consentimiento.
 * @returns {Promise<{phone,name,address,orderCount,lastOrderAt}|null>}
 */
async function getCustomerByPhone(phone) {
  const p = normalizePhone(phone);
  if (!p || !isEnabled()) return null;
  try {
    const r = await request(
      "GET",
      "/rest/v1/customers?phone=eq." + encodeURIComponent(p) + "&consent=eq.true&limit=1",
      null
    );
    const arr = JSON.parse(r.body || "[]");
    const row = arr[0];
    if (!row) return null;
    return {
      phone:        row.phone,
      name:         row.name || null,
      address:      row.address || null,   // jsonb: { raw, ... }
      restrictions: parseRestrictions(row.restrictions), // { allergies, preferences }
      orderCount:   row.order_count || 0,
      lastOrderAt:  row.last_order_at || null
    };
  } catch (e) {
    console.error("[CUST] getCustomerByPhone error:", e.message);
    return null;
  }
}

/**
 * Guarda/actualiza el perfil SOLO con consentimiento. No lanza.
 * @param {{phone,name,address,providerSlug,consent}} data
 */
async function upsertCustomer(data = {}) {
  try {
    if (!isEnabled()) return { ok: false, skipped: true, reason: "Supabase no configurado" };
    if (data.consent !== true) return { ok: false, skipped: true, reason: "sin consentimiento" };
    const p = normalizePhone(data.phone);
    if (!p) return { ok: false, skipped: true, reason: "sin teléfono" };

    const row = {
      phone:         p,
      provider_slug: data.providerSlug || "la-locanda",
      consent:       true,
      consent_at:    new Date().toISOString(),
      last_order_at: new Date().toISOString(),
      updated_at:    new Date().toISOString()
    };
    // Solo se escriben nombre/dirección si vienen: así actualizar SOLO las restricciones
    // (p. ej. una alergia nueva de un cliente ya registrado) no borra su nombre ni su dirección.
    if (data.name != null) row.name = data.name;
    if (data.address != null) row.address = data.address;

    // Restricciones/preferencias: se ACUMULAN, no se sobrescriben. Leemos las
    // existentes y unimos con las nuevas (alergias del pedido, etc.).
    if (data.restrictions) {
      let existing = null;
      try {
        const cur = await request("GET", "/rest/v1/customers?phone=eq." + encodeURIComponent(p) + "&select=restrictions&limit=1", null);
        existing = (JSON.parse(cur.body || "[]")[0] || {}).restrictions;
      } catch (_) { existing = null; }
      row.restrictions = mergeRestrictions(existing, data.restrictions);
    }
    Object.keys(row).forEach(k => { if (row[k] === undefined) delete row[k]; });

    await request(
      "POST",
      "/rest/v1/customers?on_conflict=phone",
      row,
      { "Prefer": "resolution=merge-duplicates,return=minimal" }
    );
    return { ok: true };
  } catch (e) {
    console.error("[CUST] upsertCustomer error:", e.message);
    return { ok: false, error: e.message };
  }
}

/** Borra el perfil (derecho de supresión GDPR). No lanza. */
async function deleteCustomer(phone) {
  try {
    if (!isEnabled()) return { ok: false, skipped: true };
    const p = normalizePhone(phone);
    if (!p) return { ok: false, skipped: true };
    await request("DELETE", "/rest/v1/customers?phone=eq." + encodeURIComponent(p), null, { "Prefer": "return=minimal" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { getCustomerByPhone, upsertCustomer, deleteCustomer, normalizePhone, isEnabled, parseRestrictions, mergeRestrictions };
