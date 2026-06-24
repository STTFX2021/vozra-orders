"use strict";

/**
 * VOZRA ORDERS — WhatsApp Multimodal Entry (Twilio)
 *
 * Recibe webhooks de Twilio WhatsApp y los convierte en texto
 * para processTurn (el mismo brain que usa ElevenLabs).
 *
 * Tipos de mensaje soportados:
 *   1. Texto plano        → directo a processTurn
 *   2. Audio (OPUS/OGG)   → descarga → Whisper STT → texto → processTurn
 *   3. Imagen             → descarga → OpenAI Vision → descripción → merge → processTurn
 *   4. Audio + texto      → Whisper + texto → merge → processTurn
 *   5. Imagen + texto     → Vision + texto → merge → processTurn
 *
 * Responde con TwiML (XML) para que Twilio envíe el mensaje al cliente.
 *
 * Configurar en Twilio Console:
 *   WhatsApp Sandbox → "When a message comes in" → POST https://tu-url/whatsapp/incoming
 */

const express  = require("express");
const https    = require("https");
const http     = require("http");
const fs       = require("fs");
const path     = require("path");
const FormData = require("form-data");

const { processTurn }       = require("./order-slot-filler.service.js");
const { validateOrder }     = require("./order-validator.service.js");
const { dispatchOrder }     = require("./dispatch-adapter.service.js");
const { startKitchenWatch } = require("./kitchen-ack-monitor.service.js");

const router = express.Router();

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Descarga un archivo desde una URL autenticada con Twilio credentials.
 * Devuelve un Buffer con el contenido.
 */
function downloadMedia(mediaUrl) {
  return new Promise((resolve, reject) => {
    const sid   = process.env.TWILIO_ACCOUNT_SID  || "";
    const token = process.env.TWILIO_AUTH_TOKEN    || "";
    const auth  = Buffer.from(`${sid}:${token}`).toString("base64");

    const parsed = new URL(mediaUrl);
    const lib    = parsed.protocol === "https:" ? https : http;

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      headers:  { Authorization: `Basic ${auth}` }
    };

    const req = lib.get(options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Seguir redirect
        return downloadMedia(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Media download failed: ${res.statusCode} ${mediaUrl}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end",  ()  => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Media download timeout"));
    });
  });
}

/**
 * Transcribe audio con OpenAI Whisper.
 * Soporta OPUS, OGG, MP4, MP3, WAV, WebM (lo que envía WhatsApp).
 * Devuelve el texto transcrito.
 */
async function transcribeWithWhisper(audioBuffer, mimeType = "audio/ogg") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada");

  // Determinar extensión a partir del mime type
  const extMap = {
    "audio/ogg":      "ogg",
    "audio/mpeg":     "mp3",
    "audio/mp4":      "mp4",
    "audio/wav":      "wav",
    "audio/webm":     "webm",
    "audio/opus":     "opus",
    "audio/amr":      "amr",  // algunos dispositivos Android
  };
  const ext      = extMap[mimeType] || "ogg";
  const filename = `audio_wa.${ext}`;

  // Crear form-data con el archivo de audio
  const form = new FormData();
  form.append("file", audioBuffer, { filename, contentType: mimeType });
  form.append("model", "whisper-1");
  form.append("language", "es");
  form.append("response_format", "text");

  return new Promise((resolve, reject) => {
    const formHeaders = form.getHeaders();
    const body = form.getBuffer();

    const options = {
      hostname: "api.openai.com",
      path:     "/v1/audio/transcriptions",
      method:   "POST",
      headers:  {
        Authorization:  `Bearer ${apiKey}`,
        ...formHeaders,
        "Content-Length": body.length
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end",  () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Whisper error ${res.statusCode}: ${data}`));
        }
        // response_format: "text" devuelve texto plano, no JSON
        resolve(data.trim());
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Describe una imagen con OpenAI Vision (gpt-4o mini).
 * Útil cuando el cliente manda foto de la carta o de un producto.
 * Devuelve una descripción en español.
 */
async function describeImageWithVision(imageBuffer, mimeType = "image/jpeg") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada");

  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const body = JSON.stringify({
    model: "gpt-4o-mini",
    max_tokens: 200,
    messages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: "Eres el asistente de un restaurante. Describe brevemente en español qué muestra esta imagen, especialmente si hay comida, platos, o texto de una carta visible. Sé conciso (máximo 2 frases)."
        },
        {
          type:      "image_url",
          image_url: { url: dataUrl, detail: "low" }
        }
      ]
    }]
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.openai.com",
      path:     "/v1/chat/completions",
      method:   "POST",
      headers:  {
        Authorization:  `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end",  () => {
        try {
          const json = JSON.parse(data);
          const text = json?.choices?.[0]?.message?.content || "";
          resolve(text.trim());
        } catch {
          reject(new Error(`Vision parse error: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/**
 * Construye la respuesta TwiML para enviar un mensaje WhatsApp al cliente.
 */
function twimlResponse(messageText) {
  // Escapar caracteres XML básicos
  const escaped = String(messageText)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escaped}</Message>
</Response>`;
}

/**
 * Verifica la firma de Twilio para asegurar que el webhook es legítimo.
 * En producción activar siempre. En dev puede desactivarse con TWILIO_SKIP_SIGNATURE=true.
 */
function verifyTwilioSignature(req) {
  if (process.env.TWILIO_SKIP_SIGNATURE === "true") return true;

  const authToken = process.env.TWILIO_AUTH_TOKEN || "";
  if (!authToken) return true; // sin token → abierto solo para dev

  const crypto    = require("crypto");
  const signature = req.headers["x-twilio-signature"] || "";
  const url       = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  // Twilio firma: HMAC-SHA1 de (url + sorted params)
  const params    = req.body || {};
  const sortedKeys = Object.keys(params).sort();
  const paramStr  = sortedKeys.map(k => `${k}${params[k]}`).join("");
  const expected  = crypto
    .createHmac("sha1", authToken)
    .update(url + paramStr)
    .digest("base64");

  return signature === expected;
}

// ─── WEBHOOK PRINCIPAL ───────────────────────────────────────────────────────

/**
 * POST /whatsapp/incoming
 *
 * Twilio llama a este endpoint cuando llega un mensaje de WhatsApp.
 * Campos relevantes del body:
 *   From          → número del cliente (whatsapp:+34612345678)
 *   Body          → texto del mensaje (puede estar vacío si hay media)
 *   NumMedia      → número de archivos adjuntos (0..10)
 *   MediaUrl0     → URL del primer archivo (si NumMedia > 0)
 *   MediaContentType0 → MIME del primer archivo
 */
router.post("/whatsapp/incoming", express.urlencoded({ extended: false }), async (req, res) => {

  // ── Verificar firma Twilio ────────────────────────────────────────────────
  if (!verifyTwilioSignature(req)) {
    console.warn("[WA] Firma Twilio inválida — rechazando");
    return res.status(403).send("Forbidden");
  }

  const from     = req.body.From     || "";  // "whatsapp:+34612345678"
  const bodyText = (req.body.Body    || "").trim();
  const numMedia = parseInt(req.body.NumMedia || "0", 10);

  // Usar el número de teléfono como callId (sesión de conversación)
  // Limpiamos el prefijo "whatsapp:" para tener solo el número E.164
  const callId   = from.replace("whatsapp:", "").trim() || `wa-${Date.now()}`;

  console.log(`[WA] incoming | from=${callId} | body="${bodyText.slice(0,60)}" | media=${numMedia}`);

  try {
    const textParts = [];

    // ── 1. Texto del mensaje ─────────────────────────────────────────────
    if (bodyText) {
      textParts.push(bodyText);
    }

    // ── 2. Procesar media (audio e imagen) ───────────────────────────────
    for (let i = 0; i < Math.min(numMedia, 3); i++) {
      const mediaUrl  = req.body[`MediaUrl${i}`]         || "";
      const mediaType = req.body[`MediaContentType${i}`] || "";

      if (!mediaUrl) continue;

      try {
        const buffer = await downloadMedia(mediaUrl);

        // ── Audio → Whisper ──────────────────────────────────────────────
        if (mediaType.startsWith("audio/")) {
          console.log(`[WA] Transcribiendo audio (${mediaType}) con Whisper...`);
          const transcript = await transcribeWithWhisper(buffer, mediaType);
          if (transcript) {
            console.log(`[WA] Transcripción: "${transcript.slice(0, 80)}"`);
            textParts.push(transcript);
          }
        }

        // ── Imagen → Vision ──────────────────────────────────────────────
        else if (mediaType.startsWith("image/")) {
          console.log(`[WA] Describiendo imagen (${mediaType}) con Vision...`);
          const description = await describeImageWithVision(buffer, mediaType);
          if (description) {
            console.log(`[WA] Descripción imagen: "${description.slice(0, 80)}"`);
            // La descripción se añade como contexto adicional al texto
            textParts.push(`[Imagen adjunta: ${description}]`);
          }
        }

        // ── Otros tipos → ignorar ────────────────────────────────────────
        else {
          console.log(`[WA] Tipo de media no soportado: ${mediaType} — ignorado`);
        }

      } catch (mediaErr) {
        console.error(`[WA] Error procesando media ${i}:`, mediaErr.message);
        // Continuar con el resto del mensaje aunque falle un adjunto
      }
    }

    // ── 3. Merge de todas las partes en un solo texto ────────────────────
    const mergedText = textParts.join(" ").trim();

    if (!mergedText) {
      // Mensaje vacío (sticker, contacto, ubicación, etc.)
      const reply = twimlResponse("Lo siento, no puedo procesar ese tipo de mensaje. Puedes escribir tu pedido o enviar un audio.");
      return res.type("text/xml").send(reply);
    }

    console.log(`[WA] texto merged para processTurn: "${mergedText.slice(0, 100)}"`);

    // ── 4. Pasar al brain de Marta ────────────────────────────────────────
    const { order, response, action } = processTurn(callId, mergedText);

    console.log(`[WA] action=${action} | status=${order.status} | response="${response.slice(0,60)}"`);

    // ── 5. Post-confirmación asíncrona ────────────────────────────────────
    if (action === "customer_confirmed") {
      setImmediate(async () => {
        try {
          const v = validateOrder(order);
          if (!v.ok) {
            console.error(`[WA] Validación fallida para ${callId}:`, v.errors);
            return;
          }
          const r = await dispatchOrder(order, v);
          if (r.delivered) {
            startKitchenWatch(r.order);
            console.log(`[WA] Dispatch OK | ${callId} | canal: ${r.channel}`);
          } else if (r.ok) {
            console.error(`[WA] Dispatch SOLO-FALLBACK | ${callId} | canal: ${r.channel} | cocina NO lo ha recibido`);
          } else {
            console.error(`[WA] Dispatch FAILED | ${callId} | ${r.error}`);
          }
        } catch (err) {
          console.error(`[WA] handlePostConfirmation error | ${callId}:`, err.message);
        }
      });
    }

    // ── 6. Responder al cliente por WhatsApp (TwiML) ──────────────────────
    return res.type("text/xml").send(twimlResponse(response));

  } catch (err) {
    console.error(`[WA] Error inesperado | from=${callId}:`, err.message);
    const errorReply = twimlResponse("Lo siento, ha habido un problema. Por favor inténtalo de nuevo o llámanos directamente.");
    return res.type("text/xml").send(errorReply);
  }
});

// ─── HEALTH CHECK WHATSAPP ───────────────────────────────────────────────────

router.get("/whatsapp/health", (req, res) => {
  res.json({
    ok:      true,
    channel: "whatsapp-twilio",
    features: {
      text:   true,
      audio:  !!process.env.OPENAI_API_KEY,
      image:  !!process.env.OPENAI_API_KEY,
    }
  });
});

module.exports = router;
