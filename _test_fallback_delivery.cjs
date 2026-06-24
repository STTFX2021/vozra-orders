"use strict";
/**
 * Test del fix file_fallback: Marta NO debe confirmar "a cocina" si el pedido
 * solo cayó en el respaldo en fichero (cocina no lo ha visto).
 */
// Forzar entorno sin canales reales → el dispatch real caerá a file_fallback.
// dotenv NO sobrescribe variables ya definidas, así que las fijamos a valores
// INVÁLIDOS (no vacíos) para que telegram/discord fallen en HTTP y caigan a fallback.
process.env.TELEGRAM_BOT_TOKEN_LA_LOCANDA = "0:TEST_INVALID";
process.env.TELEGRAM_BOT_TOKEN           = "0:TEST_INVALID";
process.env.TELEGRAM_CHAT_ID_LA_LOCANDA  = "-1";
process.env.TELEGRAM_CHAT_ID             = "-1";
process.env.DISCORD_WEBHOOK_URL_LA_LOCANDA = "https://discord.com/api/webhooks/0/INVALID";
process.env.DISCORD_WEBHOOK_URL           = "https://discord.com/api/webhooks/0/INVALID";
const os = require("os"), path = require("path");
process.env.FALLBACK_ORDERS_DIR = path.join(os.tmpdir(), "vozra_fallback_test_" + Date.now());

const { dispatchOrderMock } = require("./dispatch-adapter.service.js");
const { getOrCreateOrderSession, updateOrderSession, ORDER_STATUS } = require("./order-call-session.store.js");
const { handleSubmitOrder } = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("  OK  " + msg); } else { fail++; console.log(" FAIL " + msg); } }

function makeOrder(callId) {
  getOrCreateOrderSession(callId);
  return updateOrderSession(callId, {
    items: [{ id: "pizza_margherita", displayName: "Margherita", quantity: 1, price: 8.5, modifiers: [] }],
    orderType: "pickup", customerName: "Test", phone: "600111222",
    status: ORDER_STATUS.CUSTOMER_CONFIRMED
  });
}

(async () => {
  // 1) MOCK: canal real (telegram) OK → delivered true
  const o1 = makeOrder("call-mock-real");
  const r1 = await dispatchOrderMock(o1, {}, { failChannels: [], succeed: true });
  ok(r1.ok === true && r1.delivered === true && r1.channel === "telegram",
     "canal real telegram → ok=true, delivered=true (canal=" + r1.channel + ")");

  // 2) MOCK: telegram+discord fallan → solo file_fallback → delivered false
  const o2 = makeOrder("call-mock-fallback");
  const r2 = await dispatchOrderMock(o2, {}, { failChannels: ["telegram", "discord"], succeed: true });
  ok(r2.ok === true && r2.delivered === false && r2.channel === "file_fallback",
     "solo fallback → ok=true PERO delivered=false (canal=" + r2.channel + ")");

  // 3) LIVE: handleSubmitOrder sin credenciales → cae a file_fallback → Marta NO confirma a cocina
  const res = await handleSubmitOrder("call-live-fallback", {
    items: [{ name: "Margherita", quantity: 1 }],
    order_type: "pickup", customer_name: "Samuel", phone: "600111222"
  });
  ok(res.delivered === false, "live solo-fallback → delivered=false");
  ok(!/queda confirmado y lo paso a cocina/i.test(res.reply),
     "live solo-fallback → Marta NO dice 'queda confirmado y lo paso a cocina'");
  ok(/registrado/i.test(res.reply) && /confirmamos|llamarnos/i.test(res.reply),
     "live solo-fallback → wording honesto (registrado + te confirmamos / llamarnos)");
  console.log("    reply: " + res.reply);

  console.log("\n  RESULT: " + pass + " OK, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
