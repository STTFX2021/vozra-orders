"use strict";

/**
 * VOZRA ORDERS — ACK de cocina vía Telegram (botón inline + webhook)
 *
 * Cierra el bucle de entrega de forma honesta:
 *   - Cada comanda de Telegram lleva un botón "✅ Recibido en cocina".
 *   - Al pulsarlo, Telegram llama a POST /telegram/webhook con un callback_query.
 *     → marcamos el pedido como recibido (monitor en memoria + estado durable en Supabase).
 *   - Si NADIE pulsa en warningMs/criticalMs, el monitor de ACK envía un recordatorio
 *     VISIBLE al propio canal de cocina (no a un log que nadie lee).
 *
 * Config opcional:
 *   TELEGRAM_WEBHOOK_SECRET  → si está, se exige en la cabecera X-Telegram-Bot-Api-Secret-Token.
 *
 * Registro del webhook (una vez, con la URL pública de Railway):
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<APP>/telegram/webhook&secret_token=<SECRET>&allowed_updates=["callback_query"]
 */

const express = require("express");
const https   = require("https");
const router  = express.Router();

const { markKitchenAck, setAlertHandler } = require("./kitchen-ack-monitor.service.js");
let patchByOrderId = null;
try { ({ patchByOrderId } = require("./supabase-store.js")); } catch (_) {}

// ─── CONFIG / API DE TELEGRAM ─────────────────────────────────────────────────

function tgConfig() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN_LA_LOCANDA || process.env.TELEGRAM_BOT_TOKEN || "",
    chatId: process.env.TELEGRAM_CHAT_ID_LA_LOCANDA || process.env.TELEGRAM_CHAT_ID || ""
  };
}

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const { token } = tgConfig();
    if (!token) return reject(new Error("Telegram token no configurado"));
    const payload = JSON.stringify(body || {});
    const req = https.request({
      hostname: "api.telegram.org",
      path: "/bot" + token + "/" + method,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      let data = ""; res.on("data", c => { data += c; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data || "{}"));
        else reject(new Error("Telegram " + method + " HTTP " + res.statusCode + ": " + data.slice(0, 200)));
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("Telegram timeout")));
    req.write(payload); req.end();
  });
}

/** Envía un recordatorio al canal de cocina, con el botón de ACK incluido. */
async function sendKitchenReminder(orderId, text) {
  const { chatId } = tgConfig();
  if (!chatId) throw new Error("Telegram chatId no configurado");
  return tgApi("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: [[{ text: "✅ Recibido en cocina", callback_data: "ack:" + orderId }]] }
  });
}

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

router.post("/telegram/webhook", express.json(), async (req, res) => {
  // Verificación opcional del secreto del webhook.
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expected && req.headers["x-telegram-bot-api-secret-token"] !== expected) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const cb = req.body && req.body.callback_query;
  // Respondemos 200 siempre (Telegram reintenta si no) y procesamos lo que sepamos.
  res.status(200).json({ ok: true });
  if (!cb || !cb.data) return;

  try {
    const data = String(cb.data);
    if (!data.startsWith("ack:")) return;
    const orderId = data.slice(4);

    // 1) Monitor en memoria (cancela timers si el pedido sigue vivo en este proceso).
    let ackResult = { ok: false };
    try { ackResult = markKitchenAck(orderId, "acknowledged"); } catch (_) {}

    // 2) Estado durable en Supabase (sobrevive reinicios, aunque el monitor ya no lo tenga).
    if (patchByOrderId) {
      try { await patchByOrderId(orderId, { status: "kitchen_acknowledged" }); } catch (_) {}
    }

    // 3) Feedback al que pulsó + quitar el botón para que no se re-pulse.
    try { await tgApi("answerCallbackQuery", { callback_query_id: cb.id, text: "¡Recibido! Gracias 🍕" }); } catch (_) {}
    if (cb.message && cb.message.chat && cb.message.message_id) {
      try {
        await tgApi("editMessageReplyMarkup", {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: "✅ Recibido", callback_data: "noop" }]] }
        });
      } catch (_) {}
    }
    console.log("[ACK] pedido confirmado por cocina | " + orderId + " | monitor=" + (ackResult && ackResult.ok));
  } catch (e) {
    console.error("[ACK] error procesando callback | " + e.message);
  }
});

// ─── CABLEO DE ALERTAS → CANAL DE COCINA ──────────────────────────────────────

/**
 * Hace que las alertas de "sin confirmar" se envíen al canal de cocina (visibles),
 * en vez de solo a console. Llamar una vez al arrancar el server.
 */
function wireKitchenAlerts() {
  setAlertHandler((level, orderId, message) => {
    const icon = level === "critical" ? "🚨" : "⚠️";
    console.warn(`[KitchenACK] ${icon} ${level.toUpperCase()} | ${orderId} | ${message}`);
    const text = `${icon} Pedido ${orderId}: ${message} Si ya lo tenéis, pulsad "Recibido".`;
    sendKitchenReminder(orderId, text).catch(e => console.error("[KitchenACK] recordatorio Telegram falló | " + e.message));
  });
}

module.exports = router;
module.exports.wireKitchenAlerts = wireKitchenAlerts;
module.exports.sendKitchenReminder = sendKitchenReminder;
