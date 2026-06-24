"use strict";

/**
 * VOZRA ORDERS — Dispatch Adapter
 * Fase 5: Envía la comanda de cocina al canal configurado del proveedor.
 *
 * Canales soportados:
 *   1. Telegram Bot API  (prioridad 1)
 *   2. Discord Webhook   (prioridad 2)
 *   3. File Fallback     (prioridad 3 — siempre activo)
 *
 * Flujo:
 *   dispatchOrder(order, validationResult, providerSlug)
 *     → intenta canales en orden de prioridad
 *     → en cuanto uno funciona, para
 *     → si todos fallan → failed_dispatch
 *     → registra cada intento en el Order Ledger (order.events)
 *
 * Retorna: DispatchResult { ok, channel, attempts, order }
 */

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const { getActiveChannels } = require("./provider-profile.config.js");
const { buildTextTicket }   = require("./kitchen-ticket-builder.service.js");
const { updateOrderSession, ORDER_STATUS } = require("./order-call-session.store.js");

// ─── FORMATTERS POR CANAL ────────────────────────────────────────────────────

/**
 * Telegram: HTML básico. Sin markdown — muchos caracteres dan problemas.
 * Máximo ~4096 chars por mensaje.
 */
function formatTelegram(ticketText) {
  // Telegram no necesita formato especial — el texto plano ya es legible.
  // Envolvemos los separadores con <code> para fuente monoespaciada.
  const escaped = ticketText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<pre>${escaped}</pre>`;
}

/**
 * Discord: Markdown. Usamos bloque de código para la comanda.
 */
function formatDiscord(ticketText) {
  return {
    content: "🍕 **NUEVA COMANDA**",
    embeds: [{
      description: "```\n" + ticketText + "\n```",
      color: 0xFF6B35  // naranja pizzería
    }]
  };
}

// ─── HELPERS HTTP ─────────────────────────────────────────────────────────────

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === "https:" ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        ...headers
      }
    };

    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, status: res.statusCode, body: data });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error("Request timeout (10s)"));
    });

    req.write(bodyStr);
    req.end();
  });
}

// ─── SENDERS POR CANAL ────────────────────────────────────────────────────────

/**
 * Envía por Telegram.
 * Requiere: config.botToken, config.chatId
 */
async function sendTelegram(config, ticketText) {
  if (!config.botToken || !config.chatId) {
    throw new Error("Telegram: botToken o chatId no configurados (variables de entorno).");
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const body = {
    chat_id:    config.chatId,
    text:       formatTelegram(ticketText),
    parse_mode: config.parseMode || "HTML"
  };

  const result = await httpPost(url, body);
  return { channel: "telegram", raw: result };
}

/**
 * Envía por Discord Webhook.
 * Requiere: config.webhookUrl
 */
async function sendDiscord(config, ticketText) {
  if (!config.webhookUrl) {
    throw new Error("Discord: webhookUrl no configurado (variables de entorno).");
  }

  const body = formatDiscord(ticketText);
  const result = await httpPost(config.webhookUrl, body);
  return { channel: "discord", raw: result };
}

/**
 * Fallback: guarda el ticket en un fichero JSON local.
 * Siempre funciona (salvo disco lleno).
 */
async function sendFileFallback(config, order, ticketText, validationResult) {
  const dir = config.dir || "./orders_fallback";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = `${order.orderId}_${Date.now()}.json`;
  const filePath = path.join(dir, filename);

  const payload = {
    savedAt: new Date().toISOString(),
    orderId: order.orderId,
    ticket:  ticketText,
    order,
    validation: validationResult
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return { channel: "file_fallback", filePath };
}

// ─── DISPATCHER PRINCIPAL ─────────────────────────────────────────────────────

/**
 * Envía el pedido confirmado a cocina.
 * Intenta los canales del proveedor en orden de prioridad.
 *
 * @param {Object} order              — sesión del pedido (status: customer_confirmed)
 * @param {Object} validationResult   — resultado de validateOrder()
 * @param {string} providerSlug       — slug del proveedor (default: "la-locanda")
 * @returns {Object} DispatchResult
 *   { ok, channel, attempts, order, error? }
 */
async function dispatchOrder(order, validationResult = {}, providerSlug = "la-locanda") {
  const channels  = getActiveChannels(providerSlug);
  const ticketText = buildTextTicket(order, validationResult);
  const attempts  = [];
  const callId    = order.callId;

  for (const channel of channels) {
    const attempt = {
      channel: channel.type,
      startedAt: new Date().toISOString(),
      ok: false,
      error: null
    };

    try {
      let result;

      switch (channel.type) {
        case "telegram":
          result = await sendTelegram(channel.config, ticketText);
          break;
        case "discord":
          result = await sendDiscord(channel.config, ticketText);
          break;
        case "file_fallback":
          result = await sendFileFallback(channel.config, order, ticketText, validationResult);
          break;
        default:
          throw new Error(`Canal desconocido: ${channel.type}`);
      }

      attempt.ok        = true;
      attempt.finishedAt = new Date().toISOString();
      attempts.push(attempt);

      // ── ÉXITO → actualizar pedido ────────────────────────────────────────
      const updatedOrder = updateOrderSession(callId, {
        status:          ORDER_STATUS.SENT_TO_KITCHEN,
        dispatchChannel: channel.type,
        dispatchAt:      new Date().toISOString()
      });

      // Registrar en el ledger del pedido
      (updatedOrder.events || []).push({
        eventType:  "dispatch_success",
        timestamp:  new Date().toISOString(),
        status:     ORDER_STATUS.SENT_TO_KITCHEN,
        detail:     `Canal: ${channel.type}. Intentos: ${attempts.length}`
      });

      return {
        ok:        true,
        // delivered = entró en un canal REAL de cocina (no el respaldo en fichero).
        // file_fallback escribe un JSON local (efímero en la nube) que cocina NO ve,
        // así que NO debe contar como pedido entregado de cara al cliente.
        delivered: channel.type !== "file_fallback",
        channel:   channel.type,
        attempts,
        order:     updatedOrder,
        result
      };

    } catch (err) {
      attempt.ok        = false;
      attempt.error     = err.message;
      attempt.finishedAt = new Date().toISOString();
      attempts.push(attempt);
      // Continuar con el siguiente canal
    }
  }

  // ── TODOS LOS CANALES FALLARON ────────────────────────────────────────────
  const failedOrder = updateOrderSession(callId, {
    status: ORDER_STATUS.FAILED_DISPATCH
  });

  (failedOrder.events || []).push({
    eventType: "dispatch_failed",
    timestamp: new Date().toISOString(),
    status:    ORDER_STATUS.FAILED_DISPATCH,
    detail:    `Intentos fallidos: ${attempts.map(a => `${a.channel}(${a.error})`).join(", ")}`
  });

  return {
    ok:        false,
    delivered: false,
    channel:   null,
    attempts,
    order:     failedOrder,
    error:     "Todos los canales de dispatch fallaron."
  };
}

// ─── MOCK PARA TESTS ──────────────────────────────────────────────────────────

/**
 * Versión mock del dispatcher para tests — no hace llamadas HTTP reales.
 * Simula éxito/fallo controlado.
 *
 * @param {Object}  order
 * @param {Object}  validationResult
 * @param {Object}  mockConfig  { failChannels: ["telegram"], succeed: true }
 */
async function dispatchOrderMock(order, validationResult = {}, mockConfig = {}) {
  const { failChannels = [], succeed = true, providerSlug = "la-locanda" } = mockConfig;
  const channels  = getActiveChannels(providerSlug);
  const ticketText = buildTextTicket(order, validationResult);
  const attempts  = [];
  const callId    = order.callId;

  for (const channel of channels) {
    const attempt = {
      channel:   channel.type,
      startedAt: new Date().toISOString(),
      ok:        false,
      error:     null
    };

    const shouldFail = failChannels.includes(channel.type) || !succeed;

    if (shouldFail) {
      attempt.error     = `[MOCK] Canal ${channel.type} simulado como fallido.`;
      attempt.finishedAt = new Date().toISOString();
      attempts.push(attempt);
      continue;
    }

    // Éxito simulado — file_fallback escribe fichero real, el resto solo simula
    if (channel.type === "file_fallback") {
      await sendFileFallback(channel.config, order, ticketText, validationResult);
    }

    attempt.ok        = true;
    attempt.finishedAt = new Date().toISOString();
    attempts.push(attempt);

    const updatedOrder = updateOrderSession(callId, {
      status:          ORDER_STATUS.SENT_TO_KITCHEN,
      dispatchChannel: channel.type,
      dispatchAt:      new Date().toISOString()
    });

    // Registrar en el ledger (mismo patrón que dispatchOrder real)
    updatedOrder.events.push({
      eventType:  "dispatch_success",
      timestamp:  new Date().toISOString(),
      status:     ORDER_STATUS.SENT_TO_KITCHEN,
      detail:     `Canal: ${channel.type}. Intentos: ${attempts.length}`
    });

    return {
      ok:        true,
      delivered: channel.type !== "file_fallback",
      channel:   channel.type,
      mock:      true,
      attempts,
      order:     updatedOrder
    };
  }

  // Todos fallaron (mock)
  const failedOrder = updateOrderSession(callId, { status: ORDER_STATUS.FAILED_DISPATCH });
  return {
    ok:        false,
    delivered: false,
    channel:   null,
    mock:      true,
    attempts,
    order:     failedOrder,
    error:     "[MOCK] Todos los canales fallaron."
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  dispatchOrder,
  dispatchOrderMock,
  sendTelegram,
  sendDiscord,
  sendFileFallback
};
