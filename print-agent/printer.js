"use strict";

/**
 * Render ESC/POS de una comanda + envío a impresora térmica por red (IP:9100).
 * Modo simulador: escribe la comanda a ./tickets/ en vez de imprimir.
 */

const net  = require("net");
const fs   = require("fs");
const path = require("path");

// ── ESC/POS ──────────────────────────────────────────────────────────────────
const ESC = 0x1B, GS = 0x1D;
const INIT      = Buffer.from([ESC, 0x40]);                 // ESC @  reset
const CODEPAGE  = Buffer.from([ESC, 0x74, 19]);             // PC858 (incluye €)
const ALIGN_C   = Buffer.from([ESC, 0x61, 1]);
const ALIGN_L   = Buffer.from([ESC, 0x61, 0]);
const BOLD_ON   = Buffer.from([ESC, 0x45, 1]);
const BOLD_OFF  = Buffer.from([ESC, 0x45, 0]);
const BIG_ON    = Buffer.from([GS, 0x21, 0x11]);            // doble alto+ancho
const BIG_OFF   = Buffer.from([GS, 0x21, 0x00]);
const FEED3     = Buffer.from([ESC, 0x64, 3]);              // 3 líneas
const CUT       = Buffer.from([GS, 0x56, 1]);               // corte parcial

function line(txt) { return Buffer.from(String(txt) + "\n", "latin1"); }

/** Construye el buffer ESC/POS de la comanda a partir del texto del ticket. */
function buildEscPos(entry, width) {
  const parts = [INIT, CODEPAGE];
  // Cabecera grande y centrada
  parts.push(ALIGN_C, BOLD_ON, BIG_ON, line("COMANDA"), BIG_OFF);
  parts.push(line(entry.orderId || ""), BOLD_OFF, ALIGN_L, line(""));
  // Cuerpo: el ticket ya viene formateado desde el backend
  for (const l of String(entry.ticket || "").split("\n")) parts.push(line(l));
  parts.push(FEED3, CUT);
  return Buffer.concat(parts);
}

/** Imprime (o simula) una comanda. Devuelve Promise. */
function printTicket(entry, cfg) {
  const width = parseInt(cfg.width, 10) || 48;

  if (String(cfg.simulate) === "1") {
    const dir = path.join(__dirname, "tickets");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${entry.orderId}.txt`);
    const preview = `*** SIMULADOR (no impreso) ***\nCOMANDA ${entry.orderId}\n\n${entry.ticket}\n`;
    fs.writeFileSync(file, preview, "utf8");
    console.log(`[print] SIMULADO → ${file}`);
    return Promise.resolve({ ok: true, simulated: true });
  }

  const buf = buildEscPos(entry, width);
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let done = false;
    const fail = (e) => { if (!done) { done = true; sock.destroy(); reject(e); } };
    sock.setTimeout(8000, () => fail(new Error("timeout conexión impresora")));
    sock.connect(parseInt(cfg.port, 10) || 9100, cfg.ip, () => {
      sock.write(buf, () => sock.end());
    });
    sock.on("close", () => { if (!done) { done = true; resolve({ ok: true }); } });
    sock.on("error", fail);
  });
}

module.exports = { printTicket, buildEscPos };
