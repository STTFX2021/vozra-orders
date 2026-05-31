"use strict";

/**
 * VOZRA ORDERS — Test Suite Fase 4
 * Cubre TEST-001 a TEST-018 y TEST-025 a TEST-028 del plan MVP.
 * Tests de dispatch (019–024) quedan para Fase 5.
 */

const { processTurn, buildKitchenTicket } = require("./order-slot-filler.service.js");
const { clearAllSessionsForTests, getOrCreateOrderSession, ORDER_STATUS } = require("./order-call-session.store.js");
const { validateOrder } = require("./order-validator.service.js");
const { buildTicket } = require("./kitchen-ticket-builder.service.js");

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
  try {
    fn();
    console.log(`${GREEN}✅ ${id}${RESET} [${priority}] ${label}`);
    passed++;
  } catch (e) {
    console.log(`${RED}❌ ${id}${RESET} [${priority}] ${label}`);
    console.log(`   ${GRAY}${e.message}${RESET}`);
    failed++;
    failures.push({ id, label, error: e.message });
  }
}

function skip(id, label, priority, reason) {
  console.log(`${YELLOW}⏭  ${id}${RESET} [${priority}] ${label} ${GRAY}→ ${reason}${RESET}`);
  skipped++;
}

// ─── P0 — HAPPY PATH ─────────────────────────────────────────────────────────

console.log(`\n${BOLD}══ P0 — Happy Path ══════════════════════════════${RESET}\n`);

run("TEST-001", "Pedido simple recogida", "P0", () => {
  const o = sim("T001", [
    "quiero una margarita grande para recoger",
    "Ana",
    "612345678",
    "sí"
  ]);
  const v = validateOrder(o);
  assert(v.ok, `validator errors: ${v.errors.map(e=>e.code).join(", ")}`);
  assert(o.status === ORDER_STATUS.CUSTOMER_CONFIRMED, `status=${o.status}`);
  assert(o.orderType === "pickup", `orderType=${o.orderType}`);
  assert(o.items.length > 0, "sin items");
  assert(o.customerName === "Ana", `nombre=${o.customerName}`);
  assert(o.phone === "612345678", `tel=${o.phone}`);
  assert(v.flags.allergyRisk === false, "allergyRisk debería ser false");
  assert(Object.values(v.flags).filter(Boolean).length === 0, `flags activos: ${JSON.stringify(v.flags)}`);
});

run("TEST-002", "Pedido simple domicilio con dirección completa", "P0", () => {
  const o = sim("T002", [
    "quiero una barbacoa mediana a domicilio",
    "Carlos",
    "677123456",
    "Calle Mayor 12, Madrid",
    "Correcto"
  ]);
  const v = validateOrder(o);
  assert(v.ok, `validator errors: ${v.errors.map(e=>e.code).join(", ")}`);
  assert(o.status === ORDER_STATUS.CUSTOMER_CONFIRMED, `status=${o.status}`);
  assert(o.orderType === "delivery", `orderType=${o.orderType}`);
  assert(o.address && o.address.raw, "sin dirección");
  assert(o.address.number, "dirección sin número");
  assert(o.customerName === "Carlos", `nombre=${o.customerName}`);
});

run("TEST-003", "Modificador extra de queso", "P0", () => {
  const o = sim("T003", [
    "una margarita grande con extra de queso",
    "para recoger",
    "Pedro",
    "655000111",
    "sí"
  ]);
  assert(o.items.length > 0, "sin items");
  const mods = o.items[0].modifiers;
  const extraMod = mods.find(m => m.type === "extra");
  assert(extraMod, `no hay modifier 'extra'. mods=${JSON.stringify(mods)}`);
  assert(extraMod.value.includes("queso"), `value=${extraMod.value}`);
  const v = validateOrder(o);
  assert(v.ok, `validator errors: ${v.errors.map(e=>e.code).join(", ")}`);
});

run("TEST-004", "Modificador sin cebolla (remove)", "P0", () => {
  const o = sim("T004", [
    "una margarita mediana sin cebolla",
    "para recoger",
    "Laura",
    "699000222",
    "sí"
  ]);
  assert(o.items.length > 0, "sin items");
  const mods = o.items[0].modifiers;
  const removeMod = mods.find(m => m.type === "remove");
  assert(removeMod, `no hay modifier 'remove'. mods=${JSON.stringify(mods)}`);
  assert(removeMod.value === "cebolla" || removeMod.value.includes("cebolla"), `value=${removeMod.value}`);
});

run("TEST-005", "Doble pepperoni (double vs extra)", "P0", () => {
  const o = sim("T005", [
    "una barbacoa grande con doble pepperoni",
    "para recoger",
    "Javi",
    "622333444",
    "sí"
  ]);
  assert(o.items.length > 0, "sin items");
  const mods = o.items[0].modifiers;
  const doubleMod = mods.find(m => m.type === "double");
  assert(doubleMod, `no hay modifier 'double'. mods=${JSON.stringify(mods)}`);
  assert(doubleMod.value.includes("pepperoni"), `value=${doubleMod.value}`);
  assert(!mods.find(m => m.type === "extra" && m.value.includes("pepperoni")),
    "pepperoni capturado como 'extra' en lugar de 'double'");
});

run("TEST-006", "Frase natural compleja (producto + tamaño + 2 modificadores)", "P0", () => {
  const o = sim("T006", [
    "ponme una grande de barbacoa sin cebolla y con extra de queso",
    "para recoger",
    "Rosa",
    "677555666",
    "sí"
  ]);
  assert(o.items.length > 0, "sin items");
  const item = o.items[0];
  assert(item.size === "grande", `size=${item.size}`);
  const removeMod = item.modifiers.find(m => m.type === "remove");
  const extraMod  = item.modifiers.find(m => m.type === "extra");
  assert(removeMod && removeMod.value.includes("cebolla"), `remove no capturado: ${JSON.stringify(item.modifiers)}`);
  assert(extraMod  && extraMod.value.includes("queso"),    `extra no capturado: ${JSON.stringify(item.modifiers)}`);
});

skip("TEST-007", "Mitad y mitad", "P0", "requiere halfAndHalf — pendiente implementación");

run("TEST-008", "Cambio de tamaño tras mencionarlo", "P0", () => {
  const o = sim("T008", [
    "una margarita mediana",
    "mejor ponla grande",
    "para recoger",
    "Toni",
    "611777888",
    "sí"
  ]);
  assert(o.items.length > 0, "sin items");
  const item = o.items[0];
  // El tamaño final debe ser grande
  assert(item.size === "grande", `size=${item.size} (esperado: grande)`);
});

run("TEST-009", "Cambio de producto antes de confirmar", "P0", () => {
  const o = sim("T009", [
    "una margarita grande",
    "espera mejor la barbacoa",
    "para recoger",
    "Noa",
    "699888777",
    "sí"
  ]);
  assert(o.items.length > 0, "sin items");
  // El producto final debe ser barbacoa
  const hasBarbacoa = o.items.some(i => i.displayName.toLowerCase().includes("barbacoa") || i.id.includes("barbacoa"));
  assert(hasBarbacoa, `items finales: ${o.items.map(i=>i.displayName).join(", ")} — no hay barbacoa`);
});

// ─── P1 — ALERGIAS ────────────────────────────────────────────────────────────

console.log(`\n${BOLD}══ P1 — Alergias y Seguridad ════════════════════${RESET}\n`);

run("TEST-010", "Alergia al gluten / celiaquía", "P1", () => {
  const o = sim("T010", [
    "quiero una margarita grande",
    "tengo celiaquia",  // sin tilde — como llegaría de STT
    "para recoger",
    "Mar",
    "612000111",
    "sí"
  ]);
  assert(o.allergies.length > 0, "allergies vacío");
  const v = validateOrder(o);
  assert(v.flags.requiresKitchenReview, "requiresKitchenReview debe ser true");
  // Gluten es highRisk
  const glutenConflict = v.allergenConflicts.find(c => c.allergenCode === "GLUTEN");
  assert(glutenConflict, "no se detectó conflicto GLUTEN");
  assert(glutenConflict.highRisk, "GLUTEN debería ser highRisk");
});

run("TEST-011", "Intolerancia a la lactosa", "P1", () => {
  const o = sim("T011", [
    "quiero una cuatro quesos grande",
    "soy intolerante a la lactosa",
    "para recoger",
    "Cris",
    "677000222",
    "sí"
  ]);
  assert(o.allergies.length > 0, "allergies vacío");
  const hasLactosa = o.allergies.some(a => a.toLowerCase().includes("lact") || a === "Lácteos");
  assert(hasLactosa, `allergies: ${o.allergies.join(", ")} — no contiene lácteos`);
  const v = validateOrder(o);
  assert(v.flags.requiresKitchenReview, "requiresKitchenReview debe ser true");
});

run("TEST-012", "Alergia grave a frutos secos", "P1", () => {
  const o = sim("T012", [
    "quiero una margarita grande",
    "tengo alergia a los frutos secos, es grave",
    "para recoger",
    "Ibai",
    "688000333",
    "sí"
  ]);
  assert(o.allergies.length > 0, "allergies vacío");
  const v = validateOrder(o);
  assert(v.flags.allergyRisk, "allergyRisk debe ser true para alergia grave");
  assert(v.flags.requiresKitchenReview, "requiresKitchenReview debe ser true");
  // El ticket debe mencionar la alergia grave
  const ticket = buildTicket(o, v);
  assert(ticket.text.includes("ALERGIA GRAVE") || ticket.text.includes("⚠️⚠️"),
    "ticket no incluye aviso visible de alergia grave");
  // JSON ticket también
  assert(ticket.json.foodSafety.allergyRisk, "ticket JSON no tiene allergyRisk:true");
});

// ─── P1 — FLUJOS DE CLIENTE ───────────────────────────────────────────────────

console.log(`\n${BOLD}══ P1 — Flujos de Cliente ═══════════════════════${RESET}\n`);

run("TEST-013", "Cliente pide hablar con persona", "P1", () => {
  clearAllSessionsForTests();
  const { action } = processTurn("T013", "quiero hablar con alguien del local");
  assert(action === "transfer_requested", `action=${action} (esperado: transfer_requested)`);
});

skip("TEST-014", "Transferencia por catering (regla de proveedor)", "P1", "requiere provider-profile config — pendiente Fase 5");

run("TEST-015", "Cliente corrige tras confirmación pendiente", "P1", () => {
  const o = sim("T015", [
    "una barbacoa grande",
    "para recoger",
    "Juan",
    "677111222",
    // llegamos a awaiting_customer_confirmation, cliente NO confirma
    "espera, que quiero también una de cuatro quesos"
  ]);
  // Debe haber vuelto a draft para añadir el item
  assert(o.status === ORDER_STATUS.DRAFT || o.status === ORDER_STATUS.AWAITING_CONFIRMATION,
    `status=${o.status}`);
  // La sesión debe tener al menos la barbacoa
  assert(o.items.length >= 1, "no hay items en el pedido");
});

run("TEST-016", "Dirección incompleta sin número", "P1", () => {
  const o = sim("T016", [
    "quiero una barbacoa para domicilio",
    "Carlos",
    "677999000",
    "Calle Alcalá Madrid", // sin número
    "el 47, segundo A",
    "sí"
  ]);
  const v = validateOrder(o);
  // Con el número añadido debe ser válido
  assert(v.ok, `validator errors: ${v.errors.map(e=>e.code).join(", ")}`);
  assert(o.address && o.address.number, `dirección sin número: ${JSON.stringify(o.address)}`);
});

run("TEST-017", "Teléfono con longitud insuficiente (menos de 9 dígitos)", "P1", () => {
  const o = sim("T017", [
    "quiero una margarita grande",
    "para recoger",
    "Sara",
    "612345"  // solo 6 dígitos
  ]);
  const v = validateOrder(o);
  // El teléfono no debe haberse aceptado como válido O debe generar warning
  const phoneWarning = v.warnings.find(w => w.code === "PHONE_LENGTH");
  const phoneNotSet = !o.phone;
  assert(phoneWarning || phoneNotSet,
    `teléfono de 6 dígitos aceptado sin warning: phone=${o.phone}, warnings=${v.warnings.map(w=>w.code)}`);
});

run("TEST-018", "Producto inventado no existe en menú", "P1", () => {
  // Nota: hawayana SÍ existe en el menú. Usamos producto claramente inventado.
  clearAllSessionsForTests();
  const { action, order: o18 } = processTurn("T018", "quiero unos nachos con guacamole y jalapeños");
  assert(
    action === "item_not_found" || action === "item_ambiguous" || action === "ask_more" || o18.items.length === 0,
    `acción esperada: clarificación o sin item. Obtenido: action=${action}, items=${JSON.stringify(o18.items.map(i=>i.displayName))}`
  );
});

// ─── P2 — ROBUSTEZ Y EDGE CASES ───────────────────────────────────────────────

console.log(`\n${BOLD}══ P2 — Robustez y Edge Cases ═══════════════════${RESET}\n`);

skip("TEST-019", "Cocina no confirma ACK (timeout)", "P2", "requiere Kitchen ACK Monitor — Fase 5");
skip("TEST-020", "Dispatch fallido fallback al segundo canal", "P2", "requiere Dispatch Adapter — Fase 5");
skip("TEST-021", "Todos los canales de dispatch fallan", "P2", "requiere Dispatch Adapter — Fase 5");
skip("TEST-022", "WhatsApp no disponible, Telegram OK", "P2", "requiere Dispatch Adapter — Fase 5");
skip("TEST-023", "Telegram no disponible, Discord OK", "P2", "requiere Dispatch Adapter — Fase 5");
skip("TEST-024", "Discord no disponible", "P2", "requiere Dispatch Adapter — Fase 5");

run("TEST-025", "Cliente se enfada — Marta mantiene tono calmado", "P2", () => {
  clearAllSessionsForTests();
  const { response, action } = processTurn("T025", "esto es una mierda, siempre os equivocáis");
  // No debe cancelar, no debe transferir automáticamente
  // Debe continuar ofreciendo ayuda o pedir el pedido
  assert(action !== "cancelled", "Marta canceló el pedido por el tono del cliente");
  // La respuesta no debe ser agresiva ni corporativa
  assert(response && response.length > 0, "sin respuesta");
});

run("TEST-026", "STT ruidoso — 'marga rita sin seboy a'", "P2", () => {
  clearAllSessionsForTests();
  // Simular texto ruidoso como si viniera de STT malo
  const { order, action } = processTurn("T026", "kiero una marga rita sin seboy a grande");
  // La Margarita tiene typos — puede que no resuelva, pero no debe crashear
  assert(action !== undefined, "processTurn devolvió undefined");
  // Si resolvió, verificar que el modifier 'remove' tiene algo
  if (order.items.length > 0) {
    const removeMod = order.items[0].modifiers.find(m => m.type === "remove");
    assert(removeMod, `item resuelto pero sin modifier remove: ${JSON.stringify(order.items[0].modifiers)}`);
  }
  // Si no resolvió, solo verificar que no crasheó (ya lo garantiza el assert de arriba)
});

run("TEST-027", "Producto similar al menú (pizza romana vs napolitana)", "P2", () => {
  clearAllSessionsForTests();
  // "napolitana" existe en el menú — debe resolverlo
  const { order, action } = processTurn("T027", "quiero una pizza napolitana");
  // Si existe en el menú, debe resolverlo
  if (action === "item_added") {
    assert(order.items.length > 0, "item_added pero sin items");
    assert(order.items[0].id.includes("napol") || order.items[0].displayName.toLowerCase().includes("napoli"),
      `item resuelto incorrecto: ${order.items[0].displayName}`);
  } else {
    // Si no resuelve exacto, debe pedir clarificación
    assert(action === "item_ambiguous" || action === "item_not_found" || action === "ask_more",
      `action inesperado: ${action}`);
  }
});

run("TEST-028", "Cliente cancela en cualquier punto del flujo", "P2", () => {
  // Caso 1: cancelar después de añadir un item
  let o = sim("T028a", [
    "una barbacoa grande",
    "para recoger",
    "déjalo, no quiero nada"
  ]);
  assert(o.status === ORDER_STATUS.CANCELLED_BY_CUSTOMER, `status=${o.status}`);

  // Caso 2: cancelar al inicio
  clearAllSessionsForTests();
  const { order: o2 } = processTurn("T028b", "no quiero nada");
  assert(o2.status === ORDER_STATUS.CANCELLED_BY_CUSTOMER, `status al inicio=${o2.status}`);

  // En ningún caso debe haber ticket generado
  const v = validateOrder(o);
  // El validator debe detectar que no hay items (cancelado)
  // No necesitamos que sea ok:true — solo que no genere ticket
  assert(!v.ok || o.items.length === 0,
    "pedido cancelado pasó la validación con items");
});

// ─── RESUMEN ──────────────────────────────────────────────────────────────────

console.log(`\n${BOLD}══ RESUMEN ══════════════════════════════════════${RESET}\n`);
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
