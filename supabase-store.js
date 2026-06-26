"use strict";

/**
 * VOZRA ORDERS — Persistencia durable de pedidos (Supabase / Postgres)
 *
 * Fuente de verdad del pedido. Se escribe ANTES del dispatch para sobrevivir a
 * reinicios del contenedor (Railway es efímero): si el proceso cae tras confirmar
 * pero antes/durante el envío a cocina, el pedido sigue existiendo y es recuperable.
 *
 * Sin SDK: REST (PostgREST) vía https. Tabla en schema dedicado `vozra_orders`.
 * Idempotente por `order_id` (upsert con on_conflict).
 *
 * Variables de entorno:
 *   SUPABASE_URL                = https://<ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY   = (secreto; se salta RLS — solo backend)
 *   SUPABASE_ORDERS_SCHEMA      = vozra_orders   (opcional, por defecto vozra_orders)
 *
 * Si faltan URL o key → no-op seguro (skipped), no rompe el flujo de pedido.
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

// ─── HTTP (PostgREST) ─────────────────────────────────────────────────────────

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
      "Accept-Profile": SCHEMA,   // lecturas en el schema dedicado
      "Content-Profile": SCHEMA,  // escrituras en el schema dedicado
      ...(extraHeaders || {})
    };
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method, headers },
      (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, body: data });
          } else {
            reject(new Error("Supabase HTTP " + res.statusCode + ": " + data.slice(0, 300)));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("Supabase request timeout (8s)")));
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── MAPEO PEDIDO → FILA ──────────────────────────────────────────────────────

function toRow(order, validation, extra) {
  order = order || {};
  validation = validation || {};
  extra = extra || {};
  const total = validation.estimatedTotal != null ? validation.estimatedTotal : null;
  return {
    order_id:        order.orderId || null,
    call_id:         order.callId || null,
    provider_slug:   order.providerSlug || "la-locanda",
    status:          order.status || null,
    order_type:      order.orderType || null,
    customer_name:   order.customerName || null,
    phone:           order.phone || null,
    address:         order.address || null,
    items:           order.items || [],
    allergies:       order.allergies || null,
    notes:           order.notes || null,
    estimated_total: total,
    currency:        validation.currency || "EUR",
    dispatch_channel: extra.channel != null ? extra.channel : (order.dispatchChannel || null),
    delivered:       extra.delivered != null ? !!extra.delivered : false,
    customer_notified: extra.customerNotified != null ? !!extra.customerNotified : undefined,
    language:        extra.language || order.language || null,
    events:          order.events || [],
    raw:             order
  };
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────

/**
 * Inserta o actualiza el pedido por order_id (idempotente). No lanza.
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, error?:string}>}
 */
async function upsertOrder(order, validation = {}, extra = {}) {
  try {
    if (!isEnabled()) return { ok: false, skipped: true, reason: "Supabase no configurado" };
    if (!order || !order.orderId) return { ok: false, skipped: true, reason: "order sin orderId" };

    const row = toRow(order, validation, extra);
    // Quitar undefined para no pisar columnas con null sin querer (p.ej. customer_notified).
    Object.keys(row).forEach(k => { if (row[k] === undefined) delete row[k]; });

    await request(
      "POST",
      "/rest/v1/orders?on_conflict=order_id",
      row,
      { "Prefer": "resolution=merge-duplicates,return=minimal" }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Actualiza campos sueltos de un pedido por order_id (p.ej. estado ACK). No lanza. */
async function patchByOrderId(orderId, patch) {
  try {
    if (!isEnabled()) return { ok: false, skipped: true, reason: "Supabase no configurado" };
    if (!orderId) return { ok: false, skipped: true, reason: "sin orderId" };
    await request(
      "PATCH",
      "/rest/v1/orders?order_id=eq." + encodeURIComponent(orderId),
      patch,
      { "Prefer": "return=minimal" }
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Lee un pedido por order_id (para recuperación). No lanza. */
async function getOrder(orderId) {
  try {
    if (!isEnabled()) return { ok: false, skipped: true, reason: "Supabase no configurado" };
    const r = await request("GET", "/rest/v1/orders?order_id=eq." + encodeURIComponent(orderId) + "&limit=1", null);
    const arr = JSON.parse(r.body || "[]");
    return { ok: true, order: arr[0] || null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { upsertOrder, patchByOrderId, getOrder, isEnabled, toRow };
