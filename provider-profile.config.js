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

  // ── ZONA DE REPARTO (validación por radio en km) ──────────────────────────
  // Se geocodifica la dirección del cliente y se mide la distancia al local.
  // FAIL-OPEN: si el geocoder no está configurado o falla, NO se bloquea el
  // pedido — se marca deliveryRisk para que el personal lo revise. Bloquear
  // ventas por un fallo técnico es peor que el problema que resuelve.
  delivery: {
    enabled:   true,
    radiusKm:  8,                       // radio máximo de reparto desde el local
    // ORIGEN DEL RADIO: basta con la DIRECCIÓN. Se geocodifica una sola vez al
    // arrancar y se cachea en memoria. Para dar de alta otro local, pega su
    // dirección aquí — no hace falta buscar coordenadas.
    // `lat`/`lng` son OPCIONALES: si los pones, mandan sobre la dirección
    // (útil si el geocoder falla o quieres precisión exacta).
    origin: {
      address: "Avenida Marqués del Duero, 23, 29688 Cancelada, Estepona, Málaga",
      label:   "La Locanda de Cancelada",
      lat: null,                        // override manual opcional
      lng: null,
      // Respaldo si la geocodificación falla: centro de Cancelada (aproximado).
      // Con un radio de 8 km, un error de 200-300 m es irrelevante.
      fallbackLat: 36.4636,
      fallbackLng: -5.0119
    },
    // Proveedor de geocodificación: "nominatim" (gratuito, sin key, uso justo)
    // | "google" (requiere GOOGLE_MAPS_API_KEY) | null (desactiva la validación).
    geocoder:  process.env.GEOCODER_PROVIDER || "nominatim",
    countryHint: "es",
    failOpen:  true,                    // ante fallo técnico, dejar pasar y marcar
    timeoutMs: 4000
  },

  // ── FORMAS DE PAGO ────────────────────────────────────────────────────────
  // Solo efectivo. Al ser una única opción, Sarah NO pregunta: informa.
  payment: {
    methods: ["cash"],                  // "cash" | "card" | "online"
    askCustomer: false,                 // true solo si hay más de una opción real
    spokenNote: "El pago es en efectivo"
  },

  // ── PROMOCIONES (motor preparado, sin reglas activas) ─────────────────────
  // Añadir reglas aquí NO requiere tocar código. Formato de cada regla:
  // {
  //   id: "2x1_margherita",
  //   label: "2x1 en Margherita",              // lo que Sarah puede decir
  //   active: true,
  //   type: "percent" | "amount" | "free_item",
  //   value: 50,                                // % o € según type
  //   appliesTo: { itemIds: ["pizza_margherita"], minQuantity: 2 },
  //   conditions: { orderType: "delivery"|"pickup"|null, minTotal: 0,
  //                 weekdays: [1,2,3,4,5], fromHHMM: "19:00", toHHMM: "23:00" }
  // }
  promotions: [],

  // ── ESCALADO A PERSONAL (incidencias que Sarah no resuelve) ───────────────
  staffEscalation: {
    enabled: true,
    channel: "telegram",                // reutiliza el canal de cocina
    note: "Incidencia derivada por Sarah — requiere atención del personal."
  },

  // ── Horario de COCINA (para pedidos) ─────────────────────────────────────
  // Cada día: lista de turnos [{ open:"HH:MM", close:"HH:MM" }]. Usa "24:00"
  // para medianoche. [] = cerrado ese día. EDITAR AQUÍ las horas reales del local.
  timezone: "Europe/Madrid",
  openHours: {
    monday:    [{ open: "12:00", close: "16:00" }, { open: "19:00", close: "24:00" }],
    tuesday:   [{ open: "12:00", close: "16:00" }, { open: "19:00", close: "24:00" }],
    wednesday: [{ open: "12:00", close: "16:00" }, { open: "19:00", close: "24:00" }],
    thursday:  [{ open: "12:00", close: "16:00" }, { open: "19:00", close: "24:00" }],
    friday:    [{ open: "12:00", close: "16:00" }, { open: "19:00", close: "24:00" }],
    saturday:  [{ open: "12:00", close: "16:00" }, { open: "19:00", close: "24:00" }],
    sunday:    [{ open: "12:00", close: "16:00" }, { open: "19:00", close: "24:00" }]
  }
};

// ─── ESTADO DE COCINA (abierta/cerrada según horario) ─────────────────────────

const _DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function hhmmToMin(s) {
  const m = String(s).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
function minToHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}

/**
 * Devuelve el estado de la cocina en la zona horaria del proveedor.
 * @returns { openNow, nowHHMM, weekday, todayWindows:[{open,close}], nextOpen:{hhmm,dayLabel,isToday}|null }
 */
function getKitchenStatus(slug = "la-locanda", date = new Date()) {
  const prov = getProvider(slug);
  const tz = prov.timezone || "Europe/Madrid";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  const wdShort = (get("weekday") || "").toLowerCase();
  const wdIndex = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[wdShort];
  let hh = parseInt(get("hour"), 10); if (hh === 24) hh = 0;
  const nowMin = hh * 60 + parseInt(get("minute"), 10);
  const oh = prov.openHours || {};

  const windowsFor = i => (oh[_DAYS[((i % 7) + 7) % 7]] || []).map(w => ({ open: hhmmToMin(w.open), close: hhmmToMin(w.close) }));
  const today = windowsFor(wdIndex);

  const openNow = today.some(w => w.open != null && w.close != null && nowMin >= w.open && nowMin < w.close);

  // Próxima apertura (hoy si queda algún turno; si no, busca en los próximos 7 días)
  let nextOpen = null;
  const todayNext = today.filter(w => w.open != null && w.open > nowMin).sort((a, b) => a.open - b.open)[0];
  if (!openNow && todayNext) {
    nextOpen = { hhmm: minToHHMM(todayNext.open), dayLabel: "hoy", isToday: true };
  } else if (!openNow) {
    for (let d = 1; d <= 7; d++) {
      const w = windowsFor(wdIndex + d).filter(x => x.open != null).sort((a, b) => a.open - b.open)[0];
      if (w) {
        const labels = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
        nextOpen = { hhmm: minToHHMM(w.open), dayLabel: (d === 1 ? "mañana" : labels[((wdIndex + d) % 7 + 7) % 7]), isToday: false };
        break;
      }
    }
  }

  return {
    openNow,
    nowHHMM: minToHHMM(nowMin),
    weekday: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"][wdIndex],
    todayWindows: today.map(w => ({ open: minToHHMM(w.open), close: minToHHMM(w.close) })),
    nextOpen
  };
}

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

module.exports = { getProvider, getActiveChannels, getKitchenStatus, PROVIDERS, LA_LOCANDA };
