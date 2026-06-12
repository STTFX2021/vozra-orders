"use strict";

/**
 * VOZRA ORDERS — Marta LLM Brain (OpenAI)
 * Fase 8: Sustituye el slot-filler por reglas por un LLM real (gpt-4o-mini).
 *
 * Responsabilidad:
 *   - Recibe el historial de la conversación (formato OpenAI) que envía ElevenLabs.
 *   - Construye un system prompt con la persona de Marta + el menú real.
 *   - Llama a OpenAI Chat Completions con la herramienta `submit_order`.
 *   - Si el cliente confirma → el modelo llama a submit_order → mapeamos el pedido
 *     a la sesión, validamos y disparamos a cocina (Telegram), reutilizando los
 *     servicios existentes (order-validator, kitchen-ticket-builder, dispatch-adapter).
 *   - Devuelve el texto de Marta para que el endpoint lo envíe por SSE a ElevenLabs.
 *
 * Diseño:
 *   - Sin estado de conversación propio: el historial lo aporta ElevenLabs.
 *   - La sesión del pedido solo se usa en el momento del dispatch.
 *   - Si OpenAI falla o no hay API key → el llamador hace fallback al brain antiguo.
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
  pizza_ripiena:  "PIZZAS RELLENAS"
};

/**
 * Genera el texto del menú para el system prompt, agrupado por categoría.
 * Incluye id (para que el modelo lo pase exacto), nombre y precio.
 */
function buildMenuText() {
  const menu = loadMenu();
  const byCat = {};
  for (const it of menu.items) {
    if (it.isAvailable === false) continue;
    (byCat[it.category] = byCat[it.category] || []).push(it);
  }
  const order = Object.keys(CATEGORY_LABELS);
  const lines = [];
  for (const cat of order) {
    const items = byCat[cat];
    if (!items || !items.length) continue;
    lines.push(`\n## ${CATEGORY_LABELS[cat] || cat}`);
    items.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    for (const it of items) {
      const price = it.price != null ? `${it.price}€` : "s/p";
      const desc  = it.description ? ` — ${String(it.description).slice(0, 80)}` : "";
      lines.push(`- ${it.displayName} (id:${it.id}) · ${price}${desc}`);
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
  const menu = loadMenu();
  // exacto por displayName
  let hit = menu.items.find(i => norm(i.displayName) === n);
  if (hit) return hit;
  // por keyword
  hit = menu.items.find(i => (i.nlpKeywords || []).some(kw => norm(kw) === n));
  if (hit) return hit;
  // contiene
  hit = menu.items.find(i => norm(i.displayName).includes(n) || n.includes(norm(i.displayName)));
  return hit || null;
}

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const menu = loadMenu();
  const restaurant = menu.restaurantName || "La Locanda de Cancelada";
  return `Eres Marta, la teleoperadora de pedidos de ${restaurant}, un restaurante italiano en Cancelada (Málaga, España). Hablas español de España, con trato cercano, natural y profesional, como una camarera veterana. Respuestas BREVES y habladas (esto se convierte en voz): frases cortas, sin listas ni markdown, sin emojis.

TU OBJETIVO: tomar el pedido completo, correcto y confirmado, y enviarlo a cocina.

REGLAS DE LA CONVERSACIÓN:
1. Saluda solo si es el primer turno. No repitas el saludo.
2. Deja que el cliente pida con naturalidad. Puede pedir VARIOS platos a la vez: apúntalos TODOS. Si menciona alternativas ("una caprese, y si no una diábolo"), pregunta cuál quiere; no inventes.
3. Usa SOLO platos de la carta de abajo. Si piden algo que no existe, dilo y ofrece lo más parecido.
4. Si un plato admite cambios (sin un ingrediente, extra de algo), apúntalo.
5. Pregunta si es para RECOGER o a DOMICILIO. Si es a domicilio, pide la dirección completa con número.
6. Pide el NOMBRE y un TELÉFONO de contacto.
7. ALERGIAS: si el cliente menciona alergia o intolerancia, anótala y avisa de que cocina lo revisará; no garantices ausencia de trazas.
8. Antes de enviar, HAZ UN RESUMEN del pedido (productos, cantidades, total aproximado sumando los precios de la carta) y pregunta "¿Te lo confirmo así?".
9. SOLO cuando el cliente confirme expresamente, llama a la función submit_order con todos los datos. No la llames antes de tener: al menos un producto, tipo de pedido, nombre, teléfono (y dirección si es domicilio), y la confirmación del cliente.
10. Si el cliente dice que algo está mal, corrige y vuelve a resumir.

Tras enviar el pedido, despídete con amabilidad.

CARTA DE ${restaurant.toUpperCase()} (usa el id exacto al llamar a submit_order):
${buildMenuText()}`;
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
      "Authorization":  `Bearer ${apiKey}`
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
          else reject(new Error(`OpenAI HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        } catch (e) {
          reject(new Error(`OpenAI parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("OpenAI timeout (20s)")));
    req.write(body);
    req.end();
  });
}

// ─── MAPEO DEL PEDIDO + DISPATCH ────────────────────────────────────────────

/**
 * Convierte un item de la herramienta en un item de pedido válido para el ticket.
 */
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

/**
 * Procesa la llamada submit_order: rellena la sesión, valida y dispara a cocina.
 * Retorna { ok, order, reply, validation }.
 */
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
  try {
    dispatch = await dispatchOrder(order, validation);
  } catch (e) {
    dispatch = { ok: false, error: e.message, order };
  }

  if (dispatch && dispatch.ok) {
    try { startKitchenWatch(dispatch.order); } catch (_) {}
  }

  const name = args.customer_name ? `, ${String(args.customer_name).split(" ")[0]}` : "";
  const totalTxt = validation && validation.estimatedTotal != null
    ? ` El total son unos ${validation.estimatedTotal} euros.` : "";
  const wayTxt = orderType === "delivery"
    ? "Te lo llevamos a domicilio en cuanto esté listo."
    : "Puedes pasar a recogerlo en cuanto esté listo.";

  const reply = dispatch && dispatch.ok
    ? `¡Perfecto${name}! Tu pedido queda confirmado y lo paso a cocina ahora mismo.${totalTxt} ${wayTxt} Si surge cualquier cosa te llamamos. ¡Gracias y hasta luego!`
    : `He tomado tu pedido${name} y lo dejo registrado, pero ha habido un problemilla al enviarlo a cocina; lo revisamos enseguida. Si quieres, también puedes llamarnos directamente al local. ¡Gracias!`;

  return { ok: !!(dispatch && dispatch.ok), order: dispatch ? dispatch.order : order, reply, validation };
}

// ─── ENTRADA PRINCIPAL ──────────────────────────────────────────────────────

/**
 * Genera la respuesta de Marta para un turno.
 * @param {string} callId
 * @param {Array}  incomingMessages  mensajes en formato OpenAI que envía ElevenLabs
 * @returns {Promise<{reply: string, dispatched: boolean, action: string}>}
 */
async function generateMartaReply(callId, incomingMessages = []) {
  // Mantener solo el diálogo real (descartar el system de ElevenLabs; usamos el nuestro)
  const dialogue = (incomingMessages || [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));

  const messages = [{ role: "system", content: buildSystemPrompt() }, ...dialogue];

  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 350,
    messages,
    tools: [SUBMIT_ORDER_TOOL],
    tool_choice: "auto"
  };

  const completion = await callOpenAI(payload);
  const choice = completion && completion.choices && completion.choices[0];
  const msg = choice ? choice.message : null;

  // ¿El modelo decidió enviar el pedido?
  const toolCall = msg && msg.tool_calls && msg.tool_calls.find(tc => tc.function && tc.function.name === "submit_order");
  if (toolCall) {
    let args = {};
    try { args = JSON.parse(toolCall.function.arguments || "{}"); } catch (_) { args = {}; }
    const result = await handleSubmitOrder(callId, args);
    return { reply: result.reply, dispatched: result.ok, action: "customer_confirmed" };
  }

  const reply = (msg && msg.content && msg.content.trim())
    ? msg.content.trim()
    : "Perdona, ¿me lo repites? No te he entendido bien.";
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
