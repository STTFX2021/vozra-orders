"use strict";

/**
 * VOZRA ORDERS — Validación de zona de reparto (radio en km)
 *
 * Geocodifica la dirección dictada por el cliente y mide la distancia en línea
 * recta al local. Si supera `delivery.radiusKm`, el pedido queda FUERA de zona.
 *
 * DECISIÓN DE DISEÑO — FAIL-OPEN:
 *   Las direcciones llegan por voz y el transcriptor las deforma
 *   ("Alpandeire" → "Al Pandeire"). Un geocoder puede fallar, tardar o no
 *   encontrar la calle. En ese caso NO bloqueamos el pedido: devolvemos
 *   status "unknown" y marcamos deliveryRisk para que el personal lo revise.
 *   Perder una venta por un fallo técnico es peor que el problema que resuelve.
 *   Solo se rechaza cuando la geocodificación es FIABLE y la distancia supera
 *   el radio.
 *
 * Proveedores soportados:
 *   - "nominatim" (OpenStreetMap): gratuito, sin API key. Política de uso justo:
 *     1 req/s y User-Agent identificable. Suficiente para volumen de un local.
 *   - "google": requiere GOOGLE_MAPS_API_KEY. Más preciso y tolerante a erratas.
 *   - null: desactiva la validación (todo pasa como "unknown").
 *
 * Variables de entorno:
 *   GEOCODER_PROVIDER    = "nominatim" | "google" | "off"
 *   GOOGLE_MAPS_API_KEY  = (solo si provider = google)
 *
 * Caché en memoria por dirección normalizada (TTL 24h) para no repetir
 * llamadas ni penalizar latencia en la conversación.
 */

const https = require("https");
const { getProvider } = require("./provider-profile.config.js");

// ─── CACHÉ ────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _geoCache = new Map(); // key -> { at, value }

function cacheGet(key) {
  const hit = _geoCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { _geoCache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  _geoCache.set(key, { at: Date.now(), value });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function normAddress(raw) {
  return String(raw || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distancia en km entre dos coordenadas (fórmula de Haversine). */
function haversineKm(a, b) {
  const R = 6371; // radio terrestre en km
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function httpGetJson(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: Object.assign({ "Accept": "application/json" }, headers || {})
      },
      (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data || "null")); }
            catch (e) { reject(new Error("geocoder parse error: " + e.message)); }
          } else {
            reject(new Error("geocoder HTTP " + res.statusCode));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs || 4000, () => req.destroy(new Error("geocoder timeout")));
    req.end();
  });
}

// ─── GEOCODERS ────────────────────────────────────────────────────────────────

/**
 * Nominatim (OpenStreetMap). Sin API key.
 * Devuelve { lat, lng, confidence, label } o null si no encuentra.
 */
async function geocodeNominatim(address, cfg) {
  const q = encodeURIComponent(address);
  const cc = cfg.countryHint ? "&countrycodes=" + encodeURIComponent(cfg.countryHint) : "";
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${q}${cc}`;
  const json = await httpGetJson(url, { "User-Agent": "VozraOrders/1.0 (pedidos restaurante)" }, cfg.timeoutMs);
  const hit = Array.isArray(json) ? json[0] : null;
  if (!hit || hit.lat == null || hit.lon == null) return null;
  // Nominatim expone "importance" (0..1). Lo usamos como proxy de confianza.
  const importance = typeof hit.importance === "number" ? hit.importance : 0.5;
  return {
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
    confidence: importance,
    label: hit.display_name || null
  };
}

/**
 * Google Geocoding API. Requiere GOOGLE_MAPS_API_KEY.
 */
async function geocodeGoogle(address, cfg) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error("GOOGLE_MAPS_API_KEY no configurada");
  const q = encodeURIComponent(address);
  const region = cfg.countryHint ? "&region=" + encodeURIComponent(cfg.countryHint) : "";
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}${region}&key=${key}`;
  const json = await httpGetJson(url, null, cfg.timeoutMs);
  if (!json || json.status !== "OK" || !Array.isArray(json.results) || !json.results.length) return null;
  const hit = json.results[0];
  const loc = hit.geometry && hit.geometry.location;
  if (!loc) return null;
  // location_type ROOFTOP/RANGE_INTERPOLATED = preciso; APPROXIMATE = dudoso.
  const lt = (hit.geometry && hit.geometry.location_type) || "APPROXIMATE";
  const confidence = lt === "ROOFTOP" ? 0.95 : lt === "RANGE_INTERPOLATED" ? 0.8 : 0.5;
  return { lat: loc.lat, lng: loc.lng, confidence, label: hit.formatted_address || null };
}

/** Enruta al geocoder configurado. Devuelve null si no hay resultado. */
async function geocode(address, cfg) {
  const provider = String(cfg.geocoder || "").toLowerCase();
  if (!provider || provider === "off" || provider === "null") return null;
  if (provider === "google") return await geocodeGoogle(address, cfg);
  return await geocodeNominatim(address, cfg);
}

// ─── API PÚBLICA ──────────────────────────────────────────────────────────────

/**
 * Valida si una dirección entra en la zona de reparto.
 *
 * @param {string} address    dirección completa dictada por el cliente
 * @param {string} providerSlug
 * @returns {Promise<{
 *   status: "in_zone"|"out_of_zone"|"unknown",
 *   distanceKm: number|null,
 *   radiusKm: number,
 *   deliveryRisk: boolean,
 *   reason: string,
 *   geocoded: {lat,lng,label,confidence}|null
 * }>}
 *
 * NUNCA lanza: ante cualquier error devuelve status "unknown" con deliveryRisk.
 */
async function checkDeliveryAddress(address, providerSlug = "la-locanda") {
  let cfg;
  try {
    cfg = (getProvider(providerSlug).delivery) || {};
  } catch (_) {
    cfg = {};
  }
  const radiusKm = cfg.radiusKm != null ? cfg.radiusKm : 8;

  const base = { radiusKm, distanceKm: null, geocoded: null };

  if (cfg.enabled === false) {
    return Object.assign({}, base, { status: "unknown", deliveryRisk: false, reason: "validacion_desactivada" });
  }
  const addr = String(address || "").trim();
  if (addr.length < 6) {
    return Object.assign({}, base, { status: "unknown", deliveryRisk: true, reason: "direccion_insuficiente" });
  }
  if (!cfg.origin || cfg.origin.lat == null || cfg.origin.lng == null) {
    return Object.assign({}, base, { status: "unknown", deliveryRisk: true, reason: "origen_no_configurado" });
  }

  const key = normAddress(addr);
  const cached = cacheGet(key);
  if (cached) return cached;

  let geo = null;
  try {
    geo = await geocode(addr, cfg);
  } catch (e) {
    console.error("[ZONA] geocoder error | " + e.message);
    const out = Object.assign({}, base, { status: "unknown", deliveryRisk: true, reason: "geocoder_error" });
    return out; // no cacheamos errores transitorios
  }

  if (!geo) {
    const out = Object.assign({}, base, { status: "unknown", deliveryRisk: true, reason: "direccion_no_encontrada" });
    cacheSet(key, out);
    return out;
  }

  const distanceKm = haversineKm(cfg.origin, geo);
  const rounded = Math.round(distanceKm * 10) / 10;

  // Confianza baja → no rechazamos por algo que quizá geocodificó mal.
  const LOW_CONFIDENCE = 0.35;
  if (geo.confidence != null && geo.confidence < LOW_CONFIDENCE && distanceKm > radiusKm) {
    const out = Object.assign({}, base, {
      status: "unknown", distanceKm: rounded, deliveryRisk: true,
      reason: "geocodificacion_poco_fiable", geocoded: geo
    });
    cacheSet(key, out);
    return out;
  }

  const inZone = distanceKm <= radiusKm;
  const out = Object.assign({}, base, {
    status: inZone ? "in_zone" : "out_of_zone",
    distanceKm: rounded,
    deliveryRisk: !inZone,
    reason: inZone ? "dentro_del_radio" : "fuera_del_radio",
    geocoded: geo
  });
  cacheSet(key, out);
  return out;
}

/** Limpia la caché (tests). */
function clearGeoCache() { _geoCache.clear(); }

module.exports = { checkDeliveryAddress, haversineKm, clearGeoCache, normAddress };
