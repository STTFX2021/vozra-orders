"use strict";
// Test de integración del módulo de persistencia contra el Supabase real.
// Requiere SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY en .env. Ejecutar: node _test_supabase.cjs
require("dotenv").config();
const { upsertOrder, getOrder, isEnabled } = require("./supabase-store.js");

const oid = "ORD-TEST-" + Date.now();
const order = {
  orderId: oid, callId: "call-db-test", providerSlug: "la-locanda",
  status: "customer_confirmed", orderType: "pickup", customerName: "Samuel Test",
  phone: "+34611404679", items: [{ id: "pizza_margherita", displayName: "Margherita", quantity: 1, price: 8.5 }],
  notes: null, events: [{ eventType: "created", ts: new Date().toISOString() }]
};
const validation = { estimatedTotal: 8.5, currency: "EUR" };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  OK  " + m); } else { fail++; console.log(" FAIL " + m); } };

(async () => {
  if (!isEnabled()) { console.log("Supabase no configurado (.env). Aborta."); process.exit(2); }

  const r1 = await upsertOrder(order, validation, { delivered: false });
  ok(r1.ok === true, "upsert pre-dispatch (insert) " + JSON.stringify(r1));

  const g1 = await getOrder(oid);
  ok(g1.ok && g1.order && g1.order.order_id === oid, "getOrder devuelve la fila");
  ok(g1.order && g1.order.delivered === false, "delivered=false tras pre-dispatch");
  ok(g1.order && Number(g1.order.estimated_total) === 8.5, "estimated_total=8.5");
  ok(g1.order && g1.order.status === "customer_confirmed", "status=customer_confirmed");

  order.status = "sent_to_kitchen";
  order.events.push({ eventType: "dispatch_success", ts: new Date().toISOString() });
  const r2 = await upsertOrder(order, validation, { delivered: true, channel: "telegram" });
  ok(r2.ok === true, "upsert post-dispatch (update) " + JSON.stringify(r2));

  const g2 = await getOrder(oid);
  ok(g2.order && g2.order.delivered === true, "delivered=true tras post-dispatch");
  ok(g2.order && g2.order.dispatch_channel === "telegram", "dispatch_channel=telegram");
  ok(g2.order && g2.order.status === "sent_to_kitchen", "status=sent_to_kitchen (recuperable)");
  ok(g2.order && Array.isArray(g2.order.events) && g2.order.events.length === 2, "events persistidos (2)");

  console.log("\n  RESULT: " + pass + " OK, " + fail + " FAIL  | orderId=" + oid);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
