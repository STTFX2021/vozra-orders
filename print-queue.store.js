"use strict";

/**
 * VOZRA ORDERS — Print Queue Store
 * Cola de comandas pendientes de imprimir. El agente local (print-agent) las
 * consulta vía GET /print/pending e imprime en la térmica de cocina (ESC/POS),
 * luego confirma con POST /print/ack.
 *
 * Persistencia simple a fichero para sobrevivir reinicios. En memoria + flush.
 */

const fs   = require("fs");
const path = require("path");

const FILE = process.env.PRINT_QUEUE_FILE || path.join(__dirname, "data", "print-queue.json");
const MAX  = 500; // tope de entradas guardadas (evita crecer sin fin)

let _queue = null;

function load() {
  if (_queue) return _queue;
  try {
    _queue = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!Array.isArray(_queue)) _queue = [];
  } catch (_) { _queue = []; }
  return _queue;
}

function flush() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(_queue.slice(-MAX), null, 2), "utf8");
  } catch (e) { console.error("[print-queue] flush error:", e.message); }
}

/** Encola una comanda para imprimir. Idempotente por orderId. */
function enqueuePrint(orderId, ticketText, meta) {
  const q = load();
  if (q.some(e => e.orderId === orderId)) return q.find(e => e.orderId === orderId);
  const entry = {
    orderId,
    ticket: String(ticketText || ""),
    meta: meta || {},
    createdAt: new Date().toISOString(),
    printed: false,
    printedAt: null,
    attempts: 0
  };
  q.push(entry);
  flush();
  return entry;
}

/** Lista comandas no impresas (las que el agente debe imprimir). */
function listPending(limit = 20) {
  return load().filter(e => !e.printed).slice(0, limit);
}

/** Marca una comanda como impresa. */
function markPrinted(orderId) {
  const q = load();
  const e = q.find(x => x.orderId === orderId);
  if (!e) return { ok: false, error: "orderId no encontrado" };
  e.printed = true;
  e.printedAt = new Date().toISOString();
  flush();
  return { ok: true, entry: e };
}

module.exports = { enqueuePrint, listPending, markPrinted };
