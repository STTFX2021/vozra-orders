#!/usr/bin/env node
/**
 * PUBLICA la configuración del agente Sarah desde el REPO a ElevenLabs.
 *
 * POR QUÉ EXISTE (18-08): el prompt y los ajustes del panel de ElevenLabs vivían
 * FUERA de git y FUERA de los tests. Cualquiera podía cambiarlos sin dejar rastro y
 * romper producción con la suite en verde. De hecho pasó: el 18-08 se "arregló" el
 * first_message poniéndole espacios, deshaciendo una decisión deliberada de sam (sin
 * espacios el saludo sale seguido; con espacios suena lento).
 *
 * A partir de ahora la fuente de verdad es este repo:
 *   elevenlabs/agent-sarah.config.json   ajustes
 *   elevenlabs/prompt-sarah.md           prompt del agente (voz, no decisiones)
 *
 * USO:
 *   node elevenlabs/publicar-agente.cjs            → enseña el diff, NO publica
 *   node elevenlabs/publicar-agente.cjs --publicar → publica de verdad
 *
 * Necesita ELEVENLABS_API_KEY y ELEVENLABS_CUSTOM_LLM_SECRET en el entorno.
 * Sin SDKs: https nativo, como el resto del proyecto.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const https = require("https");

const DIR = __dirname;
const API_KEY = process.env.ELEVENLABS_API_KEY;
const PUBLICAR = process.argv.includes("--publicar");

function leerConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(DIR, "agent-sarah.config.json"), "utf8"));
  const prompt = fs.readFileSync(path.join(DIR, "prompt-sarah.md"), "utf8").trim();
  cfg.conversation_config.agent.prompt.prompt = prompt;
  delete cfg.conversation_config.agent.prompt._prompt_desde;
  return cfg;
}

// Sustituye ${VAR} por su valor del entorno. Si falta alguna, aborta: publicar con
// un secreto a medias deja el agente sin poder hablar con el backend.
function resolverVariables(obj, faltan = []) {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([A-Z0-9_]+)\}/g, (_, v) => {
      if (!process.env[v]) { faltan.push(v); return ""; }
      return process.env[v];
    });
  }
  if (Array.isArray(obj)) return obj.map(x => resolverVariables(x, faltan));
  if (obj && typeof obj === "object") {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (k.startsWith("_")) continue;            // claves de documentación
      out[k] = resolverVariables(obj[k], faltan);
    }
    return out;
  }
  return obj;
}

function api(metodo, ruta, body) {
  return new Promise((resolve, reject) => {
    const datos = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.elevenlabs.io", path: ruta, method: metodo,
      headers: Object.assign(
        { "xi-api-key": API_KEY },
        datos ? { "content-type": "application/json", "content-length": Buffer.byteLength(datos) } : {}
      )
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 400)}`));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (datos) req.write(datos);
    req.end();
  });
}

// Compara SOLO lo que el repo declara. Lo que no declaramos, no nos importa.
function diferencias(deseado, real, ruta = "") {
  const out = [];
  for (const k of Object.keys(deseado || {})) {
    const d = deseado[k];
    const r = real ? real[k] : undefined;
    const aqui = ruta ? ruta + "." + k : k;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      out.push(...diferencias(d, r || {}, aqui));
    } else if (JSON.stringify(d) !== JSON.stringify(r)) {
      out.push({ campo: aqui, repo: d, agente: r });
    }
  }
  return out;
}

(async () => {
  if (!API_KEY) {
    console.error("Falta ELEVENLABS_API_KEY en el entorno.");
    process.exit(1);
  }
  const faltan = [];
  const cfg = leerConfig();
  const agentId = cfg.agent_id;
  const cuerpo = resolverVariables({ conversation_config: cfg.conversation_config }, faltan);

  if (faltan.length) {
    console.error("Faltan variables de entorno: " + [...new Set(faltan)].join(", "));
    console.error("Publicar sin ellas dejaría al agente sin poder hablar con el backend. Abortado.");
    process.exit(1);
  }

  const actual = await api("GET", `/v1/convai/agents/${agentId}`);
  const difs = diferencias(cuerpo.conversation_config, actual.conversation_config);

  if (!difs.length) {
    console.log("El agente ya coincide con el repo. Nada que publicar.");
    return;
  }

  console.log(`\nDiferencias entre el REPO y el AGENTE (${difs.length}):\n`);
  for (const d of difs) {
    const corta = v => { const s = JSON.stringify(v); return s && s.length > 90 ? s.slice(0, 90) + "…" : s; };
    console.log(`  ${d.campo}`);
    console.log(`      repo:   ${corta(d.repo)}`);
    console.log(`      agente: ${corta(d.agente)}`);
  }

  if (!PUBLICAR) {
    console.log("\n(Solo diff. Para publicar: node elevenlabs/publicar-agente.cjs --publicar)\n");
    return;
  }

  const res = await api("PATCH", `/v1/convai/agents/${agentId}`, cuerpo);
  console.log(`\nPublicado. Nueva versión: ${res.version_id}\n`);
})().catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
