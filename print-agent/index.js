"use strict";

/**
 * VOZRA PRINT AGENT
 * Corre en un aparato dentro de la pizzería (tablet, mini-PC, Raspberry).
 * Pregunta al backend por comandas nuevas y las imprime en la térmica de cocina.
 *
 *   node index.js          → bucle continuo
 *   node index.js --once   → una sola pasada (para probar)
 */

const fs    = require("fs");
const path  = require("path");
const http  = require("http");
const https = require("https");
const { printTicket } = require("./printer.js");

// Mini-cargador de .env (sin dependencias externas).
(function loadEnv() {
  try {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith("#")) continue;
      const i = l.indexOf("=");
      if (i < 0) continue;
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim();
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (_) {}
})();

const CFG = {
  base:    (process.env.RAILWAY_URL || "").replace(/\/+$/, ""),
  secret:  process.env.AGENT_SECRET || "",
  ip:      process.env.PRINTER_IP || "",
  port:    process.env.PRINTER_PORT || "9100",
  width:   process.env.PRINTER_WIDTH || "48",
  pollMs:  parseInt(process.env.POLL_MS, 10) || 4000,
  simulate: process.env.SIMULATE || "0"
};

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(CFG.base + path);
    const lib = url.protocol === "https:" ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request(url, {
      method,
      headers: Object.assign(
        { "Authorization": "Bearer " + CFG.secret },
        payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
      )
    }, (res) => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }); }
        catch (_) { resolve({ status: res.statusCode, json: null }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("timeout backend")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function tick() {
  const r = await api("GET", "/print/pending?limit=10");
  if (r.status !== 200 || !r.json || !r.json.orders) {
    console.error(`[agent] backend respondió ${r.status}`);
    return 0;
  }
  const orders = r.json.orders;
  for (const o of orders) {
    try {
      await printTicket(o, CFG);
      await api("POST", "/print/ack", { orderId: o.orderId });
      console.log(`[agent] impreso y confirmado: ${o.orderId}`);
    } catch (e) {
      console.error(`[agent] error imprimiendo ${o.orderId}: ${e.message} (reintento en la siguiente vuelta)`);
    }
  }
  return orders.length;
}

(async () => {
  if (!CFG.base)   { console.error("Falta RAILWAY_URL en .env"); process.exit(1); }
  console.log(`🖨️  Vozra Print Agent | backend=${CFG.base} | impresora=${CFG.simulate === "1" ? "SIMULADOR" : CFG.ip + ":" + CFG.port}`);
  const once = process.argv.includes("--once");
  if (once) { const n = await tick(); console.log(`[agent] pasada única: ${n} comanda(s).`); return; }
  for (;;) {
    try { await tick(); } catch (e) { console.error("[agent] tick error:", e.message); }
    await new Promise(r => setTimeout(r, CFG.pollMs));
  }
})();
