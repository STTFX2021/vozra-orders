"use strict";

const express = require("express");
const crypto = require("crypto");
const { parsePhoneNumberFromString } = require("libphonenumber-js");
const {
  isEnabled: isCallbackStoreEnabled,
  reserveCallback,
  updateCallbackAttempt
} = require("./demo-callback.store.js");

const router = express.Router();
const ALLOWED_ORIGIN = "https://vozra-direct-demo.lovable.app";
const ELEVENLABS_OUTBOUND_URL = "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";
const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const COUNTRY_DIALS = {
  ES: "+34",
  PT: "+351",
  FR: "+33",
  IT: "+39",
  DE: "+49",
  GB: "+44",
  MX: "+52",
  AR: "+54",
  US: "+1"
};

function sendError(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, code, message, ...extra });
}

function maskPhone(phone) {
  if (!phone || phone.length < 6) return "***";
  return `${phone.slice(0, 4)}***${phone.slice(-3)}`;
}

function getClientIp(req) {
  const forwarded = req.headers && req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim().slice(0, 80);
  }
  return (req.ip || req.socket?.remoteAddress || "").slice(0, 80);
}

function normalizeCountry(country) {
  const value = String(country || "").trim().toUpperCase();
  if (COUNTRY_DIALS[value]) return value;
  const byDial = Object.entries(COUNTRY_DIALS).find(([, dial]) => dial === value);
  return byDial ? byDial[0] : null;
}

function composeE164(phone, country) {
  const raw = String(phone || "").trim();
  const countryCode = normalizeCountry(country);
  if (!raw || !countryCode) return null;

  try {
    const parsed = parsePhoneNumberFromString(raw, countryCode);
    if (!parsed || !parsed.isValid() || parsed.country !== countryCode) return null;
    return parsed.number;
  } catch {
    return null;
  }
}

function parseDailyCap(value) {
  const parsed = Number.parseInt(String(value || "50"), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 1000);
}

async function fetchJson(url, options, timeoutMs = 12000) {
  if (typeof fetch !== "function") {
    throw new Error("Node.js 18+ requerido: fetch no disponible");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyTurnstileToken(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET || "";
  if (!secret) throw new Error("TURNSTILE_SECRET no configurado");

  const result = await fetchJson(
    TURNSTILE_VERIFY_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: remoteIp || undefined,
        idempotency_key: crypto.randomUUID()
      })
    },
    8000
  );

  if (!result.ok) throw new Error(`Turnstile HTTP ${result.status}`);
  return {
    success: result.data?.success === true,
    errorCodes: Array.isArray(result.data?.["error-codes"]) ? result.data["error-codes"] : []
  };
}

async function placeOutboundCall(toNumber) {
  const apiKey = process.env.ELEVENLABS_API_KEY || "";
  const agentId = process.env.ELEVENLABS_AGENT_ID || "";
  const phoneNumberId = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID || "";

  if (!apiKey || !agentId || !phoneNumberId) {
    throw new Error("Configuración de ElevenLabs incompleta");
  }

  const result = await fetchJson(
    ELEVENLABS_OUTBOUND_URL,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        agent_id: agentId,
        agent_phone_number_id: phoneNumberId,
        to_number: toNumber
      })
    },
    15000
  );

  if (!result.ok || result.data?.success === false) {
    const providerMessage = result.data?.detail || result.data?.message || `ElevenLabs HTTP ${result.status}`;
    const error = new Error(String(providerMessage).slice(0, 300));
    error.providerStatus = result.status;
    throw error;
  }

  return result.data || {};
}

function rateLimitMessage(reason) {
  if (reason === "cooldown") return "Ya se solicitó una llamada recientemente. Espera unos minutos.";
  if (reason === "phone_daily_cap") return "Este número alcanzó el límite diario de demostraciones.";
  if (reason === "global_daily_cap") return "La demo alcanzó el límite diario. Inténtalo mañana.";
  return "Límite de demostraciones alcanzado.";
}

function createDemoCallbackHandler(deps = {}) {
  const verifyCaptcha = deps.verifyTurnstileToken || verifyTurnstileToken;
  const reserve = deps.reserveCallback || reserveCallback;
  const dispatch = deps.placeOutboundCall || placeOutboundCall;
  const updateAttempt = deps.updateCallbackAttempt || updateCallbackAttempt;
  const storeEnabled = deps.isCallbackStoreEnabled || isCallbackStoreEnabled;

  return async function demoCallbackHandler(req, res) {
    const requestId = crypto.randomUUID();
    const ip = getClientIp(req);
    const body = req.body || {};
    const phone = composeE164(body.phone, body.country);
    const country = normalizeCountry(body.country);
    const logBase = { requestId, phone: maskPhone(phone), country, ip };

    console.log(JSON.stringify({ event: "demo_callback_attempt", stage: "received", ...logBase }));

    if (body.consent !== true) {
      console.warn(JSON.stringify({ event: "demo_callback_attempt", stage: "rejected", reason: "consent", ...logBase }));
      return sendError(res, 400, "consent_required", "Debes aceptar recibir la llamada.");
    }

    if (!phone || !country) {
      console.warn(JSON.stringify({ event: "demo_callback_attempt", stage: "rejected", reason: "phone", ...logBase }));
      return sendError(res, 400, "invalid_phone", "Introduce un número de teléfono válido.");
    }

    const captchaToken = typeof body.captchaToken === "string" ? body.captchaToken.trim() : "";
    if (!captchaToken || captchaToken.length > 2048) {
      console.warn(JSON.stringify({ event: "demo_callback_attempt", stage: "rejected", reason: "captcha_missing", ...logBase }));
      return sendError(res, 400, "captcha_required", "Completa la verificación de seguridad.");
    }

    let captcha;
    try {
      captcha = await verifyCaptcha(captchaToken, ip);
    } catch (error) {
      console.error(JSON.stringify({ event: "demo_callback_attempt", stage: "error", reason: "captcha_service", message: error.message, ...logBase }));
      return sendError(res, 503, "captcha_unavailable", "La verificación no está disponible. Inténtalo de nuevo.");
    }

    if (!captcha.success) {
      console.warn(JSON.stringify({ event: "demo_callback_attempt", stage: "rejected", reason: "captcha_invalid", codes: captcha.errorCodes, ...logBase }));
      return sendError(res, 403, "captcha_invalid", "La verificación de seguridad no es válida.");
    }

    if (!storeEnabled()) {
      console.error(JSON.stringify({ event: "demo_callback_attempt", stage: "error", reason: "callback_store_unavailable", ...logBase }));
      return sendError(res, 503, "service_unavailable", "La demo no está disponible temporalmente.");
    }

    let reservation;
    try {
      reservation = await reserve({
        phone,
        country,
        ip,
        userAgent: String(req.headers?.["user-agent"] || "").slice(0, 500),
        dailyCap: parseDailyCap(process.env.DEMO_DAILY_CAP)
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "demo_callback_attempt", stage: "error", reason: "rate_store", message: error.message, ...logBase }));
      return sendError(res, 503, "service_unavailable", "La demo no está disponible temporalmente.");
    }

    if (!reservation.allowed) {
      const retryAfterSeconds = Number(reservation.retry_after_seconds) || 60;
      res.set("Retry-After", String(retryAfterSeconds));
      console.warn(JSON.stringify({ event: "demo_callback_attempt", stage: "rate_limited", reason: reservation.reason, retryAfterSeconds, ...logBase }));
      return sendError(
        res,
        429,
        "rate_limited",
        rateLimitMessage(reservation.reason),
        { retryAfterSeconds }
      );
    }

    const attemptId = reservation.attempt_id;

    try {
      const provider = await dispatch(phone);
      await updateAttempt(attemptId, {
        status: "dispatched",
        reason: null,
        provider_conversation_id: provider.conversation_id || null,
        provider_call_sid: provider.callSid || null,
        provider_message: provider.message || null,
        dispatched_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

      console.log(JSON.stringify({ event: "demo_callback_attempt", stage: "dispatched", attemptId, ...logBase }));
      return res.status(200).json({ ok: true });
    } catch (error) {
      await updateAttempt(attemptId, {
        status: "failed",
        reason: "provider_error",
        provider_message: String(error.message || "provider_error").slice(0, 500),
        updated_at: new Date().toISOString()
      });

      console.error(JSON.stringify({ event: "demo_callback_attempt", stage: "error", reason: "elevenlabs", attemptId, message: error.message, ...logBase }));
      return sendError(res, 502, "call_failed", "No se pudo iniciar la llamada. Inténtalo de nuevo más tarde.");
    }
  };
}

function demoCors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) {
    return sendError(res, 403, "origin_not_allowed", "Origen no permitido.");
  }

  if (origin === ALLOWED_ORIGIN) {
    res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  return next();
}

router.options("/api/demo/callback", demoCors);
router.post("/api/demo/callback", demoCors, createDemoCallbackHandler());

module.exports = router;
module.exports.createDemoCallbackHandler = createDemoCallbackHandler;
module.exports.composeE164 = composeE164;
module.exports.normalizeCountry = normalizeCountry;
module.exports.demoCors = demoCors;
module.exports.verifyTurnstileToken = verifyTurnstileToken;
module.exports.placeOutboundCall = placeOutboundCall;
