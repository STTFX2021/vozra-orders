"use strict";

/**
 * VOZRA ORDERS — Provider Profile Config
 * Configura los canales de dispatch y parámetros operativos por proveedor.
 *
 * En producción las credenciales llegan vía variables de entorno (.env).
 * Este fichero es el mapa de configuración — nunca hardcodea secrets.
 *
 * Para añadir un nuevo proveedor: añadir una entrada en PROVIDERS con su slug.
 */

require("dotenv").config();

// ─── PERFIL BASE (La Locanda de Cancelada) ────────────────────────────────────

const LA_LOCANDA = {
  id:   "la_locanda_cancelada",
  name: "La Locanda de Cancelada",
  slug: "la-locanda",

  // ── Canales de dispatch (en orden de prioridad) ──────────────────────────
  // El Dispatch Adapter los intenta en orden hasta que uno funcione.
  dispatchChannels: [
    {
      type: "telegram",
      priority: 1,
      enabled: true,
      config: {
        botToken: process.env.TELEGRAM_BOT_TOKEN_LA_LOCANDA || process.env.TELEGRAM_BOT_TOKEN,
        chatId:   process.env.TELEGRAM_CHAT_ID_LA_LOCANDA   || process.env.TELEGRAM_CHAT_ID,
        parseMode: "HTML"          // Telegram soporta HTML para formato
      }
    },
    {
      type: "discord",
      priority: 2,
      enabled: true,  // habilitado siempre; si no hay webhookUrl simplemente falla en dispatch
      config: {
        webhookUrl: process.env.DISCORD_WEBHOOK_URL_LA_LOCANDA || process.env.DISCORD_WEBHOOK_URL
      }
    },
    {
      type: "file_fallback",
      priority: 3,
      enabled: true,              // siempre activo como último recurso
      config: {
        dir: process.env.FALLBACK_ORDERS_DIR || require('path').join(__dirname, '..', 'orders_fallback')
      }
    }
  ],

  // ── ACK Monitor ──────────────────────────────────────────────────────────
  ackTimeout: {
    warningMs:  5 * 60 * 1000,   // 5 min → alerta leve
    criticalMs: 10 * 60 * 1000   // 10 min → alerta crítica
  },

  // ── Reglas de transferencia (vacío = Marta atiende todo) ─────────────────
  // Cada regla: { trigger: string/regex, action: "transfer" | "flag", target? }
  transferRules: [
    // Ejemplo: { trigger: "catering", action: "transfer" }
  ],

  // ── Parámetros operativos ─────────────────────────────────────────────────
  groupOrderThreshold: 7,        // pedidos de grupo ≥ 7 → requiresProviderReview
  acceptsHalfAndHalf:  false,    // mitad y mitad no soportado por defecto
  maxModifiersPerPizza: 3,

  // ── Horario de operación (para Fase 5+) ──────────────────────────────────
  timezone: "Europe/Madrid",
  openHours: {
    // null = sin restricción (acepta siempre)
    // { open: "HH:MM", close: "HH:MM" } = horario estricto
    monday:    null,
    tuesday:   null,
    wednesday: null,
    thursday:  null,
    friday:    null,
    saturday:  null,
    sunday:    null
  }
};

// ─── REGISTRO DE PROVEEDORES ──────────────────────────────────────────────────

const PROVIDERS = {
  [LA_LOCANDA.slug]: LA_LOCANDA
};

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

function getProvider(slug = "la-locanda") {
  const p = PROVIDERS[slug];
  if (!p) throw new Error(`Proveedor '${slug}' no encontrado en provider-profile.config.js`);
  return p;
}

function getActiveChannels(slug = "la-locanda") {
  return getProvider(slug).dispatchChannels
    .filter(c => c.enabled)
    .sort((a, b) => a.priority - b.priority);
}

module.exports = { getProvider, getActiveChannels, PROVIDERS, LA_LOCANDA };
