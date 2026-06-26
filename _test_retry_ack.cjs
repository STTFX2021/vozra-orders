"use strict";
// Test offline de #2: retry de envío + flujo de ACK en memoria.
require("dotenv").config();
const { sendWithRetry } = require("./dispatch-adapter.service.js");
const { watchOrder, markKitchenAck, clearAllWatches, getWatchStatus } = require("./kitchen-ack-monitor.service.js");
const { getOrCreateOrderSession, updateOrderSession, ORDER_STATUS, getOrderSession } = require("./order-call-session.store.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  " + m); } else { fail++; console.log(" FAIL " + m); } };

(async () => {
  // 1) sendWithRetry: 2 fallos transitorios y al 3o exito
  let n = 0;
  const r = await sendWithRetry(async () => {
    n++;
    if (n < 3) throw new Error("ETIMEDOUT transitorio");
    return { okch: true };
  }, { attempts: 3, baseDelayMs: 5 });
  ok(n === 3 && r && r.okch === true, "retry reintenta transitorios y acaba OK (intentos=" + n + ")");

  // 2) sendWithRetry: error de config NO se reintenta
  let m = 0, threw = false;
  try {
    await sendWithRetry(async () => { m++; throw new Error("Telegram: botToken no configurados"); }, { attempts: 3, baseDelayMs: 5 });
  } catch (_) { threw = true; }
  ok(threw && m === 1, "retry NO reintenta errores de config (intentos=" + m + ")");

  // 3) ACK en memoria: watchOrder -> markKitchenAck -> kitchen_acknowledged
  clearAllWatches();
  const callId = "call-ack-test";
  getOrCreateOrderSession(callId);
  updateOrderSession(callId, { status: ORDER_STATUS.SENT_TO_KITCHEN });
  const oid = "ORD-ACK-1";
  watchOrder(oid, callId, "la-locanda");
  ok(getWatchStatus(oid) && getWatchStatus(oid).status === "watching", "pedido en watching tras dispatch");
  const ack = markKitchenAck(oid, "acknowledged");
  ok(ack.ok === true, "markKitchenAck OK");
  ok(getWatchStatus(oid).status === "acked", "monitor pasa a acked (timers cancelados)");
  const sess = getOrderSession(callId);
  ok(sess && sess.status === ORDER_STATUS.KITCHEN_ACKNOWLEDGED, "pedido -> kitchen_acknowledged");
  clearAllWatches();

  console.log("\n  RESULT: " + pass + " OK, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
