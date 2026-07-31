"use strict";
/**
 * Vozra PID — Test del cierre de llamada determinista (end_call).
 *
 * Lógica: cuando el pedido ya está confirmado (flag de sesión farewellArmed) y el
 * cliente se despide, el backend NO llama al LLM: da una despedida corta y emite
 * un tool_call `end_call` en el stream para que ElevenLabs cuelgue.
 *
 * Aquí probamos las dos piezas puras: el detector isFarewell y el formato del
 * stream con end_call (nombre y parámetros correctos para ElevenLabs).
 */
const assert = require("assert");
const router = require("./elevenlabs-llm.routes.js");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " → " + e.message); }
}

const F = router._isFarewell;

// Despedidas → true
["gracias", "muchas gracias", "hasta luego", "adiós", "chao", "ciao",
 "nada más, gracias", "eso es todo", "ya está", "vale gracias", "no, gracias",
 "perfecto gracias", "muchas gracias, hasta luego"].forEach(s => {
  t("isFarewell TRUE: '" + s + "'", () => assert.strictEqual(F(s), true));
});

// NO despedidas (sigue operando) → false
["añade una coca-cola", "espera, cambia la Abruzzo", "ponme otra pizza",
 "también quiero postre", "mejor quítame la burrata", "¿me añades pan?",
 ""].forEach(s => {
  t("isFarewell FALSE: '" + s + "'", () => assert.strictEqual(F(s), false));
});

// El stream con end_call tiene el formato correcto que ElevenLabs espera.
t("end_call: emite tool_call name=end_call con reason", () => {
  const chunks = [];
  const fakeRes = {
    status() { return this; }, setHeader() {}, flushHeaders() {},
    write(s) { chunks.push(s); }, end() {}
  };
  router._sendStreamResponseWithEndCall(fakeRes, "¡Hasta pronto!", "id-1", "vozra-marta-orders", "cliente se despidió");
  const raw = chunks.join("");
  assert.ok(/"content":"[^"]*Hasta pronto/.test(raw), "debe hablar la despedida");
  assert.ok(/"name":"end_call"/.test(raw), "debe llamar a end_call");
  assert.ok(/"finish_reason":"tool_calls"/.test(raw), "debe cerrar con finish_reason tool_calls");
  // El campo arguments es un JSON string (doblemente escapado), tal como espera ElevenLabs.
  assert.ok(raw.includes("cliente se despidió"), "debe incluir el reason en arguments");
  assert.ok(/arguments/.test(raw) && /reason/.test(raw), "arguments debe llevar reason");
  assert.ok(/data: \[DONE\]/.test(raw), "debe terminar el stream");
});

console.log("\n" + pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
