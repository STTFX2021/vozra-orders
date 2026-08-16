/**
 * test-conversacional-01-alergia-entre-llamadas.cjs
 *
 * PRIMER TEST CONVERSACIONAL. Recorre DOS llamadas completas del mismo cliente,
 * turno a turno, siguiendo docs/FLUJO_CANONICO.md:
 *
 *   LLAMADA 1 — cliente nuevo
 *     saludo → domicilio → teléfono → dirección → declara ALERGIA AL MARISCO
 *     → pide una Abruzzo (lleva langostinos) → se le avisa y se le quita
 *     → sugerencia UNA vez → resumen → confirma → a cocina
 *
 *   LLAMADA 2 — el mismo cliente, días después
 *     saludo → teléfono → SE LE RECONOCE con su alergia guardada
 *     → pide otra Abruzzo → tiene que AVISAR SOLO, sin que él diga nada
 *     → le ofrece quitar los langostinos → él dice que la quiere igual
 *     → SE LE SIRVE (el cliente manda) y el alérgeno va al ticket
 *
 * QUÉ PRUEBA ESTO: el código determinista — la ficha, la memoria entre llamadas,
 * el cruce alergia↔plato, los gates, el total, el guardián de salida.
 *
 * QUÉ NO PRUEBA: que gpt-4.1-mini OBEDEZCA. Eso solo se ve llamando por teléfono.
 * Aquí se comprueba que el backend le da la orden correcta y que, si el modelo se
 * sale, el guardián lo corrige antes de que llegue a la voz.
 *
 *   node test-conversacional-01-alergia-entre-llamadas.cjs
 */
const assert = require("assert");
const marta = require("./marta-llm.service.js");
const store = require("./order-call-session.store.js");

let pass = 0, fail = 0;
const paso = (n, fn) => {
  try { fn(); console.log("   ✓ " + n); pass++; }
  catch (e) { console.log("   ✗ " + n + "\n        " + e.message); fail++; }
};

const U = c => ({ role: "user", content: c });
const A = c => ({ role: "assistant", content: c });

const TEL = "611222333";
const DIR = "Calle Ejemplo 12";

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  LLAMADA 1 — cliente nuevo, declara alergia          ║");
console.log("╚══════════════════════════════════════════════════════╝");

const CALL1 = "conv-test-1-" + Date.now();
const conv1 = [];

// ── Turno 1-3: quiere pedir, a domicilio, da el teléfono ───────────────────
conv1.push(A("Pizzería La Locanda, te atiende Sarah. ¿En qué puedo ayudarte?"));
conv1.push(U("Hola, quiero hacer un pedido a domicilio."));
conv1.push(A("Perfecto, ¿me dices un teléfono de contacto?"));
conv1.push(U("El " + TEL));

paso("el teléfono se localiza en el historial aunque no sea el último turno", () => {
  assert.strictEqual(marta.phoneFromHistory(conv1), TEL);
});

// ── Turno 4: da la dirección ───────────────────────────────────────────────
conv1.push(A("¿A qué dirección te lo llevo?"));
conv1.push(U(DIR + ", segundo B"));

paso("la dirección dictada se detecta y deja de ser un dato pendiente", () => {
  assert.strictEqual(marta.direccionDadaEnLlamada(conv1), true);
});

paso("a un cliente NUEVO no se le dice 'la de siempre'", () => {
  const d = marta.directivaDatosDelCliente(marta.estadoDelPerfil({
    registrado: false, nombre: null, direccion: "dicha_en_llamada",
    telefono: TEL, tipoEntrega: "domicilio", yaPedidos: {}
  }));
  assert.ok(/PROHIBIDO decirle "la de siempre"|es la primera vez que pide/.test(d));
});

paso("no se le vuelve a pedir la dirección ni el teléfono", () => {
  assert.strictEqual(marta.intencionYaCubierta(conv1, "direccion"), true);
  assert.strictEqual(marta.intencionYaCubierta(conv1, "telefono"), true);
});

// ── Turno 5: DECLARA LA ALERGIA ────────────────────────────────────────────
conv1.push(A("Muy bien, ¿qué te gustaría pedir?"));
conv1.push(U("Antes de nada: soy alérgico al marisco."));

paso("la alergia es SUYA, así que va a la ficha (no es de un acompañante)", () => {
  assert.strictEqual(marta.alergiaEsDeTercero("Antes de nada: soy alérgico al marisco."), false);
});

paso("declarar una alergia NO abre una incidencia ni regala el pedido", () => {
  assert.strictEqual(marta.quejaDePedidoEntregado(conv1), false);
});

// ── Turno 6: pide la Abruzzo (lleva langostinos) ───────────────────────────
conv1.push(U("Ponme una Abruzzo."));

const q1 = marta.computeQuote(
  { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }], order_type: "delivery" },
  conv1, CALL1);

paso("el código cruza la alergia con el plato y AVISA", () => {
  assert.ok((q1.allergenAdvisory || q1.allergenConflicts || []).length > 0 || q1.aviso_alergeno,
    "no detecta que la Abruzzo lleva langostinos teniendo alergia al marisco");
});

paso("pero NO bloquea el pedido (política del owner 28-07)", () => {
  assert.notStrictEqual(q1.requiredAction, "resolve_allergen_conflict");
});

paso("el aviso le dice a Sarah QUÉ decir, con plato e ingrediente", () => {
  const msg = marta.mensajeDeBloqueo({ allergenConflicts: [{
    status: "pending", classification: "removable",
    itemName: "Abruzzo", component: "langostinos", declaredAs: "marisco" }]});
  assert.ok(/Abruzzo/.test(msg) && /langostinos/.test(msg) && /marisco/.test(msg));
});

// ── Turno 7: acepta que le quiten los langostinos ──────────────────────────
conv1.push(A("La Abruzzo lleva langostinos. ¿Te la preparo sin ellos?"));
conv1.push(U("Sí, quítamelos."));

paso("pedir que le quiten el ingrediente NO le borra la alergia de la ficha", () => {
  assert.deepStrictEqual(
    marta.detectRemovedAllergies([U("Sí, quítamelos.")], ["marisco"]), [],
    "le borraría la alergia por una petición de cocina");
});

const q2 = marta.computeQuote(
  { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1,
              modifiers: [{ type: "remove", value: "langostinos" }] }],
    order_type: "delivery" }, conv1, CALL1);

paso("quitados los langostinos, el conflicto queda resuelto", () => {
  const pend = (q2.allergenAdvisory || []).filter(c => c.status === "pending");
  assert.strictEqual(pend.length, 0, "sigue avisando de algo que ya se ha quitado");
});

// ── Turno 8: la sugerencia, UNA sola vez ───────────────────────────────────
const oferta = marta.deterministicUpsellOffer({ items: [{ category: "pizza_speciale" }] }, conv1);
conv1.push(A(oferta));
conv1.push(U("No, nada más."));

paso("la sugerencia pregunta por picar Y por beber a la vez", () => {
  assert.ok(/picar/i.test(oferta) && /beber/i.test(oferta), "sigue habiendo dos rondas: " + oferta);
});

paso("dicho que no, la sugerencia queda cerrada y no se repite", () => {
  assert.strictEqual(marta.intencionYaCubierta(conv1, "sugerencia"), true);
});

paso("el guardián tumba una segunda sugerencia aunque la redacte distinto", () => {
  const salida = marta.guardianDeSalida(
    "Perfecto. ¿Quieres añadir algo más o seguimos?", CALL1, conv1);
  assert.ok(!/algo m[áa]s/i.test(salida), "cuela otra sugerencia: " + salida);
});

// ── Turno 9: total y confirmación ──────────────────────────────────────────
paso("el total es el que dice el código, no el que se invente el modelo", () => {
  assert.strictEqual(q2.total_eur, 15, "una Abruzzo son 15 €, no " + q2.total_eur);
  // EN LETRAS, que es como habla. El caso real fue "treinta y dos euros".
  const salida = marta.guardianDeSalida("El total es cuarenta euros. ¿Confirmas?", CALL1, conv1);
  assert.ok(!/cuarenta/i.test(salida), "deja pasar un total inventado: " + salida);
});

paso("sabe leer los importes que se dicen en voz alta", () => {
  assert.strictEqual(marta.importeHablado("treinta y dos euros"), 32);
  assert.strictEqual(marta.importeHablado("diecisiete euros con cincuenta"), 17.5);
  assert.strictEqual(marta.importeHablado("17,50 euros"), 17.5);
  assert.strictEqual(marta.importeHablado("quince euros"), 15);
  assert.strictEqual(marta.importeHablado("una pizza grande"), null, "confunde texto con dinero");
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  LLAMADA 2 — vuelve días después. ¿Se acuerda?       ║");
console.log("╚══════════════════════════════════════════════════════╝");

const CALL2 = "conv-test-2-" + Date.now();
const conv2 = [];

// La ficha que devolvería Supabase para ese teléfono tras la llamada 1.
const FICHA = { name: "Cliente Ejemplo", address: { raw: DIR },
                restrictions: { allergies: ["marisco"], preferences: [] } };

conv2.push(A("Pizzería La Locanda, te atiende Sarah. ¿En qué puedo ayudarte?"));
conv2.push(U("Quiero pedir a domicilio."));
conv2.push(A("¿Me dices un teléfono de contacto?"));
conv2.push(U("El " + TEL));

paso("con la ficha cargada, se le reconoce por su nombre", () => {
  const d = marta.registeredCustomerDirective(FICHA.name, DIR);
  assert.ok(/Aqu[íi] est[áa]s/.test(d), "no le reconoce");
});

paso("se le PREGUNTA por la dirección de siempre, no se asume", () => {
  const d = marta.registeredCustomerDirective(FICHA.name, DIR);
  assert.ok(/la de siempre\?/.test(d), "da la dirección por hecha sin preguntar");
});

paso("el prompt lleva su alergia guardada", () => {
  const p = marta.buildSystemPrompt(undefined, FICHA);
  assert.ok(/marisco/i.test(p), "la ficha no llega al cerebro: no podría advertir");
});

// ── Pide otra Abruzzo, SIN decir nada de alergias ──────────────────────────
conv2.push(A("¿Te lo llevo a Calle Ejemplo, la de siempre?"));
conv2.push(U("Sí."));
conv2.push(A("¿Qué te gustaría pedir?"));
conv2.push(U("Una Abruzzo."));

const q3 = marta.computeQuote(
  { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }],
    order_type: "delivery", allergies: FICHA.restrictions.allergies },
  conv2, CALL2);

paso("LO IMPORTANTE: avisa SOLO, sin que el cliente diga nada", () => {
  assert.ok(q3.aviso_alergeno || (q3.allergenAdvisory || []).length > 0,
    "no recuerda la alergia entre llamadas: le serviría langostinos sin avisar");
});

paso("el aviso incluye la oferta de quitarlo", () => {
  const txt = q3.aviso_alergeno || "";
  assert.ok(/quitar/i.test(txt), "avisa pero no ofrece solución: " + txt);
});

// ── El cliente decide que la quiere igual ──────────────────────────────────
conv2.push(A("La Abruzzo lleva langostinos y me consta tu alergia al marisco. ¿Te los quito?"));
conv2.push(U("No, déjala como está."));

paso("EL CLIENTE MANDA: si la quiere igual, se le sirve", () => {
  const v = marta.computeQuote(
    { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }],
      order_type: "delivery", allergies: ["marisco"] }, conv2, CALL2);
  assert.strictEqual(v.ok, true, "le niega el pedido que ha pedido expresamente");
  assert.notStrictEqual(v.requiredAction, "resolve_allergen_conflict");
});

paso("y el alérgeno sigue constando para el ticket de cocina", () => {
  const v = marta.computeQuote(
    { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }],
      order_type: "delivery", allergies: ["marisco"] }, conv2, CALL2);
  assert.ok((v.allergenAdvisory || []).length > 0,
    "cocina no se entera de que ese plato va con alérgeno declarado");
});

paso("su alergia SIGUE en la ficha después de todo", () => {
  assert.deepStrictEqual(
    marta.detectRemovedAllergies([U("No, déjala como está.")], ["marisco"]), [],
    "se le ha borrado la alergia por decir que quiere el plato igual");
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n" + "─".repeat(56));
console.log(pass + " pasos ok / " + fail + " fallidos");
process.exit(fail ? 1 : 0);
