"use strict";

const assert = require("assert");
const {
  composeE164,
  createDemoCallbackHandler
} = require("./demo-callback.routes.js");

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    sendStatus(code) { this.statusCode = code; return this; }
  };
}

function createRequest(body) {
  return {
    body,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "user-agent": "vozra-test" }
  };
}

async function runHandler(body, deps) {
  const req = createRequest(body);
  const res = createResponse();
  await createDemoCallbackHandler(deps)(req, res);
  return res;
}

(async () => {
  let passed = 0;
  const ok = (condition, message) => {
    assert.ok(condition, message);
    passed += 1;
    console.log(`  OK  ${message}`);
  };

  ok(composeE164("600 123 456", "ES") === "+34600123456", "compone número español en E.164");
  ok(composeE164("+34 600 123 456", "ES") === "+34600123456", "acepta E.164 explícito");
  ok(composeE164("07123 456789", "GB") === "+447123456789", "elimina trunk prefix británico");
  ok(composeE164("123", "ES") === null, "rechaza números demasiado cortos");

  let outboundCalls = 0;
  const baseDeps = {
    verifyTurnstileToken: async () => ({ success: true, errorCodes: [] }),
    reserveCallback: async () => ({ allowed: true, attempt_id: "00000000-0000-0000-0000-000000000001" }),
    placeOutboundCall: async () => {
      outboundCalls += 1;
      return { success: true, conversation_id: "conv-test", callSid: "CA-test", message: "ok" };
    },
    updateCallbackAttempt: async () => ({ ok: true }),
    isCallbackStoreEnabled: () => true
  };

  let res = await runHandler(
    { phone: "600123456", country: "ES", consent: false, captchaToken: "token" },
    baseDeps
  );
  ok(res.statusCode === 400 && res.body.code === "consent_required", "sin consentimiento devuelve 400");
  ok(outboundCalls === 0, "sin consentimiento no inicia llamada");

  res = await runHandler(
    { phone: "600123456", country: "ES", consent: true, captchaToken: "token" },
    { ...baseDeps, verifyTurnstileToken: async () => ({ success: false, errorCodes: ["invalid-input-response"] }) }
  );
  ok(res.statusCode === 403 && res.body.code === "captcha_invalid", "Turnstile inválido devuelve 403");
  ok(outboundCalls === 0, "Turnstile inválido no inicia llamada");

  res = await runHandler(
    { phone: "600123456", country: "ES", consent: true, captchaToken: "token" },
    {
      ...baseDeps,
      reserveCallback: async () => ({ allowed: false, reason: "cooldown", retry_after_seconds: 420 })
    }
  );
  ok(res.statusCode === 429 && res.body.code === "rate_limited", "cooldown devuelve 429");
  ok(res.headers["Retry-After"] === "420", "429 incluye Retry-After");
  ok(outboundCalls === 0, "rate limit no inicia segunda llamada");

  res = await runHandler(
    { phone: "600123456", country: "ES", consent: true, captchaToken: "token" },
    baseDeps
  );
  ok(res.statusCode === 200 && res.body.ok === true, "datos válidos devuelven 200");
  ok(outboundCalls === 1, "datos válidos inician exactamente una llamada");

  console.log(`\nDemo callback contract: ${passed} OK`);
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
