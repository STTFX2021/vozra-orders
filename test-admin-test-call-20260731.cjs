/**
 * test-admin-test-call-20260731.cjs
 *
 * El endpoint /admin/test-call GASTA DINERO (lanza llamadas reales).
 * Este test blinda que no se quede abierto por accidente.
 *
 *   node test-admin-test-call-20260731.cjs
 */
const assert = require("assert");
const http = require("http");
const express = require("express");

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// Entorno controlado ANTES de cargar el router.
process.env.ADMIN_TEST_CALL_SECRET = "secreto-de-test";
process.env.TEST_CALL_ALLOWED_NUMBERS = "+34600000001,+34600000002";

const router = require("./admin-test-call.routes.js");
const { allowedTarget, maskPhone, REQUIRED_VARS } = router;

const app = express();
app.use(express.json());
app.use("/", router);
const server = http.createServer(app);

function call(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: "127.0.0.1", port: server.address().port, path, method,
      headers: Object.assign(
        { "Content-Type": "application/json" },
        token ? { Authorization: "Bearer " + token } : {},
        payload ? { "Content-Length": Buffer.byteLength(payload) } : {}
      )
    }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test("sin Bearer → 401", async () => {
  const r = await call("POST", "/admin/test-call", { body: { to: "+34600000001" } });
  assert.strictEqual(r.status, 401, "respondió " + r.status);
});

test("Bearer incorrecto → 401", async () => {
  const r = await call("POST", "/admin/test-call", { token: "otro", body: { to: "+34600000001" } });
  assert.strictEqual(r.status, 401);
});

test("el diag también exige Bearer", async () => {
  const r = await call("GET", "/admin/test-call/diag");
  assert.strictEqual(r.status, 401);
});

test("con Bearer, el diag dice qué falta sin filtrar valores", async () => {
  const r = await call("GET", "/admin/test-call/diag", { token: "secreto-de-test" });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.faltan), "no devuelve 'faltan'");
  for (const v of Object.values(r.body.vars)) assert.strictEqual(typeof v, "boolean", "el diag filtra valores");
});

test("config incompleta → 503 y NO intenta llamar", async () => {
  const r = await call("POST", "/admin/test-call", { token: "secreto-de-test", body: { to: "+34600000001" } });
  assert.strictEqual(r.status, 503, "respondió " + r.status);
  assert.strictEqual(r.body.error, "config_incompleta");
});

test("fail-closed: sin secreto configurado el endpoint NO queda abierto", async () => {
  const prevA = process.env.ADMIN_TEST_CALL_SECRET, prevB = process.env.ELEVENLABS_CUSTOM_LLM_SECRET;
  delete process.env.ADMIN_TEST_CALL_SECRET; delete process.env.ELEVENLABS_CUSTOM_LLM_SECRET;
  const r = await call("POST", "/admin/test-call", { body: { to: "+34600000001" } });
  process.env.ADMIN_TEST_CALL_SECRET = prevA;
  if (prevB) process.env.ELEVENLABS_CUSTOM_LLM_SECRET = prevB;
  assert.strictEqual(r.status, 503, "respondió " + r.status + " (¡abierto!)");
  assert.strictEqual(r.body.error, "sin_secreto_configurado");
});

test("allowlist: acepta los de la lista y rechaza el resto", () => {
  assert.strictEqual(allowedTarget("+34600000001").allowed, true);
  assert.strictEqual(allowedTarget("+34699999999").allowed, false);
  assert.strictEqual(allowedTarget("+34600000001").enforced, true);
});

test("sin allowlist definida no bloquea (pero queda marcado como no forzado)", () => {
  const prev = process.env.TEST_CALL_ALLOWED_NUMBERS;
  delete process.env.TEST_CALL_ALLOWED_NUMBERS;
  const g = allowedTarget("+34699999999");
  process.env.TEST_CALL_ALLOWED_NUMBERS = prev;
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.enforced, false);
});

test("el teléfono se enmascara en logs (nada de PII en claro)", () => {
  const m = maskPhone("+34611404679");
  assert.ok(!m.includes("611404"), "el número aparece en claro: " + m);
  assert.ok(m.endsWith("79"), "no conserva la cola para identificarlo: " + m);
});

test("las 3 variables de ElevenLabs son obligatorias", () => {
  assert.deepStrictEqual(REQUIRED_VARS,
    ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_AGENT_PHONE_NUMBER_ID"]);
});

(async () => {
  await new Promise(r => server.listen(0, r));
  console.log("══ /admin/test-call — seguridad ══════════════════");
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  ok  " + name); pass++; }
    catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
  }
  server.close();
  console.log("\n" + pass + " ok / " + fail + " fail");
  process.exit(fail ? 1 : 0);
})();
