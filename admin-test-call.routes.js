/**
 * admin-test-call.routes.js
 *
 * Disparar una LLAMADA SALIENTE de prueba: Sarah te llama a ti.
 *
 * Por qué no es "Twilio directo": el número de Twilio está conectado al agente
 * de ElevenLabs. Si llamáramos con la API de Twilio a pelo, la llamada saldría
 * pero SIN Sarah (haría falta un TwiML propio). La forma correcta es pedirle a
 * ElevenLabs que llame usando ese número: POST /v1/convai/twilio/outbound-call.
 * Esa llamada ya la hace `placeOutboundCall` (demo-callback.routes.js); aquí
 * solo la exponemos sin el captcha ni los límites de la demo pública.
 *
 * SEGURIDAD (esto gasta dinero: hay que blindarlo):
 *  - Bearer OBLIGATORIO. Fail-closed: sin secreto configurado → 503, no abierto.
 *  - Allowlist opcional de destinos (TEST_CALL_ALLOWED_NUMBERS, E.164 separados
 *    por comas). Si está definida, solo se llama a esos números.
 *  - El teléfono se enmascara en los logs (nada de PII en claro).
 *
 * ENDPOINTS
 *  GET  /admin/test-call/diag   → qué variables faltan (nunca devuelve valores)
 *  POST /admin/test-call        → body {"to":"+34600000000"}  (o "600000000")
 *
 * Variables:
 *  ADMIN_TEST_CALL_SECRET          (si falta, cae a ELEVENLABS_CUSTOM_LLM_SECRET)
 *  ELEVENLABS_API_KEY              \
 *  ELEVENLABS_AGENT_ID              > las 3 son imprescindibles para llamar
 *  ELEVENLABS_AGENT_PHONE_NUMBER_ID/
 *  TEST_CALL_ALLOWED_NUMBERS       (opcional, recomendada)
 *  DEFAULT_COUNTRY_CODE            (opcional, por defecto 34)
 */
const express = require("express");
const https = require("https");
const router = express.Router();

const { placeOutboundCall, turnstileSecret } = require("./demo-callback.routes.js");
const { isProduction } = require("./whatsapp-twilio.routes.js");
const { toE164 } = require("./customer-notify.service.js");

const REQUIRED_VARS = ["ELEVENLABS_API_KEY", "ELEVENLABS_AGENT_ID", "ELEVENLABS_AGENT_PHONE_NUMBER_ID"];

function maskPhone(p) {
  const s = String(p || "");
  return s.length <= 4 ? "***" : s.slice(0, 4) + "***" + s.slice(-2);
}

/** Fail-closed: si no hay secreto configurado, el endpoint NO queda abierto. */
function authorize(req, res) {
  const secret = process.env.ADMIN_TEST_CALL_SECRET || process.env.ELEVENLABS_CUSTOM_LLM_SECRET || "";
  if (!secret) {
    res.status(503).json({ ok: false, error: "sin_secreto_configurado" });
    return false;
  }
  const auth = String(req.headers.authorization || "");
  if (auth !== "Bearer " + secret) {
    res.status(401).json({ ok: false, error: "no_autorizado" });
    return false;
  }
  return true;
}

/** Allowlist opcional de destinos. Sin ella, se permite (pero se avisa en el log). */
function allowedTarget(e164) {
  const raw = String(process.env.TEST_CALL_ALLOWED_NUMBERS || "").trim();
  if (!raw) return { allowed: true, enforced: false };
  const list = raw.split(",").map(s => s.trim()).filter(Boolean);
  return { allowed: list.includes(e164), enforced: true };
}

/**
 * Pregunta a ElevenLabs por la clave que tiene ESTE servidor (la de Railway).
 * Sirve para distinguir "la key no tiene permisos de Conversational AI" de
 * "la key de Railway no es la que has editado". Nunca devuelve la clave.
 */
function probeElevenLabs(path, devolverCuerpo) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.elevenlabs.io",
      path,
      method: "GET",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY || "" }
    }, (r) => {
      let d = "";
      r.on("data", c => { d += c; });
      r.on("end", () => {
        let motivo = null, cuerpo = null;
        try {
          const j = JSON.parse(d);
          motivo = (j.detail && (j.detail.message || j.detail)) || j.message || null;
          if (devolverCuerpo) cuerpo = j;
        } catch (_) {}
        resolve({
          status: r.statusCode,
          ok: r.statusCode >= 200 && r.statusCode < 300,
          motivo: motivo ? String(motivo).slice(0, 200) : null,
          ...(devolverCuerpo ? { cuerpo } : {})
        });
      });
    });
    req.on("error", e => resolve({ status: 0, ok: false, motivo: e.message }));
    req.setTimeout(10000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

router.get("/admin/test-call/probe", async (req, res) => {
  if (!authorize(req, res)) return;
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ ok: false, error: "sin_api_key" });

  const [usuario, convai, numeros, agentes] = await Promise.all([
    probeElevenLabs("/v1/user"),                        // ¿la clave es válida?
    probeElevenLabs("/v1/convai/agents?page_size=1"),   // ¿tiene convai_read?
    probeElevenLabs("/v1/convai/phone-numbers", true),  // los IDs reales de los números
    probeElevenLabs("/v1/convai/agents?page_size=100", true) // ¿existe el agente configurado?
  ]);

  // ¿El ELEVENLABS_AGENT_ID de Railway corresponde a un agente que existe?
  const listaAg = agentes.cuerpo?.agents || (Array.isArray(agentes.cuerpo) ? agentes.cuerpo : []);
  const agentesDisponibles = listaAg.map(a => ({ id: a.agent_id || a.id, nombre: a.name }));
  const agentePuesto = process.env.ELEVENLABS_AGENT_ID || "";
  const agenteOk = agentesDisponibles.some(a => a.id === agentePuesto);

  // ELEVENLABS_AGENT_PHONE_NUMBER_ID debe ser el ID de ElevenLabs, NO el "+34…".
  // Confundirlo da: "Document with id +19014228104 not found".
  const lista = Array.isArray(numeros.cuerpo) ? numeros.cuerpo : (numeros.cuerpo?.phone_numbers || []);
  const disponibles = lista.map(n => ({
    id: n.phone_number_id || n.id,
    numero: n.phone_number,
    etiqueta: n.label || n.provider || null,
    agente_asignado: n.assigned_agent?.agent_name || n.assigned_agent?.agent_id || null
  }));
  const puesto = process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID || "";
  const idCorrecto = disponibles.some(n => n.id === puesto);
  const huella = require("crypto").createHash("sha256")
    .update(process.env.ELEVENLABS_API_KEY).digest("hex").slice(0, 8);

  res.json({
    ok: convai.ok && idCorrecto && agenteOk,
    clave_valida: usuario.ok,
    permiso_convai_read: convai.ok,
    huella_clave: huella,          // para comparar con la del panel SIN exponerla
    phone_number_id_valido: idCorrecto,
    phone_number_id_puesto: puesto,
    numeros_disponibles: disponibles,
    agent_id_valido: agenteOk,
    agent_id_puesto: agentePuesto,
    agentes_disponibles: agentesDisponibles,
    detalle: { usuario, convai, numeros: { status: numeros.status, motivo: numeros.motivo } },
    pista: !usuario.ok
      ? "La clave de Railway no es válida en ElevenLabs."
      : !convai.ok
        ? "La clave es válida pero NO tiene permisos de Conversational AI: o has editado otra clave distinta, o el cambio no se guardó."
        : !idCorrecto
          ? (disponibles.length
              ? "ELEVENLABS_AGENT_PHONE_NUMBER_ID es incorrecto. Pon en Railway el 'id' de 'numeros_disponibles' (NO el número de teléfono)."
              : "No hay ningún número importado en ElevenLabs → Phone Numbers. Hay que conectar el número de Twilio ahí primero.")
          : !agenteOk
            ? "ELEVENLABS_AGENT_ID no corresponde a ningún agente existente. Pon en Railway el 'id' de 'agentes_disponibles'."
            : "Todo correcto: clave con permisos, phone_number_id y agent_id válidos."
  });
});

/**
 * Autopsia de una llamada: config del agente + transcripción de la conversación.
 * Responde a "sonó pero dijo que tenía problemas técnicos": ese texto es la frase
 * de emergencia del prompt, así que el fallo está en la conexión ElevenLabs→backend.
 *   GET /admin/test-call/autopsia?conv=conv_xxxx
 */
router.get("/admin/test-call/autopsia", async (req, res) => {
  if (!authorize(req, res)) return;
  const conv = String(req.query.conv || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const agentId = process.env.ELEVENLABS_AGENT_ID || "";

  const [agente, conversacion] = await Promise.all([
    agentId ? probeElevenLabs("/v1/convai/agents/" + agentId, true) : Promise.resolve({ ok: false, motivo: "sin ELEVENLABS_AGENT_ID" }),
    conv ? probeElevenLabs("/v1/convai/conversations/" + conv, true) : Promise.resolve({ ok: false, motivo: "falta ?conv=" })
  ]);

  // Config del LLM del agente: ¿apunta a NUESTRO backend o a un modelo nativo?
  const pl = agente.cuerpo?.conversation_config?.agent?.prompt || {};
  const urlBackend = pl.custom_llm?.url || null;
  const esperada = "https://vozra-orders-production.up.railway.app";
  const llm = {
    modelo: pl.llm || null,
    es_custom_llm: Boolean(pl.custom_llm),
    url_custom_llm: urlBackend,
    apunta_a_nuestro_backend: Boolean(urlBackend && urlBackend.includes("vozra-orders-production")),
    tiene_api_key_configurada: Boolean(pl.custom_llm?.api_key),
    backup_llm: pl.backup_llm_config ?? null,
    herramientas: (pl.tools || pl.tool_ids || []).map(t => (typeof t === "string" ? t : t.name || t.type)),
    primer_mensaje: (agente.cuerpo?.conversation_config?.agent?.first_message || "").slice(0, 120)
  };

  const c = conversacion.cuerpo || {};
  const turnos = (c.transcript || []).map(t => ({
    quien: t.role,
    texto: String(t.message || "").slice(0, 200)
  }));

  res.json({
    agente: { id: agentId, nombre: agente.cuerpo?.name || null, llm, status_api: agente.status },
    llamada: {
      id: conv || null,
      estado: c.status || null,
      motivo_fin: c.metadata?.termination_reason || null,
      segundos: c.metadata?.call_duration_secs ?? null,
      turnos
    },
    pista: !llm.es_custom_llm
      ? "El agente NO está usando Custom LLM: no pasa por nuestro backend. Configúralo en el panel."
      : !llm.apunta_a_nuestro_backend
        ? ("El Custom LLM apunta a " + (urlBackend || "(vacío)") + " y debería apuntar a " + esperada + "/v1/chat/completions")
        : !llm.tiene_api_key_configurada
          ? "El Custom LLM no tiene Bearer configurado: nuestro backend le devolverá 401."
          : "La configuración del agente parece correcta; mira 'motivo_fin' y los turnos."
  });
});

router.get("/admin/test-call/diag", (req, res) => {
  if (!authorize(req, res)) return;
  const vars = {};
  for (const v of REQUIRED_VARS) vars[v] = Boolean(process.env[v]);
  const faltan = REQUIRED_VARS.filter(v => !process.env[v]);
  res.json({
    ok: faltan.length === 0,
    listo_para_llamar: faltan.length === 0,
    vars,
    faltan,
    allowlist_activa: Boolean(String(process.env.TEST_CALL_ALLOWED_NUMBERS || "").trim()),
    pista: faltan.length ? "Pon esas variables en Railway → Variables y redespliega." : "Todo listo: POST /admin/test-call",
    // Panel de seguridad: solo booleanos, nunca valores.
    seguridad: {
      es_produccion: isProduction(),
      twilio_firma_obligatoria: isProduction() && Boolean(process.env.TWILIO_AUTH_TOKEN),
      twilio_skip_signature_puesta: process.env.TWILIO_SKIP_SIGNATURE === "true",
      turnstile_configurado: Boolean(turnstileSecret()),
      turnstile_nombre_canonico: Boolean(process.env.TURNSTILE_SECRET)
    }
  });
});

router.post("/admin/test-call", async (req, res) => {
  if (!authorize(req, res)) return;

  const faltan = REQUIRED_VARS.filter(v => !process.env[v]);
  if (faltan.length) {
    return res.status(503).json({ ok: false, error: "config_incompleta", faltan });
  }

  const to = toE164((req.body && (req.body.to || req.body.phone)) || "", process.env.DEFAULT_COUNTRY_CODE || "34");
  if (!to) return res.status(400).json({ ok: false, error: "telefono_invalido" });

  const gate = allowedTarget(to);
  if (!gate.allowed) {
    console.warn("[TESTCALL] destino fuera de la allowlist | to=" + maskPhone(to));
    return res.status(403).json({ ok: false, error: "destino_no_permitido" });
  }
  if (!gate.enforced) {
    console.warn("[TESTCALL] sin TEST_CALL_ALLOWED_NUMBERS: cualquier destino es válido con este secreto.");
  }

  try {
    const data = await placeOutboundCall(to);
    console.log("[TESTCALL] llamada lanzada | to=" + maskPhone(to) + " | conv=" + (data.conversation_id || "?"));
    res.json({
      ok: true,
      to: maskPhone(to),
      conversation_id: data.conversation_id || null,
      callSid: data.callSid || data.call_sid || null
    });
  } catch (e) {
    console.error("[TESTCALL] fallo | to=" + maskPhone(to) + " | " + e.message);
    res.status(e.providerStatus && e.providerStatus < 500 ? 400 : 502)
       .json({ ok: false, error: "fallo_al_llamar", detalle: String(e.message).slice(0, 300) });
  }
});

module.exports = router;
module.exports.REQUIRED_VARS = REQUIRED_VARS;
module.exports.allowedTarget = allowedTarget;
module.exports.maskPhone = maskPhone;
