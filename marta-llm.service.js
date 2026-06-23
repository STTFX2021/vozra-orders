"use strict";

/**
 * VOZRA ORDERS — Marta LLM Brain (OpenAI)
 * Fase 8: Sustituye el slot-filler por reglas por un LLM real (gpt-4o-mini).
 *
 * Recibe el historial (formato OpenAI) que envía ElevenLabs, construye un system
 * prompt con la persona de Marta + el menú real, llama a OpenAI con la herramienta
 * submit_order y, al confirmar el cliente, arma el pedido y lo dispara a cocina
 * reutilizando order-validator, kitchen-ticket-builder y dispatch-adapter.
 */

const fs    = require("fs");
const path  = require("path");
const https = require("https");

const { getOrCreateOrderSession, updateOrderSession, ORDER_STATUS } = require("./order-call-session.store.js");
const { validateOrder } = require("./order-validator.service.js");
const { dispatchOrder } = require("./dispatch-adapter.service.js");
const { startKitchenWatch } = require("./kitchen-ack-monitor.service.js");

// ─── MENÚ ─────────────────────────────────────────────────────────────────────

let _menu = null;
function loadMenu() {
  if (!_menu) {
    const p = path.join(__dirname, "data", "taxonomies", "menu-taxonomy.v1.json");
    _menu = JSON.parse(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  }
  return _menu;
}

const CATEGORY_LABELS = {
  starters:       "ENTRANTES",
  salads:         "ENSALADAS",
  pasta_risotto:  "PASTA Y RISOTTO",
  mains_meat:     "CARNES",
  pizza_rossa:    "PIZZAS ROJAS",
  pizza_bianca:   "PIZZAS BLANCAS",
  pizza_speciale: "PIZZAS ESPECIALES",
  pizza_ripiena:  "PIZZAS RELLENAS",
  desserts:       "POSTRES",
  beverages:      "BEBIDAS"
};

function buildMenuText() {
  const menu = loadMenu();
  const byCat = {};
  for (const it of menu.items) {
    if (it.isAvailable === false) continue;
    (byCat[it.category] = byCat[it.category] || []).push(it);
  }
  const lines = [];
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const items = byCat[cat];
    if (!items || !items.length) continue;
    lines.push("\n## " + (CATEGORY_LABELS[cat] || cat));
    items.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    for (const it of items) {
      const price = it.price != null ? it.price + "€" : "s/p";
      const desc  = it.description ? " — " + String(it.description).slice(0, 80) : "";
      lines.push("- " + it.displayName + " (id:" + it.id + ") · " + price + desc);
    }
  }
  return lines.join("\n");
}

function getMenuItemById(id) {
  if (!id) return null;
  return loadMenu().items.find(i => i.id === id) || null;
}

function getMenuItemByName(name) {
  if (!name) return null;
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const n = norm(name);
  if (!n) return null;
  const menu = loadMenu();
  let hit = menu.items.find(i => norm(i.displayName) === n);
  if (hit) return hit;
  hit = menu.items.find(i => (i.nlpKeywords || []).some(kw => norm(kw) === n));
  if (hit) return hit;
  hit = menu.items.find(i => norm(i.displayName).includes(n) || n.includes(norm(i.displayName)));
  return hit || null;
}

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const menu = loadMenu();
  const restaurant = menu.restaurantName || "La Locanda de Cancelada";
  return [
"Eres Marta, la voz de " + restaurant + ", una pizzería italiana en Cancelada (Málaga). Coges el teléfono para tomar pedidos. Hablas español de España, tuteando, cercana y con chispa, como una camarera de toda la vida: simpática, resuelta y con salero, pero sin pasarte.",
"",
"ESTO ES UNA LLAMADA DE VOZ. Habla como se habla, no como se escribe:",
"- Frases CORTAS y naturales. Una o dos por turno, no sueltes parrafadas.",
"- Nada de listas, ni markdown, ni emojis, ni leer la carta entera de carrerilla.",
"- Suena humana: usa con naturalidad cosas como \"vale\", \"genial\", \"estupendo\", \"marchando\", \"perfecto\", \"venga\". Sin abusar.",
"- NO repitas el pedido entero como un robot en cada turno. Reacciona breve y sigue.",
"- NO machaques con \"¿algo más?\" en cada frase. Pregúntalo como mucho una vez, cuando toque.",
"- Si no entiendes algo (es voz, puede oírse mal), pide que te lo repita con naturalidad.",
"",
"COMO LLEVAR EL PEDIDO (con soltura, sin guion rígido):",
"- Si el cliente saluda o duda, pónselo fácil: \"Dime, ¿qué te pongo?\".",
"- Apunta TODO lo que pida, aunque diga varias cosas de golpe.",
"- SOLO existen los platos de la CARTA de abajo. Si el cliente dice algo que NO está tal cual (p.ej. 'pepperoni'), dile con simpatía que no la tienes con ese nombre y ofrécele la más parecida mirando las descripciones; NO la apuntes hasta que elija una real de la carta.",
"- Si pide algo genérico o ambiguo ('una blanca', 'una pizza', 'una pasta', 'una ensalada'), NO elijas tú ni lo des por hecho: pregúntale cuál en concreto de la carta quiere.",
"- Al llamar a submit_order pasa SIEMPRE el menu_item_id exacto de cada plato; nunca mandes un producto que no tenga id de la carta.",
"- Si da alternativas (\"una caprese o si no una diávola\"), pregunta cuál quiere; no elijas tú.",
"- Apunta cambios (sin un ingrediente, extra de algo) sin darle vueltas.",
"- En algún momento natural, entérate de si es para RECOGER o a DOMICILIO. Si es a domicilio, pide la dirección con número.",
"- Pide nombre y teléfono juntos y una sola vez: \"¿A nombre de quién, y un teléfono de contacto?\".",
"- Si menciona una alergia, anótala con tranquilidad y dile que en cocina lo tienen en cuenta; no prometas que no haya trazas.",
"",
"OFRECER UN POCO MÁS (upselling, sube el ticket sin agobiar):",
"- Antes de cerrar, si el cliente no ha pedido bebida ni postre, ofrécele UNA cosa que encaje, con naturalidad: '¿Te pongo algo de beber?' o '¿Te animas con un postre para rematar?'.",
"- Si pide varias pizzas o veo que es para varios, puedes sugerir una entrada para compartir de la carta.",
"- Solo UNA sugerencia y una sola vez. Si dice que no, cierras sin insistir. Ofrece SOLO cosas que estén en la carta de abajo.",
"",
"CERRAR EL PEDIDO:",
"- Cuando lo tengas todo, haz un resumen CORTO y natural con el total aproximado (suma los precios de la carta). Ej: \"Vale, te marcho dos diávolas y una hawaiana sin piña, para recoger; unos treinta y cinco euros. ¿Te lo confirmo?\".",
"- En cuanto diga que sí, llama a submit_order con todos los datos. No la llames antes de tener: algún producto, tipo de pedido, nombre, teléfono (y dirección si es a domicilio) y el sí del cliente.",
"- Si te corrige, ajusta y remata rápido.",
"- Tras enviarlo, despídete cortita y con cariño.",
"",
"DECIR LOS PRECIOS EN VOZ (es una llamada, habla natural):",
"- Nunca leas el punto/coma decimal. 30,5 NO es 'treinta punto cinco': di 'treinta euros con cincuenta' o 'treinta euros y medio'. 30,20 es 'treinta euros con veinte'. 12 es 'doce euros'.",
"- No digas la palabra 'céntimos'. Usa 'con cincuenta', 'con veinte', 'y medio'. Si es importe redondo, solo 'X euros'.",
"- El total que digas tiene que ser la SUMA EXACTA de los precios de la carta de lo pedido. No te lo inventes ni lo redondees.",
"",
"CARTA DE " + restaurant.toUpperCase() + " (usa el id exacto al llamar a submit_order):",
buildMenuText()
  ].join("\n");
}

// ─── HERRAMIENTA submit_order ───────────────────────────────────────────────

const SUBMIT_ORDER_TOOL = {
  type: "function",
  function: {
    name: "submit_order",
    description: "Envía el pedido confirmado a cocina. Llamar SOLO tras el resumen y la confirmación explícita del cliente.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Lista de productos pedidos.",
          items: {
            type: "object",
            properties: {
              menu_item_id: { type: "string", description: "id exacto del plato en la carta (preferido)." },
              name:         { type: "string", description: "nombre del plato (si no tienes el id)." },
              quantity:     { type: "integer", description: "unidades.", minimum: 1 },
              size:         { type: "string", description: "tamaño si aplica, p.ej. 'grande'." },
              modifiers: {
                type: "array",
                description: "cambios del plato.",
                items: {
                  type: "object",
                  properties: {
                    type:  { type: "string", enum: ["remove", "extra", "add", "double", "note"], description: "remove=sin, extra=extra de, add=con, double=doble, note=nota libre." },
                    value: { type: "string", description: "ingrediente o texto, p.ej. 'piña', 'queso'." }
                  },
                  required: ["type", "value"]
                }
              },
              notes: { type: "string", description: "nota libre para cocina sobre este plato." }
            },
            required: ["quantity"]
          }
        },
        order_type:    { type: "string", enum: ["pickup", "delivery"], description: "pickup=recoger, delivery=domicilio." },
        customer_name: { type: "string" },
        phone:         { type: "string" },
        address:       { type: "string", description: "dirección completa, solo si order_type=delivery." },
        allergies:     { type: "array", items: { type: "string" }, description: "alergias o intolerancias declaradas." },
        notes:         { type: "string", description: "nota general del pedido." }
      },
      required: ["items", "order_type", "customer_name", "phone"]
    }
  }
};

// ─── LLAMADA A OPENAI ───────────────────────────────────────────────────────

function callOpenAI(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.reject(new Error("OPENAI_API_KEY no configurada"));
  const body = JSON.stringify(payload);
  const options = {
    hostname: "api.openai.com",
    path:     "/v1/chat/completions",
    method:   "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Authorization":  "Bearer " + apiKey
    }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error("OpenAI HTTP " + res.statusCode + ": " + data.slice(0, 300)));
        } catch (e) { reject(new Error("OpenAI parse error: " + e.message)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("OpenAI timeout (20s)")));
    req.write(body);
    req.end();
  });
}

// ─── MAPEO DEL PEDIDO + DISPATCH ────────────────────────────────────────────

function mapToolItem(toolItem) {
  const menuItem = getMenuItemById(toolItem.menu_item_id) || getMenuItemByName(toolItem.name);
  const modifiers = (toolItem.modifiers || [])
    .filter(m => m && m.value)
    .map(m => ({ type: m.type || "note", value: String(m.value), raw: String(m.value), confidence: 1 }));
  return {
    id:          menuItem ? menuItem.id : (toolItem.menu_item_id || null),
    displayName: menuItem ? menuItem.displayName : (toolItem.name || "Producto"),
    category:    menuItem ? menuItem.category : null,
    price:       menuItem ? menuItem.price : null,
    quantity:    Math.max(1, parseInt(toolItem.quantity, 10) || 1),
    size:        toolItem.size || null,
    modifiers,
    allergyFlags: [],
    kitchenNote: toolItem.notes || null,
    productConfidence: menuItem ? 1 : 0.4
  };
}

async function handleSubmitOrder(callId, args) {
  getOrCreateOrderSession(callId);
  const items = (args.items || []).map(mapToolItem).filter(Boolean);
  const orderType = args.order_type === "delivery" ? "delivery" : "pickup";
  const patch = {
    items,
    orderType,
    customerName: args.customer_name || null,
    phone: args.phone || null,
    allergies: Array.isArray(args.allergies) ? args.allergies : [],
    allergyNotes: (args.allergies && args.allergies.length) ? args.allergies.join(", ") : null,
    notes: args.notes || null,
    status: ORDER_STATUS.CUSTOMER_CONFIRMED
  };
  if (orderType === "delivery" && args.address) {
    patch.address = { street: null, number: null, floor: null, city: null, raw: args.address };
  }
  let order = updateOrderSession(callId, patch);
  let validation = {};
  try { validation = validateOrder(order); } catch (e) { validation = { ok: false, errors: [{ message: e.message }] }; }
  let dispatch;
  try { dispatch = await dispatchOrder(order, validation); }
  catch (e) { dispatch = { ok: false, error: e.message, order }; }
  if (dispatch && dispatch.ok) { try { startKitchenWatch(dispatch.order); } catch (_) {} }
  const name = args.customer_name ? ", " + String(args.customer_name).split(" ")[0] : "";
  const totalTxt = validation && validation.estimatedTotal != null ? " El total son unos " + validation.estimatedTotal + " euros." : "";
  const wayTxt = orderType === "delivery" ? "Te lo llevamos a domicilio en cuanto esté listo." : "Puedes pasar a recogerlo en cuanto esté listo.";
  const reply = dispatch && dispatch.ok
    ? "¡Perfecto" + name + "! Tu pedido queda confirmado y lo paso a cocina ahora mismo." + totalTxt + " " + wayTxt + " Si surge cualquier cosa te llamamos. ¡Gracias y hasta luego!"
    : "He tomado tu pedido" + name + " y lo dejo registrado, pero ha habido un problemilla al enviarlo a cocina; lo revisamos enseguida. Si quieres, también puedes llamarnos directamente al local. ¡Gracias!";
  return { ok: !!(dispatch && dispatch.ok), order: dispatch ? dispatch.order : order, reply, validation };
}

// ─── ENTRADA PRINCIPAL ──────────────────────────────────────────────────────

async function generateMartaReply(callId, incomingMessages) {
  const dialogue = (incomingMessages || [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));
  const messages = [{ role: "system", content: buildSystemPrompt() }].concat(dialogue);
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.4,
    max_tokens: 300,
    messages,
    tools: [SUBMIT_ORDER_TOOL],
    tool_choice: "auto"
  };
  const completion = await callOpenAI(payload);
  const choice = completion && completion.choices && completion.choices[0];
  const msg = choice ? choice.message : null;
  const toolCall = msg && msg.tool_calls && msg.tool_calls.find(tc => tc.function && tc.function.name === "submit_order");
  if (toolCall) {
    let args = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch (_) { args = {}; }
    const result = await handleSubmitOrder(callId, args);
    return { reply: result.reply, dispatched: result.ok, action: "customer_confirmed" };
  }
  const reply = (msg && msg.content && msg.content.trim()) ? msg.content.trim() : "Perdona, ¿me lo repites? No te he entendido bien.";
  return { reply, dispatched: false, action: "in_progress" };
}

module.exports = {
  generateMartaReply,
  buildSystemPrompt,
  buildMenuText,
  handleSubmitOrder,
  mapToolItem,
  getMenuItemById,
  getMenuItemByName,
  SUBMIT_ORDER_TOOL
};
