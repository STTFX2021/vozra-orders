#!/usr/bin/env node
"use strict";

/**
 * VOZRA ORDERS — Simulador de Llamada por Texto
 *
 * MODO POR DEFECTO = CEREBRO REAL (generateMartaReply + OpenAI), el mismo
 * camino que atiende las llamadas en producción. Requiere OPENAI_API_KEY
 * en backend/.env. Los envíos reales (Telegram/Discord, Supabase, Twilio)
 * quedan DESACTIVADOS por defecto: el ticket cae a orders_fallback_sim/.
 *
 * Uso: node simulator.js [opciones]
 *
 * Opciones:
 *   --callId <id>    Usar un callId específico (default: auto-generado)
 *   --phone <num>    Simular caller ID (activa buscar_cliente si hay Supabase y --live)
 *   --show-order     Mostrar el JSON del pedido completo tras cada turno
 *   --ticket         Al confirmar, mostrar el ticket de cocina
 *   --reset          Limpiar sesión y empezar de nuevo
 *   --live           NO desactivar side-effects (¡dispara Telegram/Supabase REALES!)
 *   --legacy         Usar el motor antiguo por reglas (processTurn).
 *                    ⚠ NO representa producción: solo para depurar el parser legacy.
 */

const path = require("path");
const readline = require("readline");

// dotenv PRIMERO, para poder anular side-effects ANTES de cargar los servicios.
require("dotenv").config();

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const showOrder = args.includes("--show-order");
const showTicket = args.includes("--ticket") || args.includes("--show-order");
const resetSession = args.includes("--reset");
const legacyMode = args.includes("--legacy");
const liveMode = args.includes("--live");

const callIdIndex = args.indexOf("--callId");
const callId = callIdIndex !== -1 && args[callIdIndex + 1]
  ? args[callIdIndex + 1]
  : `sim-${Date.now()}`;

const phoneIndex = args.indexOf("--phone");
const callerPhone = phoneIndex !== -1 && args[phoneIndex + 1] ? args[phoneIndex + 1] : null;

// ─── SANDBOX DE SIDE-EFFECTS (modo cerebro, salvo --live) ────────────────────
// El cerebro real dispara dispatch/persistencia/notificación dentro de
// handleSubmitOrder. En simulación NO queremos tocar la cocina real ni la BD:
// se vacían las vars ANTES de requerir los servicios (algunos leen env al cargar).

if (!legacyMode && !liveMode) {
  const MUTE = [
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN_LA_LOCANDA",
    "TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID_LA_LOCANDA",
    "DISCORD_WEBHOOK_URL", "DISCORD_WEBHOOK_URL_LA_LOCANDA",
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
    "TWILIO_SMS_FROM", "TWILIO_MESSAGING_SERVICE_SID", "TWILIO_WHATSAPP_FROM"
  ];
  for (const k of MUTE) process.env[k] = "";
  process.env.CUSTOMER_NOTIFY_CHANNEL = "off";
  process.env.FALLBACK_ORDERS_DIR = path.join(__dirname, "orders_fallback_sim");
}

// Requerir DESPUÉS de silenciar el entorno.
const {
  getOrCreateOrderSession,
  clearAllSessionsForTests,
  ORDER_STATUS
} = require("./order-call-session.store.js");
const { processTurn, buildKitchenTicket } = require("./order-slot-filler.service.js");
const { generateMartaReply } = require("./marta-llm.service.js");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const BLUE  = "\x1b[34m";
const YELLOW = "\x1b[33m";
const CYAN  = "\x1b[36m";
const GRAY  = "\x1b[90m";
const RED   = "\x1b[31m";

const AGENT_NAME = legacyMode ? "Marta (legacy)" : "Sarah";
const GREETING = "¡Hola! La Locanda de Cancelada, soy Sarah. ¿Qué te apetece hoy?";

function printMarta(text) {
  console.log(`\n${GREEN}${BOLD}🤖 ${AGENT_NAME}:${RESET} ${text}\n`);
}

function printSystem(text) {
  console.log(`${GRAY}[sistema] ${text}${RESET}`);
}

function printOrder(order) {
  console.log(`\n${CYAN}── Estado del pedido ──────────────────────${RESET}`);
  console.log(`${CYAN}Status:${RESET}      ${order.status}`);
  console.log(`${CYAN}Tipo:${RESET}        ${order.orderType || "(sin definir)"}`);
  console.log(`${CYAN}Items:${RESET}       ${order.items.length > 0 ? order.items.map(i => `${i.quantity||1}x ${i.displayName}${i.size?" "+i.size:""}`).join(", ") : "(vacío)"}`);
  console.log(`${CYAN}Cliente:${RESET}     ${order.customerName || "(sin nombre)"}`);
  console.log(`${CYAN}Teléfono:${RESET}    ${order.phone || "(sin teléfono)"}`);
  if (order.orderType === "delivery") {
    console.log(`${CYAN}Dirección:${RESET}   ${order.address?.raw || "(sin dirección)"}`);
  }
  if (order.allergies.length > 0) {
    console.log(`${YELLOW}⚠️  Alergias:${RESET}   ${order.allergies.join(", ")}`);
  }
  const activeFlags = Object.entries(order.flags || {}).filter(([,v])=>v).map(([k])=>k);
  if (activeFlags.length > 0) {
    console.log(`${RED}🚩 Flags:${RESET}      ${activeFlags.join(", ")}`);
  }
  console.log(`${CYAN}──────────────────────────────────────────${RESET}\n`);
}

function printTicket(order) {
  const ticket = buildKitchenTicket(order);
  console.log(`\n${BOLD}${YELLOW}══════════ COMANDA PARA COCINA ══════════${RESET}`);
  console.log(ticket);
  console.log(`${YELLOW}═════════════════════════════════════════${RESET}\n`);
}

function printHelp() {
  console.log(`\n${GRAY}Comandos disponibles durante la simulación:
  /orden     — Ver el JSON completo del pedido
  /ticket    — Generar el ticket de cocina
  /reset     — Reiniciar la sesión
  /ayuda     — Ver este mensaje
  /salir     — Terminar el simulador
${RESET}`);
}

// ─── INICIO ───────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}${BLUE}╔══════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${BLUE}║     VOZRA ORDERS — Simulador de Llamada  ║${RESET}`);
console.log(`${BOLD}${BLUE}║     La Locanda de Cancelada              ║${RESET}`);
console.log(`${BOLD}${BLUE}╚══════════════════════════════════════════╝${RESET}`);
console.log(`\n${GRAY}callId: ${callId}${legacyMode ? "" : liveMode ? "  |  modo: CEREBRO REAL + SIDE-EFFECTS REALES" : "  |  modo: CEREBRO REAL (side-effects OFF)"}${RESET}`);

if (legacyMode) {
  console.log(`\n${RED}${BOLD}⚠ MOTOR LEGACY (processTurn, por reglas).${RESET}${RED} NO es el cerebro de producción:`);
  console.log(`  sus respuestas y bucles NO ocurren en llamadas reales. Úsalo solo para`);
  console.log(`  depurar el parser antiguo. Sin --legacy pruebas el camino real.${RESET}`);
} else {
  if (!process.env.OPENAI_API_KEY) {
    console.error(`\n${RED}${BOLD}Falta OPENAI_API_KEY en backend/.env.${RESET}${RED}`);
    console.error(`El simulador usa por defecto el CEREBRO REAL (el de producción) y necesita esa clave.`);
    console.error(`Alternativa sin clave: node simulator.js --legacy  (motor antiguo, NO representa producción).${RESET}\n`);
    process.exit(1);
  }
  if (liveMode) {
    console.log(`\n${RED}${BOLD}⚠ --live: los pedidos confirmados SÍ dispararán Telegram/Supabase/Twilio reales.${RESET}`);
  } else {
    printSystem("Side-effects desactivados: Telegram/Discord/Supabase/Twilio OFF. Ticket → orders_fallback_sim/");
  }
}
printHelp();

if (resetSession) {
  clearAllSessionsForTests();
  printSystem("Sesión reiniciada.");
}

// Historial de la conversación en formato OpenAI (igual que envía ElevenLabs).
const history = [{ role: "assistant", content: GREETING }];

// ─── READLINE LOOP ────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${BOLD}${BLUE}Tú:${RESET} `
});

printMarta(legacyMode ? "¡Hola! La Locanda de Cancelada, soy Marta. ¿Qué te pongo?" : GREETING);
rl.prompt();

let busy = false;

async function brainTurn(input) {
  history.push({ role: "user", content: input });
  const t0 = Date.now();
  const { reply, dispatched, action } = await generateMartaReply(callId, history, callerPhone);
  history.push({ role: "assistant", content: reply });
  printMarta(reply);
  printSystem(`action=${action || "-"} | dispatched=${dispatched} | ${Date.now() - t0} ms`);

  const order = getOrCreateOrderSession(callId);
  if (showOrder) printOrder(order);
  if (action === "customer_confirmed" && showTicket) printTicket(order);
  if (action === "customer_confirmed") {
    printSystem("Pedido confirmado. /orden para revisarlo, /reset para otra simulación.");
  }
}

function legacyTurn(input) {
  const { order, response, action } = processTurn(callId, input);
  printMarta(response);
  if (showOrder) printOrder(order);
  if (action === "customer_confirmed" && showTicket) printTicket(order);
  if (order.status === ORDER_STATUS.CANCELLED_BY_CUSTOMER) {
    printSystem("Pedido cancelado. Fin de la llamada.");
    rl.close();
    return;
  }
}

rl.on("line", async (line) => {
  const input = line.trim();

  if (busy) { printSystem("Espera, aún estoy respondiendo al turno anterior…"); return; }

  // Comandos internos del simulador
  if (!input || input === "/ayuda") { printHelp(); rl.prompt(); return; }
  if (input === "/salir" || input === "exit" || input === "q") {
    console.log(`\n${GRAY}Fin de la simulación. ¡Hasta luego!${RESET}\n`);
    process.exit(0);
  }
  if (input === "/orden") {
    const order = getOrCreateOrderSession(callId);
    console.log("\n" + JSON.stringify(order, null, 2));
    rl.prompt();
    return;
  }
  if (input === "/ticket") {
    const order = getOrCreateOrderSession(callId);
    printTicket(order);
    rl.prompt();
    return;
  }
  if (input === "/reset") {
    clearAllSessionsForTests();
    history.length = 0;
    history.push({ role: "assistant", content: GREETING });
    printSystem("Sesión reiniciada. Empezando de nuevo.");
    printMarta(legacyMode ? "¡Hola! La Locanda de Cancelada, soy Marta. ¿Qué te pongo?" : GREETING);
    rl.prompt();
    return;
  }

  // Procesar el turno
  busy = true;
  try {
    if (legacyMode) {
      legacyTurn(input);
    } else {
      await brainTurn(input);
    }
  } catch (err) {
    console.error(`\n${RED}Error en el simulador:${RESET}`, err.message);
    if (err.code === "ENOENT") {
      console.error(`${RED}No se encontró el fichero de taxonomía. ¿Está en data/taxonomies/?${RESET}`);
    }
  }
  busy = false;

  rl.prompt();
});

rl.on("close", () => {
  const order = getOrCreateOrderSession(callId);
  if (order.items.length > 0) {
    printSystem(`Sesión finalizada. Estado final: ${order.status}`);
  }
  process.exit(0);
});

rl.on("SIGINT", () => {
  console.log(`\n${GRAY}(Ctrl+C detectado — usa /salir o /reset)${RESET}`);
  rl.prompt();
});
