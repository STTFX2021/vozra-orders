"use strict";

/**
 * VOZRA ORDERS — Print Agent API
 * Endpoints que consume el agente local de impresión (print-agent).
 *
 *   GET  /print/pending      ← devuelve comandas no impresas
 *   POST /print/ack          ← marca una comanda como impresa  { orderId }
 *
 * Auth: Bearer = PRINT_AGENT_SECRET (o ELEVENLABS_CUSTOM_LLM_SECRET si no hay).
 */

const express = require("express");
const { listPending, markPrinted } = require("./print-queue.store.js");

const router = express.Router();

function isAuthorized(req) {
  const token = process.env.PRINT_AGENT_SECRET || process.env.ELEVENLABS_CUSTOM_LLM_SECRET;
  if (!token) return true; // sin secret configurado → abierto (solo dev)
  return (req.headers.authorization || "") === `Bearer ${token}`;
}

router.get("/print/pending", (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  return res.json({ ok: true, orders: listPending(limit) });
});

router.post("/print/ack", (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: "orderId requerido" });
  const r = markPrinted(orderId);
  if (!r.ok) return res.status(404).json({ error: r.error });
  return res.json({ ok: true, orderId, printedAt: r.entry.printedAt });
});

module.exports = router;
