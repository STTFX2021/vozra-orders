"use strict";

/**
 * Persistencia y reserva atómica de llamadas demo en Supabase/PostgREST.
 *
 * Requiere ejecutar `supabase-demo-callbacks.sql` y configurar:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ORDERS_SCHEMA (opcional; por defecto `vozra_orders`)
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
  return Boolean(url && key);
}

function request(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const { url, key } = cfg();
    if (!url || !key) {
      reject(new Error("Supabase no configurado (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)"));
      return;
    }

    const payload = body == null ? null : JSON.stringify(body);
    const target = new URL(url + path);
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Accept-Profile": SCHEMA,
      "Content-Profile": SCHEMA,
      ...extraHeaders
    };

    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname + target.search,
        method,
        headers
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ok: true, status: res.statusCode, body: data });
            return;
          }

          reject(new Error(`Supabase HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("Supabase request timeout (8s)")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function reserveCallback({ phone, country, ip, userAgent, dailyCap }) {
  const response = await request(
    "POST",
    "/rest/v1/rpc/reserve_demo_callback",
    {
      p_phone: phone,
      p_country: country || null,
      p_ip: ip || null,
      p_user_agent: userAgent || null,
      p_daily_cap: dailyCap
    },
    { Prefer: "return=representation" }
  );

  const parsed = JSON.parse(response.body || "null");
  if (!parsed || typeof parsed.allowed !== "boolean") {
    throw new Error("Respuesta inválida de reserve_demo_callback");
  }

  return parsed;
}

async function updateCallbackAttempt(attemptId, patch) {
  if (!attemptId) return { ok: false, skipped: true, reason: "attemptId ausente" };

  try {
    const response = await request(
      "PATCH",
      `/rest/v1/demo_callbacks?id=eq.${encodeURIComponent(attemptId)}`,
      patch,
      { Prefer: "return=minimal" }
    );
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  isEnabled,
  reserveCallback,
  updateCallbackAttempt
};
