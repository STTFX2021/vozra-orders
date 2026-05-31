#!/usr/bin/env node
"use strict";

/**
 * VOZRA ORDERS — Simulador de Llamada por Texto
 * Simula una conversación con Marta (agente de voz) por línea de comandos.
 *
 * Uso: node simulator.js [--callId <id>] [--show-order] [--ticket]
 *
 * Opciones:
 *   --callId <id>    Usar un callId específico (default: auto-generado)
 *   --show-order     Mostrar el JSON del pedido completo tras cada turno
 *   --ticket         Al confirmar, mostrar el ticket de cocina
 *   --reset          Limpiar sesión y empezar de nuevo
 */

const readline = require("readline");
const {
  getOrCreateOrderSession,
  clearAllSessionsForTests,
  ORDER_STATUS
} = require("./order-call-session.store.js");
const { processTurn, buildKitchenTicket } = require("./order-slot-filler.service.js");

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const showOrder = args.includes("--show-order");
const showTicket = args.includes("--ticket") || args.includes("--show-order");
const resetSession = args.includes("--reset");

const callIdIndex = args.indexOf("--callId");
const callId = callIdIndex !== -1 && args[callIdIndex + 1]
  ? args[callIdIndex + 1]
  : `sim-${Date.now()}`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const BLUE  = "\x1b[34m";
const YELLOW = "\x1b[33m";
const CYAN  = "\x1b[36m";
const GRAY  = "\x1b[90m";
const RED   = "\x1b[31m";

function printMarta(text) {
  console.log(`\n${GREEN}${BOLD}🤖 Marta:${RESET} ${text}\n`);
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
  (Enter vacío en confirmación = Sí)
${RESET}`);
}

// ─── INICIO ───────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}${BLUE}╔══════════════════════════════════════════╗${RESET}`);
console.log(`${BOLD}${BLUE}║     VOZRA ORDERS — Simulador de Llamada  ║${RESET}`);
console.log(`${BOLD}${BLUE}║     La Locanda de Cancelada              ║${RESET}`);
console.log(`${BOLD}${BLUE}╚══════════════════════════════════════════╝${RESET}`);
console.log(`\n${GRAY}callId: ${callId}${RESET}`);
console.log(`${GRAY}Opciones: ${showOrder?"--show-order ":""}${showTicket?"--ticket ":""}${resetSession?"--reset":""}${RESET}`);
printHelp();

if (resetSession) {
  clearAllSessionsForTests();
  printSystem("Sesión reiniciada.");
}

// ─── READLINE LOOP ────────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: `${BOLD}${BLUE}Tú:${RESET} `
});

// Saludo inicial de Marta
printMarta("¡Hola! La Locanda de Cancelada, soy Marta. ¿Qué te pongo?");
rl.prompt();

rl.on("line", (line) => {
  const input = line.trim();

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
    printSystem("Sesión reiniciada. Empezando de nuevo.");
    printMarta("¡Hola! La Locanda de Cancelada, soy Marta. ¿Qué te pongo?");
    rl.prompt();
    return;
  }

  // Procesar el turno
  try {
    const { order, response, action } = processTurn(callId, input);

    printMarta(response);

    if (showOrder) printOrder(order);

    // Si el cliente confirmó → mostrar ticket automáticamente
    if (action === "customer_confirmed" && showTicket) {
      printTicket(order);
    }

    // Si el pedido está cancelado → cerrar
    if (order.status === ORDER_STATUS.CANCELLED_BY_CUSTOMER) {
      printSystem("Pedido cancelado. Fin de la llamada.");
      if (!showOrder) printSystem("Usa /orden para ver el estado final.");
      rl.close();
      return;
    }

  } catch (err) {
    console.error(`\n${RED}Error en el simulador:${RESET}`, err.message);
    if (err.code === "ENOENT") {
      console.error(`${RED}No se encontró el fichero de taxonomía. ¿Está en data/taxonomies/?${RESET}`);
    }
  }

  rl.prompt();
});

rl.on("close", () => {
  const order = getOrCreateOrderSession(callId);
  if (order.items.length > 0) {
    printSystem(`Sesión finalizada. Estado final: ${order.status}`);
    if (!showOrder) {
      printSystem(`Usa 'node simulator.js --callId ${callId} --show-order' para revisar el pedido.`);
    }
  }
  process.exit(0);
});

rl.on("SIGINT", () => {
  console.log(`\n${GRAY}(Ctrl+C detectado — usa /salir o /reset)${RESET}`);
  rl.prompt();
});
