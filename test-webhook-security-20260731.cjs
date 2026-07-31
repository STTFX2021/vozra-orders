/**
 * test-webhook-security-20260731.cjs
 *
 * El webhook de Twilio estaba ABIERTO en producción por dos vías:
 *   1) TWILIO_SKIP_SIGNATURE=true (puesta en Railway "para dev")
 *   2) sin TWILIO_AUTH_TOKEN devolvía true (fail-OPEN)
 * Este test blinda que en producción ninguna de las dos deje pasar nada.
 *
 *   node test-webhook-security-20260731.cjs
 */
const assert = require("assert");
const crypto = require("crypto");

const { verifyTwilioSignature } = require("./whatsapp-twilio.routes.js");
const { turnstileSecret } = require("./demo-callback.routes.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}

const TOKEN = "token-de-prueba";
const HOST = "vozra-orders-production.up.railway.app";
const PATH = "/whatsapp/incoming";

/** Simula un request de Twilio detrás del proxy de Railway (https vía cabecera). */
function fakeReq({ body = { From: "whatsapp:+34600000000", Body: "hola" }, signature, proto = "https" } = {}) {
  return {
    headers: { "x-twilio-signature": signature || "", "x-forwarded-proto": proto },
    protocol: "http",                       // lo que ve Express detrás del proxy
    originalUrl: PATH,
    body,
    get: (h) => (h.toLowerCase() === "host" ? HOST : undefined)
  };
}

function signFor(body, proto = "https") {
  const url = `${proto}://${HOST}${PATH}`;
  const paramStr = Object.keys(body).sort().map(k => k + body[k]).join("");
  return crypto.createHmac("sha1", TOKEN).update(url + paramStr).digest("base64");
}

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; 
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(prev)) {
    if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

const PROD = { RAILWAY_ENVIRONMENT: "production", TWILIO_AUTH_TOKEN: TOKEN };
const DEV  = { RAILWAY_ENVIRONMENT: undefined, RAILWAY_GIT_COMMIT_SHA: undefined };

console.log("══ Seguridad de webhooks ═════════════════════════");

test("PROD: firma válida → pasa", () => {
  withEnv(Object.assign({}, PROD, { TWILIO_SKIP_SIGNATURE: undefined }), () => {
    const body = { From: "whatsapp:+34600000000", Body: "hola" };
    assert.strictEqual(verifyTwilioSignature(fakeReq({ body, signature: signFor(body) })), true);
  });
});

test("PROD: sin firma → rechaza", () => {
  withEnv(Object.assign({}, PROD, { TWILIO_SKIP_SIGNATURE: undefined }), () => {
    assert.strictEqual(verifyTwilioSignature(fakeReq({})), false);
  });
});

test("PROD: firma de OTRO cuerpo → rechaza (no vale replay)", () => {
  withEnv(Object.assign({}, PROD, { TWILIO_SKIP_SIGNATURE: undefined }), () => {
    const sig = signFor({ From: "whatsapp:+34600000000", Body: "hola" });
    const otro = { From: "whatsapp:+34600000000", Body: "pedido falso" };
    assert.strictEqual(verifyTwilioSignature(fakeReq({ body: otro, signature: sig })), false);
  });
});

test("PROD: TWILIO_SKIP_SIGNATURE=true se IGNORA (era el agujero)", () => {
  withEnv(Object.assign({}, PROD, { TWILIO_SKIP_SIGNATURE: "true" }), () => {
    assert.strictEqual(verifyTwilioSignature(fakeReq({})), false, "el bypass sigue activo en producción");
  });
});

test("PROD: sin TWILIO_AUTH_TOKEN → rechaza (antes era fail-OPEN)", () => {
  withEnv({ RAILWAY_ENVIRONMENT: "production", TWILIO_AUTH_TOKEN: undefined, TWILIO_SKIP_SIGNATURE: undefined }, () => {
    assert.strictEqual(verifyTwilioSignature(fakeReq({})), false);
  });
});

test("PROD: usa x-forwarded-proto, no req.protocol (si no, nada cuadraría)", () => {
  withEnv(Object.assign({}, PROD, { TWILIO_SKIP_SIGNATURE: undefined }), () => {
    const body = { From: "whatsapp:+34600000000", Body: "hola" };
    // firmado como https (lo que hace Twilio); el request llega con protocol=http
    assert.strictEqual(verifyTwilioSignature(fakeReq({ body, signature: signFor(body, "https") })), true);
    // firmado como http → NO debe cuadrar
    assert.strictEqual(verifyTwilioSignature(fakeReq({ body, signature: signFor(body, "http") })), false);
  });
});

test("DEV: el bypass sigue disponible para desarrollar", () => {
  withEnv(Object.assign({}, DEV, { TWILIO_SKIP_SIGNATURE: "true", TWILIO_AUTH_TOKEN: TOKEN }), () => {
    assert.strictEqual(verifyTwilioSignature(fakeReq({})), true);
  });
});

test("Turnstile: lee el nombre canónico", () => {
  withEnv({ TURNSTILE_SECRET: "abc", "Secret key": undefined }, () => {
    assert.strictEqual(turnstileSecret(), "abc");
  });
});

test("Turnstile: rescata el nombre que pone Cloudflare ('Secret key')", () => {
  withEnv({ TURNSTILE_SECRET: undefined, TURNSTILE_SECRET_KEY: undefined, CLOUDFLARE_TURNSTILE_SECRET: undefined, "Secret key": "xyz" }, () => {
    assert.strictEqual(turnstileSecret(), "xyz");
  });
});

test("Turnstile: sin nada configurado sigue siendo fail-closed", () => {
  withEnv({ TURNSTILE_SECRET: undefined, TURNSTILE_SECRET_KEY: undefined, CLOUDFLARE_TURNSTILE_SECRET: undefined, "Secret key": undefined }, () => {
    assert.strictEqual(turnstileSecret(), "");
  });
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
