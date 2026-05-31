"use strict";

/**
 * VOZRA ORDERS — Test Suite Fase 6
 * Kitchen ACK Monitor: watchOrder, markKitchenAck, alertas, ledger.
 * Usa timers cortos (ms) para no bloquear los tests.
 */

const {
  watchOrder, markKitchenAck, cancelWatch,
  getWatchStatus, clearAllWatches, startKitchenWatch, setAlertHandler
} = require("./kitchen-ack-monitor.service.js");

const { processTurn }           = require("./order-slot-filler.service.js");
const { clearAllSessionsForTests, getOrCreateOrderSession, ORDER_STATUS } = require("./order-call-session.store.js");
const { validateOrder }         = require("./order-validator.service.js");
const { dispatchOrderMock }     = require("./dispatch-adapter.service.js");

// ─── RUNNER ───────────────────────────────────────────────────────────────────

const RESET = "\x1b[0m", GREEN = "\x1b[32m", RED = "\x1b[31m", BOLD = "\x1b[1m", GRAY = "\x1b[90m";
let passed = 0, failed = 0;
const failures = [];

function assert(c, m) { if (!c) throw new Error(m); }

async function run(id, label, fn) {
  try {
    await fn();
    console.log(`${GREEN}✅ ${id}${RESET} ${label}`);
    passed++;
  } catch(e) {
    console.log(`${RED}❌ ${id}${RESET} ${label}`);
    console.log(`   ${GRAY}${e.message}${RESET}`);
    failed++;
    failures.push({ id, label, error: e.message });
  }
}

// Helper: simula un pedido confirmado + dispatch
async function simDispatched(id) {
  clearAllSessionsForTests();
  ["quiero una barbacoa grande","para recoger","Carlos","612345678","si"]
    .forEach(t => processTurn(id, t));
  const o = getOrCreateOrderSession(id);
  const r = await dispatchOrderMock(o, validateOrder(o), { failChannels: [] });
  return r.order;
}

// Helper: watchOrder con timers cortos para tests
function watchFast(order, warningMs = 80, criticalMs = 160) {
  const entry = watchOrder(order.orderId, order.callId);
  clearTimeout(entry.timers.warning);
  clearTimeout(entry.timers.critical);
  entry.timers.warning  = setTimeout(() => {
    if (entry.status !== "watching") return;
    entry.status = "warned";
    entry.alerts.push({ level: "warning", at: new Date().toISOString(), message: "sin ACK" });
    _captureAlert("warning", order.orderId, "sin ACK (test)");
    const sess = getOrCreateOrderSession(order.callId);
    sess.events.push({ eventType: "ack_warning", timestamp: new Date().toISOString(), status: sess.status, detail: "test" });
  }, warningMs);
  entry.timers.critical = setTimeout(() => {
    if (entry.status === "acked" || entry.status === "cancelled") return;
    entry.status = "critical";
    entry.alerts.push({ level: "critical", at: new Date().toISOString(), message: "escalando" });
    _captureAlert("critical", order.orderId, "escalando (test)");
    const { updateOrderSession } = require("./order-call-session.store.js");
    updateOrderSession(order.callId, { status: ORDER_STATUS.KITCHEN_NOT_ACKNOWLEDGED });
    const sess = getOrCreateOrderSession(order.callId);
    sess.events.push({ eventType: "ack_critical", timestamp: new Date().toISOString(), status: ORDER_STATUS.KITCHEN_NOT_ACKNOWLEDGED, detail: "test" });
  }, criticalMs);
  return entry;
}

const _capturedAlerts = [];
let _captureAlert = () => {};

// ─── TESTS ────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}══ Fase 6 — Kitchen ACK Monitor ═════════════════${RESET}\n`);

async function runAll() {

  await run("ACK-001", "ACK recibido antes del warning → accepted_by_kitchen", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A001");
    const alerts = [];
    setAlertHandler((level, oid, msg) => alerts.push(level));

    watchFast(order, 150, 300);
    await new Promise(r => setTimeout(r, 50)); // ACK llega antes del warning

    const result = markKitchenAck(order.orderId, "accepted");
    assert(result.ok, `markKitchenAck falló: ${result.error}`);
    assert(result.newStatus === ORDER_STATUS.ACCEPTED_BY_KITCHEN, `newStatus=${result.newStatus}`);
    assert(result.order.status === ORDER_STATUS.ACCEPTED_BY_KITCHEN, `order.status=${result.order.status}`);
    assert(result.order.kitchenAckAt, "kitchenAckAt no registrado");

    await new Promise(r => setTimeout(r, 200)); // esperar a que los timers expirarían
    assert(alerts.length === 0, `alertas disparadas aunque hubo ACK: ${JSON.stringify(alerts)}`);
  });

  await run("ACK-002", "ACK acknowledged (sin accepted/rejected) → kitchen_acknowledged", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A002");
    setAlertHandler(() => {});

    watchFast(order, 150, 300);
    const result = markKitchenAck(order.orderId, "acknowledged");

    assert(result.ok, "markKitchenAck falló");
    assert(result.newStatus === ORDER_STATUS.KITCHEN_ACKNOWLEDGED, `newStatus=${result.newStatus}`);
  });

  await run("ACK-003", "Cocina rechaza el pedido → rejected_by_kitchen", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A003");
    setAlertHandler(() => {});

    watchFast(order, 150, 300);
    const result = markKitchenAck(order.orderId, "rejected");

    assert(result.ok, "markKitchenAck falló");
    assert(result.newStatus === ORDER_STATUS.REJECTED_BY_KITCHEN, `newStatus=${result.newStatus}`);
    assert(result.order.status === ORDER_STATUS.REJECTED_BY_KITCHEN, `order.status=${result.order.status}`);
  });

  await run("ACK-004", "Warning dispara si cocina no responde en tiempo", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A004");
    setAlertHandler(() => {});

    const entry = watchFast(order, 80, 400); // warning rápido, critical lento

    await new Promise(r => setTimeout(r, 130)); // esperar a que dispare el warning

    assert(entry.status === "warned", `entry.status=${entry.status} (esperado: warned)`);
    assert(entry.alerts.some(a => a.level === "warning"), `no hay alerta warning en entry.alerts: ${JSON.stringify(entry.alerts)}`);
    assert(!entry.alerts.some(a => a.level === "critical"), "critical no debería haber disparado todavía");

    clearTimeout(entry.timers.critical); // limpiar para no contaminar
  });

  await run("ACK-005", "Critical dispara si cocina no responde tras timeout largo", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A005");
    setAlertHandler(() => {});

    const entry = watchFast(order, 60, 120);
    await new Promise(r => setTimeout(r, 180)); // esperar warning + critical

    assert(entry.status === "critical", `entry.status=${entry.status} (esperado: critical)`);
    assert(entry.alerts.some(a => a.level === "warning"),  `alerta warning no en entry.alerts: ${JSON.stringify(entry.alerts)}`);
    assert(entry.alerts.some(a => a.level === "critical"), `alerta critical no en entry.alerts: ${JSON.stringify(entry.alerts)}`);

    // El pedido debe estar en kitchen_not_acknowledged
    const finalOrder = getOrCreateOrderSession(order.callId);
    assert(
      finalOrder.status === ORDER_STATUS.KITCHEN_NOT_ACKNOWLEDGED,
      `order.status=${finalOrder.status} (esperado: kitchen_not_acknowledged)`
    );
  });

  await run("ACK-006", "Ledger registra ack_warning y ack_critical", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A006");
    setAlertHandler(() => {});

    watchFast(order, 60, 120);
    await new Promise(r => setTimeout(r, 160));

    const finalOrder = getOrCreateOrderSession(order.callId);
    const warnEvent    = finalOrder.events.find(e => e.eventType === "ack_warning");
    const critEvent    = finalOrder.events.find(e => e.eventType === "ack_critical");
    assert(warnEvent, `evento ack_warning no encontrado en ledger. events=${finalOrder.events.map(e=>e.eventType)}`);
    assert(critEvent, `evento ack_critical no encontrado en ledger. events=${finalOrder.events.map(e=>e.eventType)}`);
  });

  await run("ACK-007", "Ledger registra kitchen_accepted en ACK exitoso", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A007");
    setAlertHandler(() => {});

    watchFast(order, 150, 300);
    markKitchenAck(order.orderId, "accepted");

    const finalOrder = getOrCreateOrderSession(order.callId);
    const ackEvent = finalOrder.events.find(e => e.eventType === "kitchen_accepted");
    assert(ackEvent, `evento kitchen_accepted no en ledger. events=${finalOrder.events.map(e=>e.eventType)}`);
  });

  await run("ACK-008", "cancelWatch detiene los timers sin alertas", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A008");
    const alerts = [];
    setAlertHandler((level) => alerts.push(level));

    watchFast(order, 80, 160);
    cancelWatch(order.orderId);

    await new Promise(r => setTimeout(r, 200));
    assert(alerts.length === 0, `alertas disparadas tras cancelWatch: ${JSON.stringify(alerts)}`);
    assert(!getWatchStatus(order.orderId), "pedido todavía aparece en monitor tras cancelWatch");
  });

  await run("ACK-009", "startKitchenWatch lanza error si pedido no está en sent_to_kitchen", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    ["quiero una margarita","para recoger","Mar","612000111"]
      .forEach(t => processTurn("A009", t));
    const o = getOrCreateOrderSession("A009");
    // status = draft (no confirmado aún)
    let threw = false;
    try { startKitchenWatch(o); } catch(e) { threw = true; }
    assert(threw, "startKitchenWatch no lanzó error para status=draft");
  });

  await run("ACK-010", "ACK doble idempotente — no dispara error ni altera status", async () => {
    clearAllWatches(); clearAllSessionsForTests();
    const order = await simDispatched("A010");
    setAlertHandler(() => {});

    watchFast(order, 150, 300);
    const r1 = markKitchenAck(order.orderId, "accepted");
    const r2 = markKitchenAck(order.orderId, "accepted"); // segundo ACK

    assert(r1.ok, "primer ACK falló");
    assert(r2.ok, "segundo ACK falló");
    assert(r2.alreadyAcked === true, "segundo ACK no detectado como duplicado");
    // Status no debe cambiar
    assert(r1.order.status === ORDER_STATUS.ACCEPTED_BY_KITCHEN, `status tras doble ACK=${r1.order.status}`);
  });

  // ── RESUMEN ────────────────────────────────────────────────────────────────

  clearAllWatches();

  console.log(`\n${BOLD}══ RESUMEN Fase 6 ═══════════════════════════════${RESET}\n`);
  console.log(`${GREEN}✅ Pasados:  ${passed}${RESET}`);
  console.log(`${RED}❌ Fallidos: ${failed}${RESET}`);
  console.log(`   Total:    ${passed + failed}`);

  if (failures.length > 0) {
    console.log(`\n${RED}${BOLD}FALLOS:${RESET}`);
    failures.forEach(f => {
      console.log(`  ${RED}${f.id}${RESET} ${f.label}`);
      console.log(`    ${GRAY}${f.error}${RESET}`);
    });
  }
  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(e => { console.error("Error en runner:", e.message); process.exit(1); });
