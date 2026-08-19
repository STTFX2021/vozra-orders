/**
 * CONFIG DE ELEVENLABS EN GIT — invariantes del panel (19-08)
 *
 * Hasta hoy el prompt y los ajustes del agente Sarah vivían FUERA de git y FUERA de
 * los tests: cualquiera podía cambiarlos desde el panel y romper producción con la
 * suite en verde. Pasó de verdad el 18-08 (el first_message).
 *
 * Este test NO llama a la API (no necesita credenciales ni red): comprueba que el
 * fichero versionado sigue diciendo lo que sam decidió. Para comparar el fichero
 * con el agente REAL: node elevenlabs/publicar-agente.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function test(nombre, fn) {
  try { fn(); console.log("  ok  " + nombre); pass++; }
  catch (e) { console.log("  FAIL " + nombre + "\n       " + (e.message || e).split("\n")[0]); fail++; }
}

const DIR = path.join(__dirname, "elevenlabs");
const RAW = fs.readFileSync(path.join(DIR, "agent-sarah.config.json"), "utf8");
const cfg = JSON.parse(RAW);
const prompt = fs.readFileSync(path.join(DIR, "prompt-sarah.md"), "utf8");
const agent = cfg.conversation_config.agent;

console.log("\n══ Config de ElevenLabs: versionada y protegida ══");

// ── Lo primero: que no se cuele un secreto en git ──────────────────────────
test("CRÍTICO: el fichero NO contiene ningún secreto en claro", () => {
  assert.ok(!/sk_[a-f0-9]{20,}/i.test(RAW), "hay una clave sk_… en el fichero versionado");
  assert.ok(!/xi-api-key\s*[:=]\s*["'][^"'$]/i.test(RAW), "hay una API key en claro");
  assert.ok(/\$\{ELEVENLABS_CUSTOM_LLM_SECRET\}/.test(RAW),
    "el secreto del backend debe quedar como variable, no como valor");
});

// ── Decisiones de sam que NO se tocan ──────────────────────────────────────
test("DECISIÓN DE SAM: el first_message va SIN espacios (a propósito)", () => {
  // Con espacios normales el saludo suena lento y sam ya se había quejado. Los
  // espacios que faltan son un truco de TTS, no una errata. El 18-08 lo "arreglé"
  // sin saberlo y estuvo así en producción varias horas.
  assert.strictEqual(agent.first_message, "PizzeriaLaLocandaCancelada,te atiende Sarah¿enqué puedoayudarte?");
});

test("temperature 0.25: tomar pedidos es determinista, no creativo", () => {
  assert.strictEqual(agent.prompt.temperature, 0.25);
  assert.ok(agent.prompt.temperature <= 0.3, "por encima de 0.3 vuelve la inconsistencia");
});

test("Backup LLM DESACTIVADO (era la causa de los fillers en inglés)", () => {
  assert.strictEqual(agent.prompt.backup_llm_config.preference, "disabled");
});

test("la tool End Call está activa (si no, Sarah no puede colgar)", () => {
  assert.ok(agent.prompt.built_in_tools.end_call, "sin end_call la llamada no se cierra");
  assert.strictEqual(agent.prompt.built_in_tools.end_call.params.system_tool_type, "end_call");
});

test("Speculative turn OFF", () => {
  assert.strictEqual(cfg.conversation_config.turn.speculative_turn, false);
});

test("como mucho DOS rellenos por generación", () => {
  const st = cfg.conversation_config.turn.soft_timeout_config;
  assert.strictEqual(st.max_soft_timeouts_per_generation, 2);
  // El API fuerza el máximo al número de frases disponibles: 1 principal + N extra.
  assert.strictEqual(st.additional_soft_timeout_messages.length, 1,
    "con más frases de relleno el API sube el máximo por su cuenta");
});

// ── El cerebro sigue siendo el backend ─────────────────────────────────────
test("EL QUE IMPORTA: el cerebro sigue apuntando a nuestro backend", () => {
  assert.strictEqual(agent.prompt.llm, "custom-llm");
  assert.strictEqual(agent.prompt.custom_llm.url, "https://vozra-orders-production.up.railway.app/v1");
  assert.strictEqual(agent.prompt.custom_llm.model_id, "vozra-marta-orders");
});

// ── El prompt del panel es ESTILO, no decisión ─────────────────────────────
test("el prompt cede toda la autoridad al Custom LLM", () => {
  assert.ok(/único cerebro conversacional/.test(prompt), "el prompt no cede la autoridad");
  assert.ok(/No hagas preguntas por iniciativa propia/.test(prompt));
  assert.ok(/No inventes ni completes información/.test(prompt));
});

test("el prompt NO lleva carta, ni precios, ni reglas de flujo (eso es del backend)", () => {
  assert.ok(!/menu_item_id|calcular_total|submit_order/.test(prompt),
    "el prompt de la voz no debe conocer las herramientas del backend");
  assert.ok(!/€|euros con/.test(prompt), "el prompt de la voz no debe llevar precios");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
