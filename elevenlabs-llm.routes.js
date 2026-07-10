"use strict";

/**
 * VOZRA ORDERS — ElevenLabs Custom LLM Endpoint
 * Fase 7: Conecta ElevenLabs Conversational AI con el brain de Marta.
 *
 * ElevenLabs envía POST /v1/chat/completions (OpenAI-compatible)
 * Nosotros devolvemos SSE con la respuesta de processTurn.
 *
 * Docs: https://elevenlabs.io/docs/eleven-agents/customization/llm/custom-llm
 *
 * Diferencias clave ElevenLabs vs Vapi:
 *  - ElevenLabs siempre envía stream: true
 *  - El callId viene en el header X-ElevenLabs-Conversation-Id
 *    (o como último mensaje del sistema con metadata)
 *  - ElevenLabs espera que cada chunk SSE tenga delta.content
 *  - Soporta tools (webhook calls) para acciones como dispatch
 */

const express  = require("express");
const { processTurn, buildKitchenTicket } = require("./order-slot-filler.service.js");
const { generateMartaReply } = require("./marta-llm.service.js");
const { getOrCreateOrderSession, ORDER_STATUS } = require("./order-call-session.store.js");
const { validateOrder }   = require("./order-validator.service.js");
const { buildTicket }     = require("./kitchen-ticket-builder.service.js");
const { dispatchOrder }   = require("./dispatch-adapter.service.js");
const { startKitchenWatch } = require("./kitchen-ack-monitor.service.js");

const router = express.Router();

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function isAuthorized(req) {
  const token = process.env.ELEVENLABS_CUSTOM_LLM_SECRET;
  if (!token) return true; // sin secret configurado → abierto (solo para dev)
  const header = req.headers.authorization || "";
  return header === `Bearer ${token}`;
}

// ─── SSE HELPERS ─────────────────────────────────────────────────────────────

/**
 * Inicia la respuesta SSE con los headers correctos para ElevenLabs.
 */
function startSSE(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // Desactiva buffering en nginx
  res.flushHeaders?.();
}

/**
 * Escribe un chunk SSE en el formato OpenAI streaming que ElevenLabs espera.
 */
function writeChunk(res, id, model, delta, finishReason = null) {
  const chunk = {
    id,
    object:  "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index:        0,
      delta,
      finish_reason: finishReason
    }]
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

/**
 * Envía la respuesta completa en formato SSE.
 * ElevenLabs requiere:
 *  1. Chunk con delta: { role: "assistant" }
 *  2. Uno o más chunks con delta: { content: "..." }
 *  3. Chunk final con finish_reason: "stop"
 *  4. data: [DONE]
 */
function sendStreamResponse(res, content, id, model = "vozra-marta-orders") {
  startSSE(res);
  writeChunk(res, id, model, { role: "assistant" });
  writeChunk(res, id, model, { content: String(content || "").trim() });
  writeChunk(res, id, model, {}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

// ─── CALL ID EXTRACTOR ────────────────────────────────────────────────────────

/**
 * ElevenLabs envía el conversation ID de varias formas.
 * Intentamos en este orden:
 *  1. Header X-ElevenLabs-Conversation-Id
 *  2. Metadata en el último mensaje system
 *  3. Generamos uno basado en timestamp
 */
function extractCallId(req) {
  // 1. Header
  const headerCallId = req.headers["x-elevenlabs-conversation-id"]
    || req.headers["x-conversation-id"];
  if (headerCallId) return headerCallId;

  // 2. Buscar en mensajes de sistema con metadata
  const messages = (req.body || {}).messages || [];
  for (const msg of messages) {
    if (msg.role === "system" && msg.content) {
      const match = String(msg.content).match(/conversation[_-]?id[:\s]+([a-zA-Z0-9_-]+)/i);
      if (match) return match[1];
    }
  }

  // 3. Fallback temporal
  return `el-${Date.now()}`;
}

/**
 * Extrae el último mensaje del usuario de la conversación.
 */
function extractLastUserMessage(messages = []) {
  const userMessages = messages.filter(m => m.role === "user");
  return userMessages.length > 0 ? userMessages[userMessages.length - 1].content || "" : "";
}

// ─── POST-DISPATCH HOOK ───────────────────────────────────────────────────────

/**
 * Tras confirmación del cliente: valida → genera ticket → dispatch → ACK watch.
 * Se ejecuta de forma asíncrona (no bloquea la respuesta a ElevenLabs).
 */
async function handlePostConfirmation(order, callId) {
  try {
    const v = validateOrder(order);
    if (!v.ok) {
      console.error(`[EL] Post-confirmation validation failed for ${callId}:`, v.errors);
      return;
    }

    const r = await dispatchOrder(order, v);
    if (r.delivered) {
      startKitchenWatch(r.order);
      console.log(`[EL] Dispatch OK | ${callId} | canal: ${r.channel}`);
    } else if (r.ok) {
      console.error(`[EL] Dispatch SOLO-FALLBACK | ${callId} | canal: ${r.channel} | cocina NO lo ha recibido`);
    } else {
      console.error(`[EL] Dispatch FAILED | ${callId} | ${r.error}`);
    }
  } catch (err) {
    console.error(`[EL] handlePostConfirmation error | ${callId}:`, err.message);
  }
}

// ─── MAIN ENDPOINT ────────────────────────────────────────────────────────────

/**
 * POST /v1/chat/completions
 *
 * ElevenLabs llama a este endpoint en cada turno de conversación.
 * Nosotros:
 *  1. Extraemos el callId y el último mensaje del usuario
 *  2. Llamamos a processTurn (el brain de Marta)
 *  3. Devolvemos la respuesta en SSE
 *  4. Si el pedido se confirmó → dispatch asíncrono
 */
router.post("/v1/chat/completions", async (req, res) => {
  const id    = `vozra-${Date.now()}`;
  const model = "vozra-marta-orders";

  if (!isAuthorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const body     = req.body || {};
  const callId   = extractCallId(req);
  const userText = extractLastUserMessage(body.messages || []);

  console.log(`[EL] turn | callId=${callId} | user="${userText.slice(0, 60)}"`);

  // ── TURNO 0: Saludo inicial ──────────────────────────────────────────────
  // ElevenLabs puede enviar una primera llamada sin mensaje de usuario
  // (solo mensajes de sistema). En ese caso saludamos sin gastar LLM.
  if (!userText.trim()) {
    return sendStreamResponse(
      res,
      "¡Hola! La Locanda de Cancelada, soy Sarah. ¿Qué te apetece hoy?",
      id, model
    );
  }

  // ── CEREBRO LLM (OpenAI) ─────────────────────────────────────────────────
  // Marta entiende lenguaje natural vía gpt-4o-mini y, al confirmar el cliente,
  // dispara el pedido a cocina dentro de generateMartaReply.
  try {
    // ElevenLabs puede adjuntar su propio system prompt. El cerebro es la única
  // fuente de instrucciones: conservamos el historial conversacional y
  // descartamos cualquier system entrante antes de llamar al modelo.
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const userTurns = incoming.filter(m => m && m.role !== "system");
  const { reply, dispatched, action } = await generateMartaReply(callId, userTurns);
    console.log(`[EL] LLM | action=${action} | dispatched=${dispatched} | reply="${String(reply).slice(0,60)}"`);
    return sendStreamResponse(res, reply, id, model);
  } catch (errLLM) {
    // ── FALLBACK HONESTO (decisión QA #1) ───────────────────────────────────
    // Si el cerebro LLM (OpenAI) falla —p. ej. 429 por saturación o timeout—,
    // NO degradamos al parser de reglas (`processTurn`): ese parser produce
    // respuestas incoherentes y repetitivas ("Perfecto, te pongo una Anto"…)
    // que destrozan la conversación delante del cliente. Es preferible una
    // disculpa clara pidiendo que llamen al local que un pedido mal tomado.
    console.error(`[EL] LLM brain falló → fallback honesto | callId=${callId}:`, errLLM.message);
    const honesto = "Perdona, estoy teniendo un problemilla técnico y no quiero equivocarme con tu pedido. ¿Puedes llamar directamente al restaurante en un momento? Disculpa las molestias.";
    if (!res.headersSent) {
      return sendStreamResponse(res, honesto, id, model);
    }
    return;
  }
});

// ─── WEBHOOK: KITCHEN ACK ─────────────────────────────────────────────────────

/**
 * POST /kitchen/ack
 * Endpoint para que cocina confirme la recepción del pedido.
 * En producción: llamado por el bot de Telegram/Discord cuando cocina reacciona.
 *
 * Body: { orderId: string, ackType: "acknowledged" | "accepted" | "rejected" }
 */
router.post("/kitchen/ack", (req, res) => {
  const { orderId, ackType = "acknowledged" } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "orderId requerido" });

  const { markKitchenAck } = require("./kitchen-ack-monitor.service.js");
  const result = markKitchenAck(orderId, ackType);

  if (!result.ok) {
    return res.status(404).json({ error: result.error });
  }

  return res.json({
    ok: true,
    orderId,
    newStatus: result.newStatus,
    ackedAt: result.entry?.ackedAt
  });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

router.get("/health", (req, res) => {
  const { getMenuMetadata } = require("./menu-taxonomy-resolver.service.js");
  const meta = getMenuMetadata();
  res.json({
    ok:        true,
    service:   "vozra-orders-elevenlabs",
    version:   "1.0.1",
    restaurant: meta.restaurantName,
    timestamp: new Date().toISOString()
  });
});

// ─── DEBUG: prueba de Telegram ────────────────────────────────────────────────
// GET /debug/telegram  (protegido con el mismo Bearer)
// Intenta enviar un mensaje real al grupo de cocina y devuelve el error exacto
// de la API de Telegram. NO expone el token (solo el bot id público).
router.get("/debug/telegram", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { getActiveChannels } = require("./provider-profile.config.js");
  const { sendTelegram }      = require("./dispatch-adapter.service.js");

  const tg  = getActiveChannels("la-locanda").find(c => c.type === "telegram");
  const cfg = (tg && tg.config) || {};
  const token = cfg.botToken || "";
  const info = {
    hasBotToken:    !!token,
    botId:          token ? String(token).split(":")[0] : null,   // id público del bot
    hasChatId:      !!cfg.chatId,
    chatId:         cfg.chatId || null,                            // los chat id de grupo no son secretos
    chatIdNegative: cfg.chatId ? String(cfg.chatId).trim().startsWith("-") : null,
    usedVar: {
      botTokenLaLocanda: !!process.env.TELEGRAM_BOT_TOKEN_LA_LOCANDA,
      botTokenGeneric:   !!process.env.TELEGRAM_BOT_TOKEN,
      chatIdLaLocanda:   !!process.env.TELEGRAM_CHAT_ID_LA_LOCANDA,
      chatIdGeneric:     !!process.env.TELEGRAM_CHAT_ID
    }
  };

  try {
    const r = await sendTelegram(cfg, "🔧 Vozra → cocina: mensaje de DIAGNÓSTICO. Si lo ves, la conexión funciona.");
    let parsed = null;
    try { parsed = r && r.raw && r.raw.body ? JSON.parse(r.raw.body) : null; } catch (_) {}
    return res.json({ ok: true, info, telegram: parsed || r });
  } catch (e) {
    return res.json({ ok: false, info, error: e.message });
  }
});

module.exports = router;
