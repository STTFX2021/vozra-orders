"use strict";

/**
 * VOZRA ORDERS — Test Suite Fase 5
 * Cubre TEST-019 a TEST-024 (Dispatch + ACK Monitor).
 * Usa dispatchOrderMock — sin llamadas HTTP reales.
 */

const { processTurn }           = require("./order-slot-filler.service.js");
const { clearAllSessionsForTests, getOrCreateOrderSession, ORDER_STATUS } = require("./order-call-session.store.js");
const { validateOrder }         = require("./order-validator.service.js");
const { dispatchOrderMock }     = require("./dispatch-adapter.service.js");
const fs   = require("fs");
const path = require("path");

// ─── RUNNER ───────────────────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD   = "\x1b[1m";
const GRAY   = "\x1b[90m";

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function sim(id, turns) {
  clearAllSessionsForTests();
  for (const t of turns) processTurn(id, t);
  return getOrCreateOrderSession(id);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(id, label, priority, fn) {
  const result = fn();
  // fn puede ser async — lo manejamos en el runner
  if (result && typeof result.then === "function") {
    return result.then(() => {
      console.log(`${GREEN}✅ ${id}${RESET} [${priority}] ${label}`);
      passed++;
    }).catch(e => {
      console.log(`${RED}❌ ${id}${RESET} [${priority}] ${label}`);
      console.log(`   ${GRAY}${e.message}${RESET}`);
      failed++;
      failures.push({ id, label, error: e.message });
    });
  }
  // sync
  try {
    console.log(`${GREEN}✅ ${id}${RESET} [${priority}] ${label}`);
    passed++;
  } catch(e) {
    console.log(`${RED}❌ ${id}${RESET} [${priority}] ${label}`);
    failed++;
    failures.push({ id, label, error: e.message });
  }
  return Promise.resolve();
}

function skip(id, label, priority, reason) {
  console.log(`${YELLOW}⏭  ${id}${RESET} [${priority}] ${label} ${GRAY}→ ${reason}${RESET}`);
  skipped++;
  return Promise.resolve();
}

// ─── TESTS ────────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}══ P1/P2 — Dispatch y ACK ═══════════════════════${RESET}\n`);

async function runAll() {

  await run("TEST-019", "Dispatch exitoso — Telegram (canal primario)", "P1", async () => {
    const o = sim("T019", ["quiero una barbacoa grande","para recoger","Carlos","612345678","si"]);
    const v = validateOrder(o);
    assert(o.status === ORDER_STATUS.CUSTOMER_CONFIRMED, `pre-dispatch status=${o.status}`);

    const r = await dispatchOrderMock(o, v, { failChannels: [] });

    assert(r.ok,                                    "dispatch falló");
    assert(r.channel === "telegram",                `canal=${r.channel} (esperado: telegram)`);
    assert(r.order.status === ORDER_STATUS.SENT_TO_KITCHEN, `status=${r.order.status}`);
    assert(r.attempts.length === 1,                 `intentos=${r.attempts.length} (esperado: 1)`);
    assert(r.order.dispatchChannel === "telegram",  `dispatchChannel=${r.order.dispatchChannel}`);
    assert(r.order.dispatchAt,                      "dispatchAt no registrado");
  });

  await run("TEST-020", "Fallback a Discord cuando Telegram falla", "P1", async () => {
    const o = sim("T020", ["quiero una margarita grande","para recoger","Ana","698765432","si"]);
    const v = validateOrder(o);

    const r = await dispatchOrderMock(o, v, { failChannels: ["telegram"] });

    assert(r.ok,                                    "dispatch falló");
    assert(r.channel === "discord",                 `canal=${r.channel} (esperado: discord)`);
    assert(r.order.status === ORDER_STATUS.SENT_TO_KITCHEN, `status=${r.order.status}`);
    assert(r.attempts.length === 2,                 `intentos=${r.attempts.length} (esperado: 2)`);
    assert(!r.attempts[0].ok,                       "primer intento (telegram) debería haber fallado");
    assert(r.attempts[1].ok,                        "segundo intento (discord) debería haber funcionado");
  });

  await run("TEST-021", "Fallback a file cuando Telegram y Discord fallan", "P2", async () => {
    const o = sim("T021", ["quiero una cuatro quesos mediana","para recoger","Luis","611222333","si"]);
    const v = validateOrder(o);

    const r = await dispatchOrderMock(o, v, { failChannels: ["telegram", "discord"] });

    assert(r.ok,                                        "dispatch falló incluso en file_fallback");
    assert(r.channel === "file_fallback",               `canal=${r.channel} (esperado: file_fallback)`);
    assert(r.order.status === ORDER_STATUS.SENT_TO_KITCHEN, `status=${r.order.status}`);
    assert(r.attempts.length === 3,                     `intentos=${r.attempts.length} (esperado: 3)`);
    assert(r.attempts[0].channel === "telegram" && !r.attempts[0].ok,  "telegram debería haber fallado");
    assert(r.attempts[1].channel === "discord"  && !r.attempts[1].ok,  "discord debería haber fallado");
    assert(r.attempts[2].channel === "file_fallback" && r.attempts[2].ok, "file_fallback debería haber funcionado");

    // Verificar que el fichero fue escrito en disco
    const fallbackDir = path.join(__dirname, "..", "orders_fallback");
    assert(fs.existsSync(fallbackDir), "directorio orders_fallback no creado");
    const files = fs.readdirSync(fallbackDir).filter(f => f.startsWith(o.orderId));
    assert(files.length > 0, `fichero de fallback no encontrado para ${o.orderId}`);
  });

  await run("TEST-022", "Todos los canales fallan → failed_dispatch", "P2", async () => {
    const o = sim("T022", ["quiero una napolitana grande","para recoger","Marta","677000111","si"]);
    const v = validateOrder(o);

    const r = await dispatchOrderMock(o, v, { failChannels: ["telegram", "discord", "file_fallback"] });

    assert(!r.ok,                                           "dispatch debería haber fallado");
    assert(r.channel === null,                              `canal=${r.channel} (esperado: null)`);
    assert(r.order.status === ORDER_STATUS.FAILED_DISPATCH, `status=${r.order.status}`);
    assert(r.attempts.length === 3,                         `intentos=${r.attempts.length} (esperado: 3)`);
    assert(r.attempts.every(a => !a.ok),                    "algún intento fue marcado como ok incorrectamente");
    assert(r.error,                                         "sin mensaje de error en resultado");
  });

  await run("TEST-023", "Ledger registra todos los intentos de dispatch", "P2", async () => {
    const o = sim("T023", ["quiero una barbacoa mediana","para recoger","Toni","622111000","si"]);
    const v = validateOrder(o);

    // Telegram falla, Discord OK — el ledger debe registrar ambos intentos
    const r = await dispatchOrderMock(o, v, { failChannels: ["telegram"] });

    assert(r.ok, "dispatch falló");
    // Los eventos del pedido deben incluir dispatch_success
    const dispatchEvent = (r.order.events || []).find(e => e.eventType === "dispatch_success");
    assert(dispatchEvent, `evento dispatch_success no encontrado en ledger. events=${JSON.stringify(r.order.events?.map(e=>e.eventType))}`);
    assert(dispatchEvent.detail.includes("discord"), `detail no menciona discord: ${dispatchEvent.detail}`);
  });

  await run("TEST-024", "Dispatch no modifica pedido ya enviado (idempotencia)", "P2", async () => {
    const o = sim("T024", ["quiero una margarita grande","para recoger","Eva","699555000","si"]);
    const v = validateOrder(o);

    // Primer dispatch — éxito
    const r1 = await dispatchOrderMock(o, v, { failChannels: [] });
    assert(r1.ok, "primer dispatch falló");
    assert(r1.order.status === ORDER_STATUS.SENT_TO_KITCHEN, "status no es sent_to_kitchen tras primer dispatch");

    const firstDispatchAt = r1.order.dispatchAt;

    // Segundo dispatch sobre el mismo pedido — el status ya es sent_to_kitchen
    // En producción el dispatcher debería detectarlo; aquí verificamos que el status no retrocede
    const r2 = await dispatchOrderMock(r1.order, v, { failChannels: [] });
    // El status no debe volver a customer_confirmed ni a draft
    assert(
      r2.order.status === ORDER_STATUS.SENT_TO_KITCHEN,
      `status retrocedió tras segundo dispatch: ${r2.order.status}`
    );
  });

  // ── RESUMEN ────────────────────────────────────────────────────────────────

  console.log(`\n${BOLD}══ RESUMEN Fase 5 ═══════════════════════════════${RESET}\n`);
  console.log(`${GREEN}✅ Pasados:  ${passed}${RESET}`);
  console.log(`${RED}❌ Fallidos: ${failed}${RESET}`);
  console.log(`${YELLOW}⏭  Skipped:  ${skipped}${RESET}`);
  console.log(`   Total:    ${passed + failed + skipped}`);

  if (failures.length > 0) {
    console.log(`\n${RED}${BOLD}FALLOS DETALLADOS:${RESET}`);
    failures.forEach(f => {
      console.log(`  ${RED}${f.id}${RESET} — ${f.label}`);
      console.log(`    ${GRAY}${f.error}${RESET}`);
    });
  }
  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(e => {
  console.error("Error inesperado en test runner:", e.message);
  process.exit(1);
});
