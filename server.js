"use strict";

/**
 * VOZRA ORDERS — Express Server
 * Fase 7: Expone el endpoint Custom LLM para ElevenLabs.
 *
 * Rutas:
 *   POST /v1/chat/completions   ← ElevenLabs Custom LLM
 *   POST /kitchen/ack           ← Webhook de ACK de cocina
 *   GET  /health                ← Health check
 */

require("dotenv").config();
const express = require("express");
const app     = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── LOGGING ──────────────────────────────────────────────────────────────────

app.use((req, res, next) => {
  if (req.path !== "/health") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// ─── RUTAS ────────────────────────────────────────────────────────────────────

const elevenLabsRoutes = require("./elevenlabs-llm.routes.js");
app.use("/", elevenLabsRoutes);

// ─── 404 ──────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err.message);
  res.status(500).json({ error: "internal_server_error" });
});

// ─── ARRANQUE ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🍕 Vozra Orders server arrancado en puerto ${PORT}`);
  console.log(`   POST /v1/chat/completions  ← ElevenLabs Custom LLM`);
  console.log(`   POST /kitchen/ack          ← Kitchen ACK webhook`);
  console.log(`   GET  /health               ← Health check\n`);
});

module.exports = app;
