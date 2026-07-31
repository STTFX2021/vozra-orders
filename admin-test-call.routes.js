/**
 * admin-test-call.routes.js
 *
 * Disparar una LLAMADA SALIENTE de prueba: Sarah te llama a ti.
 *
 * Por qué no es "Twilio directo": el número de Twilio está conectado al agente
 * de ElevenLabs. Si llamáramos con la API de Twilio a pelo, la llamada saldría
 * pero SIN Sarah (haría falta un TwiML propio). La forma correcta es pedirle a
 * ElevenLabs que llame usando ese número: POST /v1/convai/twilio/outbound-call.
 * Esa llamada ya la hace `placeOutboundCall` (demo-callback.routes.js); aquí
 * solo la exponemos sin el captcha ni los límites de la demo pública.
 *
 * SEGURIDAD (esto gasta dinero: hay que blindarlo):
 *  - Bearer OBLIGATORIO. Fail-closed: sin secreto configurado → 503, no abierto.
 *  - Allowlist opcional de destinos (TEST_CALL_ALLOWED_NUMBERS, E.164 separados
 *    por comas). Si está definida, solo se llama a esos números.
 *  - El teléfono se enmascara en los logs (nada de PII en claro).
 *
 * ENDPOINTS
 *  GET  /admin/test-call/diag   → qué variables faltan (nunca devuelve valores)
 *  POST /admin/test-call        → body {"to":"+34600000000"}  (o "600000000")
 *
 * Variables:
 *  ADMIN_TEST_CALL_SECRET          (si falta, cae a ELEVENLABS_CUSTOM_LLM_SECRET)
 *  ELEVENLABS_API_KEY              \
 *  ELEVENLABS_AGENT_ID              > las 3 son imprescindibles para llamar
 *  ELEVENLABS_AGENT_PHONE_NUMBER_ID/
 *  TEST_CALL_ALLOWED_NUMBERS       (opcional, recomendada)
 *  DEFAULT_COUNTRY_CODE            (opcional, por defecto 34)
 */
const express = require("express");
const router = express.Router();

const { placeOutboundCall, turnstileSecret } = require("./demo-callback.routes.js");
const { isProduction } = require("./whatsapp-twilio.routes.js");
const { toE164 } = require("./customer-notify.service.js");

const REQUIRED_VARS = ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_AGENT_PHONE_NUMBER_ID"];

function maskPhone(p) {
  const s = String(p || "");
  return s.length <= 4 ? "***" : s.slice(0, 4) + "***" + s.slice(-2);
}

/** Fail-closed: si no hay secreto configurado, el endpoint NO queda abierto. */
function authorize(req, res) {
  const secret = process.env.ADMIN_TEST_CALL_SECRET || process.env.ELEVENLABS_CUSTOM_LLM_SECRET || "";
  if (!secret) {
    res.status(503).json({ ok: false, error: "sin_secreto_configurado" });
    return false;
  }
  const auth = String(req.headers.authorization || "");
  if (auth !== "Bearer " + secret) {
    res.status(401).json({ ok: false, error: "no_autorizado" });
    return false;
  }
  return true;
}

/** Allowlist opcional de destinos. Sin ella, se permite (pero se avisa en el log). */
function allowedTarget(e164) {
  const raw = String(process.env.TEST_CALL_ALLOWED_NUMBERS || "").trim();
  if (!raw) return { allowed: true, enforced: false };
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  return { allowed: list.includes(e164), enforced: true };
}

router.get("/admin/test-call/diag", (req, res) => {
  if (!authorize(req, res)) return;
  const vars = {};
  for (const v of REQUIRED_VARS) vars[v] = Boolean(process.env[v]);
  const faltan = REQUIRED_VARS.filter(v => !process.env[v]);
  res.json({
    ok: faltan.length === 0,
    listo_para_llamar: faltan.length === 0,
    vars,
    faltan,
    allowlist_activa: Boolean(String(process.env.TEST_CALL_ALLOWED_NUMBERS || "").trim()),
    pista: faltan.length ? "Pon esas variables en Railway → Variables y redespliega." : "Todo listo: POST /admin/test-call",
    // Panel de seguridad: solo booleanos, nunca valores.
    seguridad: {
      es_produccion: isProduction(),
      twilio_firma_obligatoria: isProduction() && Boolean(process.env.TWILIO_AUTH_TOKEN),
      twilio_skip_signature_puesta: process.env.TWILIO_SKIP_SIGNATURE === "true",
      turnstile_configurado: Boolean(turnstileSecret()),
      turnstile_nombre_canonico: Boolean(process.env.TURNSTILE_SECRET)
    }
  });
});

router.post("/admin/test-call", async (req, res) => {
  if (!authorize(req, res)) return;

  const faltan = REQUIRED_VARS.filter(v => !process.env[v]);
  if (faltan.length) {
    return res.status(503).json({ ok: false, error: "config_incompleta", faltan });
  }

  const to = toE164((req.body && (req.body.to || req.body.phone)) || "", process.env.DEFAULT_COUNTRY_CODE || "34");
  if (!to) return res.status(400).json({ ok: false, error: "telefono_invalido" });

  const gate = allowedTarget(to);
  if (!gate.allowed) {
    console.warn("[TESTCALL] destino fuera de la allowlist | to=" + maskPhone(to));
    return res.status(403).json({ ok: false, error: "destino_no_permitido" });
  }
  if (!gate.enforced) {
    console.warn("[TESTCALL] sin TEST_CALL_ALLOWED_NUMBERS: cualquier destino es válido con este secreto.");
  }

  try {
    const data = await placeOutboundCall(to);
    console.log("[TESTCALL] llamada lanzada | to=" + maskPhone(to) + " | conv=" + (data.conversation_id || "?"));
    res.json({
      ok: true,
      to: maskPhone(to),
      conversation_id: data.conversation_id || null,
      callSid: data.callSid || data.call_sid || null
    });
  } catch (e) {
    console.error("[TESTCALL] fallo | to=" + maskPhone(to) + " | " + e.message);
    res.status(e.providerStatus && e.providerStatus < 500 ? 400 : 502)
       .json({ ok: false, error: "fallo_al_llamar", detalle: String(e.message).slice(0, 300) });
  }
});

module.exports = router;
module.exports.REQUIRED_VARS = REQUIRED_VARS;
module.exports.allowedTarget = allowedTarget;
module.exports.maskPhone = maskPhone;
