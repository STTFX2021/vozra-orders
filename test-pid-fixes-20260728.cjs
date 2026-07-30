"use strict";

/**
 * Regresiones de los fixes del 2026-07-28 (Vozra PID).
 * Contrato/lógica determinista (no ejecuta el LLM):
 *   1. Alergia: sin "Oye"; lógica retirable/intrínseco; deducir de la descripción.
 *   2. Upselling: detector determinista upsellAlreadyOffered (una sola oferta).
 *   3. Consentimiento: stripConsentIfRegistered elimina la pregunta de guardar datos
 *      para cliente registrado por caller ID (precargado) Y por teléfono dictado.
 *   4. Tiempos: sin ETA inventada; copy "el restaurante te confirmará".
 */

const assert = require("assert");
const {
  buildSystemPrompt,
  upsellAlreadyOffered,
  stripConsentIfRegistered,
  streetOnly,
  registeredCustomerDirective,
  getMenuItemById,
  mapToolItem,
  resolveDeliveryAddress,
  resolvePerPizzaQuantities,
  phoneFromHistory,
  SUBMIT_ORDER_TOOL
} = require("./marta-llm.service.js");
const { estimateTotal, validateOrder } = require("./order-validator.service.js");
const { getOrCreateOrderSession } = require("./order-call-session.store.js");
const { classifyAllergen, removableAllergens } = require("./allergen-ontology.service.js");
const { parseRestrictions, mergeRestrictions } = require("./customer-store.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("✅ " + name); pass++; }
  catch (e) { console.log("❌ " + name + "\n   " + e.message); fail++; }
}

const prompt = buildSystemPrompt();

console.log("══ Fixes 2026-07-28 — contrato de prompt ═════════");

// ── FALLO 1: ALERGIAS ────────────────────────────────────────────────────────
test("F1 el prompt NO enseña a empezar alertas con 'Oye'", () => {
  assert.ok(!/"Oye, la Carbonara/i.test(prompt), "sigue el ejemplo 'Oye, la Carbonara'");
  assert.ok(/NUNCA empieces el aviso con "Oye"/i.test(prompt), "falta la prohibición de 'Oye'");
});
test("F1 no repetir como descubrimiento lo que el cliente declara", () => {
  assert.ok(/NUNCA le repitas como si fuera un descubrimiento/i.test(prompt));
});
test("F1 lógica retirable vs intrínseco presente", () => {
  assert.ok(/RETIRABLE/.test(prompt) && /INTR[IÍ]NSECO/i.test(prompt), "faltan las dos ramas");
  assert.ok(/recomi[eé]ndale otro plato/i.test(prompt), "falta recomendar alternativa en intrínseco");
});
test("F1 regla de apoyo retirable/intrínseco presente", () => {
  assert.ok(/lo que se pone por encima \(un topping\) es retirable/i.test(prompt));
});
test("F1 no afirmar 100% seguro por su cuenta", () => {
  assert.ok(/NO afirmes que un plato es 100% seguro/i.test(prompt));
});
test("F1 PID NUNCA bloquea el pedido por una alergia", () => {
  assert.ok(/SOLO TOMA PEDIDOS/i.test(prompt), "falta la regla madre 'PID solo toma pedidos'");
  assert.ok(/NUNCA bloquees/i.test(prompt), "el prompt no prohíbe bloquear el pedido");
});

// ── FALLO 4: TIEMPOS INVENTADOS ──────────────────────────────────────────────
test("F4 el prompt YA NO manda sumar tiempo de preparación", () => {
  assert.ok(!/s[uú]male el tiempo de preparaci[oó]n/i.test(prompt), "sigue la instrucción de sumar minutos");
});
test("F4 prohíbe inventar minutos/hora", () => {
  assert.ok(/PROHIBIDO inventar minutos/i.test(prompt));
});
test("F4 usa el copy aprobado sin cifras", () => {
  assert.ok(/El restaurante te confirmar[aá] el tiempo estimado/i.test(prompt));
});
test("F4 no dice 'está en camino'", () => {
  assert.ok(/NUNCA digas que est[aá] "en camino"/i.test(prompt));
});

// ── FALLO 2: UPSELLING UNA VEZ (detector determinista) ───────────────────────
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });
test("F2 detecta oferta de bebida", () => {
  assert.strictEqual(upsellAlreadyOffered([A("¿Te pongo algo de beber?")]), true);
});
test("F2 detecta oferta de postre", () => {
  assert.strictEqual(upsellAlreadyOffered([A("¿Te apetece un Tiramisú de postre?")]), true);
});
test("F2 detecta oferta de entrante para compartir", () => {
  assert.strictEqual(upsellAlreadyOffered([A("¿Te pongo un entrante para compartir?")]), true);
});
test("F2 NO dispara en un resumen normal con bebida ya pedida", () => {
  assert.strictEqual(upsellAlreadyOffered([A("Te confirmo: una Carbonara y una Coca-Cola, para recoger. Son diecinueve euros.")]), false);
});
test("F2 NO dispara en saludo ni al tomar platos", () => {
  assert.strictEqual(upsellAlreadyOffered([A("¡Claro! ¿Es para recoger o a domicilio?"), A("Marchando una Diavola.")]), false);
});
test("F2 caso real: ofreció bebida en un turno previo del historial", () => {
  const hist = [A("Marchando."), U("una coca-cola"), A("Perfecto. ¿Algo de beber más para acompañar?")];
  assert.strictEqual(upsellAlreadyOffered(hist), true);
});
test("F2 el prompt mantiene 'EXACTAMENTE UNA vez'", () => {
  assert.ok(/EXACTAMENTE UNA vez/i.test(prompt));
});

// ── FALLO 3: CONSENTIMIENTO — cliente registrado NUNCA oye la pregunta ────────
const CONSENT = "Perfecto, Samuel. Por último, ¿quieres que guarde tu nombre y tu dirección para la próxima vez? Solo si me das permiso.";
const NEUTRAL = "Perfecto, Samuel. Te confirmo el pedido, son diecinueve euros. ¿Lo cierro así?";
function tieneConsentimiento(t) { return /guarde tu|guarde tus datos|me das permiso/i.test(t); }

test("F3-A cliente reconocido por CALLER ID (precargado) NO oye la pregunta", () => {
  const s = getOrCreateOrderSession("test-callerid-A");
  s.registeredName = "Samuel"; s.registeredPreloaded = true;
  const out = stripConsentIfRegistered(CONSENT, "test-callerid-A");
  assert.ok(!tieneConsentimiento(out), "la pregunta de consentimiento sigue presente: " + out);
});
test("F3-B cliente encontrado tras DICTAR el teléfono NO oye la pregunta", () => {
  const s = getOrCreateOrderSession("test-dictado-B");
  s.registeredName = "Ana"; // set por buscar_cliente en el bucle de tools
  const out = stripConsentIfRegistered(CONSENT, "test-dictado-B");
  assert.ok(!tieneConsentimiento(out), "la pregunta de consentimiento sigue presente: " + out);
});
test("F3-neg cliente NUEVO (no registrado) SÍ conserva la pregunta", () => {
  const out = stripConsentIfRegistered(CONSENT, "test-nuevo-C"); // sesión sin registeredName
  assert.ok(tieneConsentimiento(out), "no debería tocar el turno de un cliente nuevo");
});
test("F3 no altera un turno neutro de un cliente registrado", () => {
  const s = getOrCreateOrderSession("test-neutro-D");
  s.registeredName = "Samuel";
  const out = stripConsentIfRegistered(NEUTRAL, "test-neutro-D");
  assert.ok(/te confirmo el pedido/i.test(out), "borró texto legítimo: " + out);
});

// ── RECONOCIMIENTO: saludo por nombre + confirmar SOLO la calle (primera línea) ──
test("F5 streetOnly extrae la calle en varios formatos", () => {
  assert.strictEqual(streetOnly("Calle Alpandeire número 3, Urbanización Ribera Luar, bloque 1, primero B"), "Calle Alpandeire");
  assert.strictEqual(streetOnly("Avenida Andalucía nº 7"), "Avenida Andalucía");
  assert.strictEqual(streetOnly("Plaza Mayor, 4"), "Plaza Mayor");
  assert.strictEqual(streetOnly("Calle Sol"), "Calle Sol");
});
test("F5 la directiva reconoce por nombre y nombra SOLO la calle", () => {
  const d = registeredCustomerDirective("Samuel Tineo", "Calle Alpandeire número 3, Urbanización Ribera Luar, bloque 1, primero B");
  assert.ok(/Aquí estás, Samuel/i.test(d), "no saluda por nombre 'Aquí estás, Samuel'");
  assert.ok(/Calle Alpandeire/.test(d), "no nombra la calle");
  assert.ok(/la de siempre/i.test(d), "falta la coletilla 'la de siempre'");
});
test("F5 la directiva NUNCA verbaliza número/piso (privacidad)", () => {
  const d = registeredCustomerDirective("Samuel Tineo", "Calle Alpandeire número 3, Urbanización Ribera Luar, bloque 1, primero B");
  assert.ok(!/número 3|primero B|bloque 1|Ribera Luar/i.test(d), "se cuela el número/piso en la directiva");
});

// ── ONTOLOGÍA DE ALÉRGENOS (clasificador determinista por reglas) ────────────
const pizzaMar = { id: "x_pizza", category: "pizza_speciale", description: "Tomate, rúcula, langostinos y aceitunas", knownAllergens: ["gluten", "dairy", "shellfish"] };
const pastaMar = { id: "x_pasta", category: "pasta_risotto", description: "Espaguetis con frutos del mar", knownAllergens: ["gluten", "shellfish", "molluscs"] };
const conPesto = { id: "x_pesto", category: "pasta_risotto", description: "Trofie al pesto con piñones", knownAllergens: ["gluten", "nuts"] };
const pizzaNuez = { id: "x_pnut", category: "pizza_bianca", description: "Mortadela con pistacho por encima", knownAllergens: ["nuts"] };

test("ONTO marisco en PIZZA es retirable", () => {
  assert.strictEqual(classifyAllergen(pizzaMar, "shellfish").removable, true);
});
test("ONTO marisco en PASTA/RISOTTO es intrínseco", () => {
  assert.strictEqual(classifyAllergen(pastaMar, "shellfish").removable, false);
});
test("ONTO gluten y lácteo SIEMPRE intrínsecos", () => {
  assert.strictEqual(classifyAllergen(pizzaMar, "gluten").removable, false);
  assert.strictEqual(classifyAllergen(pizzaMar, "dairy").removable, false);
});
test("ONTO frutos secos: en pesto intrínseco, por encima retirable", () => {
  assert.strictEqual(classifyAllergen(conPesto, "nuts").removable, false);
  assert.strictEqual(classifyAllergen(pizzaNuez, "nuts").removable, true);
});
test("ONTO removableAllergens solo lista los retirables", () => {
  const rem = removableAllergens(pizzaMar);
  assert.ok(rem.includes("shellfish") && !rem.includes("gluten") && !rem.includes("dairy"));
});
test("ONTO datos REALES del menú: Abruzzo langostinos retirable, frutti di mare no", () => {
  const abruzzo = getMenuItemById("pizza_abruzzo");
  const frutti = getMenuItemById("spaghetti_frutti_di_mare");
  assert.ok(abruzzo && frutti, "no se encontraron los platos reales en la taxonomía");
  assert.strictEqual(classifyAllergen(abruzzo, "shellfish").removable, true);
  assert.strictEqual(classifyAllergen(frutti, "shellfish").removable, false);
});
test("F1 el prompt usa el dato '(se puede quitar)' de la carta", () => {
  assert.ok(/se puede quitar/i.test(prompt), "el prompt no referencia la marca de retirable");
});

// ── PERFIL: preferencias y restricciones (alergias guardadas) ────────────────
test("F6 parseRestrictions normaliza jsonb/string/null a {allergies,preferences}", () => {
  assert.deepStrictEqual(parseRestrictions('{"allergies":["marisco"],"preferences":[]}'), { allergies: ["marisco"], preferences: [] });
  assert.deepStrictEqual(parseRestrictions(null), { allergies: [], preferences: [] });
});
test("F6 mergeRestrictions acumula sin duplicar (case-insensitive)", () => {
  const m = mergeRestrictions({ allergies: ["marisco"] }, { allergies: ["Marisco", "gluten"] });
  assert.deepStrictEqual(m.allergies, ["marisco", "gluten"]);
});
test("F6 mergeRestrictions parte de perfil vacío", () => {
  assert.deepStrictEqual(mergeRestrictions(null, { allergies: ["frutos secos"] }).allergies, ["frutos secos"]);
});

// ── PIZZA MITAD Y MITAD (se cobra la más cara) ───────────────────────────────
test("F7 mitad y mitad: precio = la pizza MÁS CARA", () => {
  const a = getMenuItemById("pizza_abruzzo"), b = getMenuItemById("pizza_margherita");
  assert.ok(a && b, "faltan las pizzas de referencia en la carta");
  const expected = Math.max(a.price, b.price);
  const item = mapToolItem({ half_and_half: ["pizza_abruzzo", "pizza_margherita"], quantity: 1 });
  assert.ok(item.halfAndHalf, "no se marcó como half_and_half");
  assert.strictEqual(item.price, expected, "el precio no es el de la más cara");
  assert.strictEqual(estimateTotal({ items: [item] }).estimatedTotal, expected, "el total no coincide");
  assert.ok(/mitad/i.test(item.displayName), "el nombre no indica 'mitad'");
});
test("F7 mitad y mitad: cruza las alergias de LAS DOS mitades (no bloquea)", () => {
  const item = mapToolItem({ half_and_half: ["pizza_abruzzo", "pizza_margherita"], quantity: 1 });
  const v = validateOrder({ items: [item], orderType: "pickup", customerName: "Ana", phone: "622333444", allergies: ["marisco"] });
  assert.strictEqual(v.flags.requiresKitchenReview, true, "no detectó el marisco de la mitad Abruzzo");
  assert.strictEqual(v.ok, true, "la alergia no debe bloquear (solo anota)");
});

// ── DIRECCIÓN DE DOMICILIO (número) + "una por pizza"/"piso" ──────────────────
test("F8 registrado sin número en el turno → usa la dirección guardada (con número)", () => {
  const saved = "Calle Alpandeire número 3, Ribera Luar, bloque 1, primero B";
  const da = resolveDeliveryAddress("Calle Alpandeire", saved);
  assert.strictEqual(da.raw, saved);
  assert.strictEqual(da.number, "3");
});
test("F8 el cliente cambia la dirección (con número) → usa esa", () => {
  assert.strictEqual(resolveDeliveryAddress("Avenida del Mar 25", "Calle Vieja 1").number, "25");
});
test("F8 nueva sin número y sin guardada → number null (se pedirá el número)", () => {
  assert.strictEqual(resolveDeliveryAddress("Calle Sol", null).number, null);
});
test("F8 'una para cada piso' (STT de pizza) deriva las bebidas por nº de pizzas", () => {
  const args = { items: [
    { menu_item_id: "pizza_diavola", quantity: 1 },
    { menu_item_id: "pizza_margherita", quantity: 1 },
    { menu_item_id: "pizza_abruzzo", quantity: 1 },
    { menu_item_id: "coca_cola", quantity: 1 }
  ]};
  const out = resolvePerPizzaQuantities(args, [{ role: "user", content: "ponme una coca cola para cada piso" }]);
  const coke = out.items.find(i => i.menu_item_id === "coca_cola");
  assert.strictEqual(coke.quantity, 3, "no derivó 3 bebidas de 3 pizzas");
});

// ── RECONOCIMIENTO PERSISTE AUNQUE EL callId CAMBIE (teléfono en el historial) ──
test("F9 encuentra el teléfono aunque NO sea el último turno", () => {
  const h = [
    { role: "assistant", content: "¿Teléfono?" },
    { role: "user", content: "el 611223225" },
    { role: "assistant", content: "Aquí estás, Juan" },
    { role: "user", content: "correcto" },
    { role: "user", content: "una B&B y una Ludi" },
    { role: "user", content: "sí, por favor" }
  ];
  assert.strictEqual(phoneFromHistory(h), "611223225");
});
test("F9 acepta el teléfono con separadores y sin él da null", () => {
  assert.strictEqual(phoneFromHistory([{ role: "user", content: "el 611 223 225" }]), "611223225");
  assert.strictEqual(phoneFromHistory([{ role: "user", content: "ponme 2 pizzas y 3 cocacolas" }]), null);
});

// ── CONTRATO submit_order: nombre no obligatorio + poder borrar alergia ──────
test("F10 customer_name NO es obligatorio (cliente registrado no falla)", () => {
  const req = SUBMIT_ORDER_TOOL.function.parameters.required;
  assert.ok(!req.includes("customer_name"), "customer_name no debe ser obligatorio");
  assert.ok(req.includes("items") && req.includes("order_type") && req.includes("phone"));
});
test("F10 submit_order acepta removed_allergies (borrar alergia guardada)", () => {
  assert.ok(SUBMIT_ORDER_TOOL.function.parameters.properties.removed_allergies, "falta removed_allergies");
});

console.log("══ RESUMEN ═══════════════════════════════════════");
console.log("✅ Pasados: " + pass + "   ❌ Fallidos: " + fail);
process.exit(fail ? 1 : 0);
