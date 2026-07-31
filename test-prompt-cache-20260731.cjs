/**
 * test-prompt-cache-20260731.cjs
 *
 * INVARIANTE DE LATENCIA/COSTE: el system prompt debe ser un PREFIJO ESTABLE
 * seguido de una COLA DINÁMICA (horario con la hora actual + perfil del cliente).
 *
 * Por qué importa: OpenAI cachea por PREFIJO EXACTO y solo a partir de 1024
 * tokens. Si un dato que cambia (la hora, el nombre del cliente) se cuela en
 * medio del prompt, todo lo que va DESPUÉS —incluida la carta entera, ~9k
 * tokens— deja de cachearse en cada turno: más caro y más lento.
 *
 * Este test falla si alguien vuelve a meter contenido dinámico en el medio.
 *
 *   node test-prompt-cache-20260731.cjs
 */
const assert = require("assert");
const { buildSystemPrompt } = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}

const CHARS_POR_TOKEN = 4;          // aproximación conservadora para español
const MINIMO_CACHEABLE = 1024;      // umbral de OpenAI: por debajo NO cachea nada

const sinPerfil = buildSystemPrompt();
const conPerfil = buildSystemPrompt(undefined, {
  name: "Samuel Tineo",
  address: { raw: "Calle Alpandeire número 3, bloque 1, primero B" }
});

function primeraDivergencia(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
}

console.log("══ Caché de prompt — el prefijo estable manda ═════");

test("el prefijo común (con y sin perfil) supera el mínimo cacheable de OpenAI", () => {
  const tokens = primeraDivergencia(sinPerfil, conPerfil) / CHARS_POR_TOKEN;
  assert.ok(
    tokens > MINIMO_CACHEABLE,
    `prefijo estable ~${Math.round(tokens)} tokens (mínimo ${MINIMO_CACHEABLE}). ` +
    "Algo dinámico se ha colado antes de la carta."
  );
});

test("el prefijo estable cubre casi todo el prompt (>90%)", () => {
  const d = primeraDivergencia(sinPerfil, conPerfil);
  const ratio = d / sinPerfil.length;
  assert.ok(ratio > 0.9, `solo el ${Math.round(ratio * 100)}% del prompt es prefijo estable`);
});

test("la hora actual va en la COLA, no en el medio", () => {
  const i = sinPerfil.indexOf("Ahora son las");
  assert.ok(i > -1, "no aparece la hora en el prompt (¿se ha quitado el horario?)");
  const despues = (sinPerfil.length - i) / CHARS_POR_TOKEN;
  assert.ok(despues < 200, `hay ~${Math.round(despues)} tokens después de la hora; deben ser <200`);
});

test("la carta operativa va ANTES de la cola dinámica (se cachea)", () => {
  const carta = sinPerfil.indexOf("# CARTA OPERATIVA");
  const hora  = sinPerfil.indexOf("Ahora son las");
  assert.ok(carta > -1 && hora > -1, "falta la carta o el horario");
  assert.ok(carta < hora, "la carta quedó después de la hora: dejaría de cachearse");
});

test("el bloque de perfil recurrente sigue existiendo y va al final", () => {
  assert.ok(/# CLIENTE RECURRENTE/.test(conPerfil), "desapareció el bloque de cliente recurrente");
  assert.ok(!/# CLIENTE RECURRENTE/.test(sinPerfil), "aparece el bloque sin haber perfil");
  const i = conPerfil.indexOf("# CLIENTE RECURRENTE");
  assert.ok(i / conPerfil.length > 0.9, "el bloque de perfil no está en la cola del prompt");
});

test("no se ha perdido contenido al reordenar", () => {
  for (const marca of [
    "# IDENTIDAD", "# MISIÓN", "# FLUJO DEL PEDIDO", "# HORARIO DE COCINA",
    "# CARTA OPERATIVA", "# EN CASO DE PROBLEMA TÉCNICO",
    "Si la cocina está cerrada", "No prometas que estará listo"
  ]) {
    assert.ok(sinPerfil.includes(marca), "falta en el prompt: " + marca);
  }
});

console.log("");
console.log(`${pass} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);
