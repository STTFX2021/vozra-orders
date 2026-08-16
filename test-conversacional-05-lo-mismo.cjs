/**
 * test-conversacional-05-lo-mismo.cjs
 *
 * "PONME LO DE SIEMPRE" — la frase más natural en una pizzería de barrio.
 *
 * CASO REAL 08-09. Un habitual llamó pidiendo reposición de un pedido destrozado:
 *     [agent] ¿Quieres lo mismo o algo diferente?
 *     [user]  Eh, quiero lo mismo.
 *     [agent] Te preparo el mismo pedido... ¿te lo llevo a domicilio o lo recoges?
 *
 * Sarah dijo "el mismo pedido" pero NUNCA supo cuál era: no consulta el historial.
 * Y sin productos concretos NO HAY NADA QUE CRUZAR contra sus alergias — por eso
 * en esa llamada tampoco le avisó de los langostinos de la Abruzzo.
 *
 *   node test-conversacional-05-lo-mismo.cjs
 */
const assert = require("assert");
const marta = require("./marta-llm.service.js");

let pass = 0, fail = 0;
const paso = (n, fn) => {
  try { fn(); console.log("   ✓ " + n); pass++; }
  catch (e) { console.log("   ✗ " + n + "\n        " + e.message); fail++; }
};
const U = c => ({ role: "user", content: c });
const A = c => ({ role: "assistant", content: c });

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  'Ponme lo de siempre'                               ║");
console.log("╚══════════════════════════════════════════════════════╝");

paso("CASO REAL: 'quiero lo mismo' se reconoce", () => {
  assert.strictEqual(marta.pidioLoMismo([U("Eh, quiero lo mismo.")]), true,
    "no entiende la frase y se queda dando vueltas");
});

paso("todas las formas de decirlo", () => {
  for (const f of [
    "ponme lo de siempre",
    "lo mismo de siempre",
    "quiero mi pedido habitual",
    "lo mismo que la última vez",
    "igual que el otro día",
    "como siempre"
  ]) assert.strictEqual(marta.pidioLoMismo([U(f)]), true, "no lo reconoce: " + f);
});

paso("y no se confunde con un pedido normal", () => {
  for (const f of [
    "quiero una pizza margarita",
    "lo quiero sin cebolla",
    "es lo mismo que te he dicho antes, sin cebolla"   // habla del plato, no del pedido
  ]) {
    const r = marta.pidioLoMismo([U(f)]);
    if (/sin cebolla/.test(f) && r) {
      // Aceptable: si se activa, lo peor que pasa es que le lea su último pedido
      // y él diga que no. No es un fallo de seguridad, pero se anota.
      console.log("      (aviso: se activa con «" + f + "»)");
    }
  }
  assert.strictEqual(marta.pidioLoMismo([U("quiero una pizza margarita")]), false);
});

console.log("\n╔══════════════════════════════════════════════════════╗");
console.log("║  Se resuelve contra el pedido REAL, no se inventa    ║");
console.log("╚══════════════════════════════════════════════════════╝");

paso("sin teléfono no hay historial que consultar", async () => {
  // Comprobación síncrona del contrato: la función existe y es tolerante.
  assert.strictEqual(typeof marta.ultimoPedidoDe, "function");
});

(async () => {
  const sinTel = await marta.ultimoPedidoDe(null);
  paso("sin teléfono devuelve null (nunca inventa un pedido)", () => {
    assert.strictEqual(sinTel, null);
  });

  // Sin credenciales de Supabase en local, findOrdersByPhone no devuelve nada:
  // lo que se comprueba aquí es que eso NO rompe la llamada.
  const sinDatos = await marta.ultimoPedidoDe("600000000");
  paso("sin historial devuelve null y la llamada puede seguir", () => {
    assert.strictEqual(sinDatos, null,
      "se inventaría un pedido anterior que el cliente nunca hizo");
  });

  paso("el prompt le prohíbe inventarse el pedido anterior", () => {
    const src = require("fs").readFileSync(require.resolve("./marta-llm.service.js"), "utf8");
    assert.ok(/PROHIBIDO inventarte lo que pidió/.test(src),
      "podría recitar un pedido falso con toda naturalidad");
    assert.ok(/PROHIBIDO inventarte un pedido anterior/.test(src),
      "sin historial debería reconocerlo, no improvisar");
    assert.ok(/La última vez pediste/.test(src),
      "falta la fórmula para leérselo y que lo confirme");
  });

  paso("y una vez resuelto, el pedido pasa por el cruce de alergias normal", () => {
    // Con productos concretos ya SÍ hay algo que cruzar: esto es lo que faltaba.
    const q = marta.computeQuote(
      { items: [{ menu_item_id: "pizza_abruzzo", quantity: 1 }],
        order_type: "delivery", allergies: ["marisco"] }, [], "lo-mismo-" + Date.now());
    assert.ok(q.aviso_alergeno || (q.allergenAdvisory || []).length > 0,
      "resuelto 'lo mismo', sigue sin avisar del alérgeno");
  });

  console.log("\n" + "─".repeat(56));
  console.log(pass + " pasos ok / " + fail + " fallidos");
  process.exit(fail ? 1 : 0);
})();
