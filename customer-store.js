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
      phone:       row.phone,
      name:        row.name || null,
      address:     row.address || null,   // jsonb: { raw, ... }
      orderCount:  row.order_count || 0,
      lastOrderAt: row.last_order_at || null
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
      name:          data.name || null,
      address:       data.address || null,   // objeto → jsonb
      provider_slug: data.providerSlug || "la-locanda",
      consent:       true,
      consent_at:    new Date().toISOString(),
      last_order_at: new Date().toISOString(),
      updated_at:    new Date().toISOString()
    };
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

module.exports = { getCustomerByPhone, upsertCustomer, deleteCustomer, normalizePhone, isEnabled };
