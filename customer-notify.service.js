"use strict";

/**
 * VOZRA ORDERS — Notificación de confirmación al CLIENTE (SMS / WhatsApp)
 *
 * Envía un mensaje corto al cliente cuando su pedido entra de verdad en cocina.
 * Se dispara SOLO si el dispatch fue "delivered" (canal real), nunca con file_fallback,
 * para no prometer al cliente algo que cocina no ha recibido.
 *
 * Sin dependencias externas: usa la API REST de Twilio vía https.
 *
 * Variables de entorno:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN     (ya existentes)
 *   CUSTOMER_NOTIFY_CHANNEL = "sms" | "whatsapp" | "off"   (opcional; auto si no se pone)
 *   TWILIO_SMS_FROM         = "+34XXXXXXXXX" o sender alfanumérico   (para SMS)
 *   TWILIO_MESSAGING_SERVICE_SID = "MGxxxx"   (alternativa a TWILIO_SMS_FROM)
 *   TWILIO_WHATSAPP_FROM    = "whatsapp:+14155238886"   (para WhatsApp; sandbox o sender real)
 *   CUSTOMER_NOTIFY_TEST_TO = "+34611404679"   (opcional: fuerza el destinatario en pruebas)
 *   DEFAULT_COUNTRY_CODE    = "34"   (opcional; por defecto España)
 */

const https = require("https");

// ─── TELÉFONO → E.164 ─────────────────────────────────────────────────────────

/**
 * Normaliza un teléfono a formato E.164 (+<país><número>).
 * Pensado para España por defecto (móviles de 9 dígitos que empiezan por 6/7).
 */
function toE164(phone, defaultCc) {
  if (!phone) return null;
  let s = String(phone).trim().replace(/[\s().\-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+")) return /^\+\d{6,15}$/.test(s) ? s : null;
  const cc = String(defaultCc || process.env.DEFAULT_COUNTRY_CODE || "34");
  const digits = s.replace(/\D/g, "");
  if (!digits) return null;
  // 9 dígitos (móvil/fijo nacional ES) → anteponer prefijo país
  if (digits.length === 9) return "+" + cc + digits;
  // ya trae prefijo país sin '+'
  if (digits.length > 9) return "+" + digits;
  return null;
}

// ─── CONFIG / RESOLUCIÓN DE CANAL ─────────────────────────────────────────────

function resolveChannel() {
  const explicit = (process.env.CUSTOMER_NOTIFY_CHANNEL || "").toLowerCase().trim();
  if (explicit === "off") return { channel: "off" };
  if (explicit === "sms") return { channel: "sms" };
  if (explicit === "whatsapp") return { channel: "whatsapp" };
  // Auto: WhatsApp si hay sender de WhatsApp; si no, SMS si hay from/MGS; si no, off.
  if (process.env.TWILIO_WHATSAPP_FROM) return { channel: "whatsapp" };
  if (process.env.TWILIO_SMS_FROM || process.env.TWILIO_MESSAGING_SERVICE_SID) return { channel: "sms" };
  return { channel: "off" };
}

// ─── MENSAJE ──────────────────────────────────────────────────────────────────

function firstName(name) {
  return name ? " " + String(name).split(" ")[0] : "";
}

/** Mensaje corto de confirmación. Idioma: español (MVP). */
function buildMessage(order, validation) {
  const restaurant = "La Locanda de Cancelada";
  const items = (order.items || [])
    .map(i => (i.quantity > 1 ? i.quantity + "x " : "") + (i.displayName || "producto"))
    .join(", ");
  const total = validation && validation.estimatedTotal != null ? validation.estimatedTotal : null;
  const way = order.orderType === "delivery" ? "Te lo llevamos a domicilio." : "Puedes pasar a recogerlo.";
  let m = restaurant + ": ¡pedido confirmado" + firstName(order.customerName) + "! ";
  if (items) m += items + ". ";
  if (total != null) m += "Total aprox. " + total + " €. ";
  m += way + " ¡Gracias!";
  return m;
}

// ─── ENVÍO TWILIO (REST) ──────────────────────────────────────────────────────

function twilioSend(to, body, channel) {
  return new Promise((resolve, reject) => {
    const sid   = process.env.TWILIO_ACCOUNT_SID || "";
    const token = process.env.TWILIO_AUTH_TOKEN  || "";
    if (!sid || !token) return reject(new Error("Twilio SID/Auth no configurados"));

    const params = new URLSearchParams();
    params.append("Body", body);

    if (channel === "whatsapp") {
      const from = process.env.TWILIO_WHATSAPP_FROM || "";
      if (!from) return reject(new Error("TWILIO_WHATSAPP_FROM no configurado"));
      params.append("From", from.startsWith("whatsapp:") ? from : "whatsapp:" + from);
      params.append("To", to.startsWith("whatsapp:") ? to : "whatsapp:" + to);
    } else {
      // SMS: Messaging Service tiene prioridad sobre número fijo.
      const mgs  = process.env.TWILIO_MESSAGING_SERVICE_SID || "";
      const from = process.env.TWILIO_SMS_FROM || "";
      if (mgs)       params.append("MessagingServiceSid", mgs);
      else if (from) params.append("From", from);
      else return reject(new Error("TWILIO_SMS_FROM o TWILIO_MESSAGING_SERVICE_SID no configurado"));
      params.append("To", to);
    }

    const payload = params.toString();
    const auth = Buffer.from(sid + ":" + token).toString("base64");
    const options = {
      hostname: "api.twilio.com",
      path: "/2010-04-01/Accounts/" + sid + "/Messages.json",
      method: "POST",
      headers: {
        "Authorization": "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        let json = {};
        try { json = JSON.parse(data); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, sid: json.sid, status: json.status });
        } else {
          reject(new Error("Twilio HTTP " + res.statusCode + ": " + (json.message || data.slice(0, 200))));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Twilio request timeout (10s)")));
    req.write(payload);
    req.end();
  });
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────

/**
 * Envía la confirmación al cliente. No lanza: devuelve un objeto resultado.
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, sid?:string, channel?:string, to?:string, error?:string}>}
 */
async function sendCustomerConfirmation(order, validation = {}, opts = {}) {
  try {
    const { channel } = resolveChannel();
    if (channel === "off") return { ok: false, skipped: true, reason: "canal desactivado o sin emisor configurado" };

    const rawTo = process.env.CUSTOMER_NOTIFY_TEST_TO || (order && order.phone);
    const to = toE164(rawTo);
    if (!to) return { ok: false, skipped: true, reason: "teléfono del cliente inválido o ausente" };

    const body = (opts && opts.body) || buildMessage(order || {}, validation || {});
    const res = await twilioSend(to, body, channel);
    return { ok: true, channel, to, sid: res.sid, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { sendCustomerConfirmation, toE164, buildMessage, resolveChannel };
