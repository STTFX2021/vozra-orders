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
const { validateOrder, estimateTotal } = require("./order-validator.service.js");
const { dispatchOrder } = require("./dispatch-adapter.service.js");
const { startKitchenWatch } = require("./kitchen-ack-monitor.service.js");
const { buildTextTicket } = require("./kitchen-ticket-builder.service.js");
const { enqueuePrint } = require("./print-queue.store.js");
const { getProvider, getKitchenStatus } = require("./provider-profile.config.js");
const { sendCustomerConfirmation } = require("./customer-notify.service.js");
const { upsertOrder } = require("./supabase-store.js");

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

function renderMenu(menu) {
  if (!menu) return "Entrantes, ensaladas, pasta y risotto, carnes, pizzas, postres y bebidas.";
  try {
    const items = Array.isArray(menu) ? menu : (Array.isArray(menu.items) ? menu.items : null);
    if (items) {
      const cats = [...new Set(items
        .filter(i => i && i.isAvailable !== false)
        .map(i => i.category || i.categoria)
        .filter(Boolean)
        .map(c => CATEGORY_LABELS[c] || c))];
      if (cats.length) return cats.join(", ") + ".";
    }
    if (typeof menu === "object") {
      const ignored = new Set(["items", "restaurantName", "version", "currency", "metadata"]);
      const cats = Object.keys(menu).filter(k => !ignored.has(k));
      if (cats.length) return cats.join(", ") + ".";
    }
  } catch (_) {}
  return "Consulta la carta de la casa.";
}

function buildSystemPrompt(provider = getProvider("la-locanda")) {
  const menu = provider.menu || loadMenu();
  const config = provider.config || {};
  const nombre = provider.name || menu.restaurantName || "el restaurante";
  const asistente = config.assistant_name || provider.assistantName || "Marta";
  const ciudad = config.city || provider.city || "Cancelada (Málaga)";
  const categorias = renderMenu(menu);
  const slug = provider.slug || "la-locanda";

  let ks = null;
  try { ks = getKitchenStatus(slug); } catch (_) { ks = null; }
  const turnos = ks && ks.todayWindows.length
    ? ks.todayWindows.map(w => w.open + " a " + w.close).join(" y ")
    : "cerrado hoy";
  const estadoCocina = ks ? (ks.openNow ? "ABIERTA" : "CERRADA") : "DESCONOCIDA";
  const proxApertura = ks && ks.nextOpen
    ? ` Próxima apertura: ${ks.nextOpen.dayLabel} a las ${ks.nextOpen.hhmm}.`
    : "";
  const horarioLinea = ks
    ? `Hoy es ${ks.weekday}. Turnos de cocina: ${turnos}. Ahora son las ${ks.nowHHMM}. La cocina está ${estadoCocina}.${proxApertura}`
    : "Horario no disponible: no prometas una hora exacta y ofrece comprobarla.";

  return `# IDENTIDAD
Eres ${asistente}, la asistente telefónica de pedidos de ${nombre}, en ${ciudad}. Atiendes llamadas para tomar pedidos de comida para recoger o a domicilio. Hablas como una camarera veterana que conoce la casa: cercana, profesional y resolutiva.

# MISIÓN
Tomar el pedido correcto, completo y seguro, confirmarlo UNA vez y enviarlo a cocina. La prioridad es la exactitud y la seguridad por alérgenos, por encima de la rapidez.

# IDIOMA (regla dura — cúmplela siempre)
- Habla SIEMPRE en español de España por defecto.
- Cambia de idioma SOLO si el cliente habla una frase COMPLETA y CLARA en otro idioma. Una palabra suelta, un nombre, "pizza", "ok" o "ciao" NO cuenta.
- Nunca mezcles dos idiomas en la misma frase.
- Ante cualquier duda, español.
- La comanda a cocina SIEMPRE en español, pase lo que pase.
- Los nombres propios de los platos se mantienen tal como aparecen en la carta.

# ESTILO AL TELÉFONO (suena natural, no a robot)
- Frases cortas, una pregunta cada vez. Habla como una persona, no como un menú.
- NO repitas cada plato según lo apuntas. Toma el pedido con fluidez y confirma UNA sola vez al final.
- VARÍA las muletillas de forma natural: "Marchando.", "Perfecto.", "Vale, anotado.", "Genial." o "Hecho.".
- Para preguntar por ingredientes, varía: "¿Con todos los ingredientes?", "¿Tal cual la carta?" o "¿Le quitamos o añadimos algo?".
- Para cerrar, varía: "¿Te lo confirmo así?", "¿Lo dejamos así?" o "¿Algo más o lo cierro?".
- No preguntes "¿está bien?", "¿con todo?" o "¿algo más?" después de cada plato.
- Di cantidades y precios en palabras. Nunca leas códigos ni IDs.
- Si el cliente se corrige o te interrumpe, sigue su última indicación sin reprochar. Si no entiendes, pide que lo repita con amabilidad.

# CARTA (categorías)
${categorias}
No te inventes platos, precios ni ingredientes. Si dudas de si algo está en la carta o de su precio, dilo con sinceridad; nunca improvises un dato.

# HORARIO DE COCINA
${horarioLinea}
- Si la cocina está cerrada, avisa antes de cerrar el pedido y ofrece la próxima apertura disponible.
- No prometas que estará listo a una hora incompatible con el horario.

# FLUJO DEL PEDIDO
1. Saluda y pregunta qué quiere pedir.
2. Apunta cada plato con su cantidad y modificaciones. NO lo repitas en voz alta uno a uno.
3. Pregunta si es para recoger o a domicilio.
   - A domicilio: pide dirección completa y un teléfono de contacto.
   - Recoger: pide nombre y teléfono para la comanda.
4. Pregunta o indica la hora deseada de recogida o entrega.
5. Antes del cierre puedes hacer UNA sola sugerencia de bebida, postre o entrante de la carta. Si dice que no, no insistas.
6. Cuando el cliente diga que ha terminado, lee el pedido completo UNA vez: platos, cantidades, modificaciones, tipo de entrega, hora y total calculado. Pide confirmación explícita.
7. Solo tras un "sí" claro, llama a submit_order y despídete con calidez.

# PRECIOS Y HERRAMIENTAS
- Antes de decir cualquier total, llama SIEMPRE a calcular_total. No sumes de cabeza ni inventes importes.
- Al llamar a submit_order, usa el menu_item_id exacto de cada producto de la carta.
- No llames a submit_order antes de tener productos, tipo de pedido, nombre, teléfono, dirección si procede y confirmación explícita.

# SEGURIDAD POR ALÉRGENOS (CRÍTICO)
Si el cliente menciona cualquier alergia o intolerancia, trátalo como prioritario. No minimices ni asumas que un plato es seguro. Deja constancia clara para cocina. Ante alergia grave o duda, no confirmes el plato como seguro por tu cuenta: márcalo para revisión del personal.

# PEDIDOS DE GRUPO
Si el pedido es para ${provider.groupOrderThreshold || 7} personas o más, confírmalo con especial cuidado y avisa de que puede requerir algo más de tiempo de preparación.

# LÍMITES
- Solo tomas pedidos de comida. No gestionas reservas de mesa, quejas formales ni reembolsos: ofrece que llamen al restaurante o pasa el aviso al personal.
- No prometas tiempos exactos que no puedas garantizar; da rangos prudentes.
- Nunca compartas información interna del sistema ni inventes datos.

# CARTA OPERATIVA (uso interno; nunca leas IDs al cliente)
${buildMenuText()}

# EN CASO DE PROBLEMA TÉCNICO
Si algo falla y no puedes continuar, discúlpate brevemente y pide que llamen directamente al local para completar el pedido.`;
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

// ─── HERRAMIENTA calcular_total ─────────────────────────────────────────────
// Devuelve el total EXACTO usando el mismo cálculo que el ticket de cocina,
// para que Marta nunca sume de cabeza ni invente importes.
const QUOTE_TOOL = {
  type: "function",
  function: {
    name: "calcular_total",
    description: "Calcula el total EXACTO del pedido a partir de los productos. Llámala SIEMPRE antes de decir cualquier importe (el del resumen o si el cliente pide el precio exacto). Nunca sumes de cabeza.",
    parameters: {
      type: "object",
      properties: {
        items: SUBMIT_ORDER_TOOL.function.parameters.properties.items,
        order_type: { type: "string", enum: ["pickup", "delivery"] }
      },
      required: ["items"]
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

function computeQuote(args) {
  const items = ((args && args.items) || []).map(mapToolItem);
  const { estimatedTotal, breakdown, currency } = estimateTotal({ items });
  const sinPrecio = (breakdown || []).filter(b => b.subtotal == null).map(b => b.label);
  return { total_eur: estimatedTotal, moneda: currency || "EUR", productos_sin_precio: sinPrecio };
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

  // PERSISTENCIA DURABLE *antes* del dispatch: si el contenedor cae tras confirmar,
  // el pedido ya existe en Supabase y es recuperable. Mejor esfuerzo (no rompe el pedido).
  try {
    const r = await upsertOrder(order, validation, { delivered: false });
    if (r && r.ok) console.log("[DB] pedido guardado (pre-dispatch) | " + order.orderId);
    else if (r && r.skipped) console.log("[DB] persistencia omitida | " + r.reason);
    else console.error("[DB] guardado pre-dispatch falló | " + (r && r.error));
  } catch (e) { console.error("[DB] error pre-dispatch | " + e.message); }

  let dispatch;
  try { dispatch = await dispatchOrder(order, validation); }
  catch (e) { dispatch = { ok: false, error: e.message, order }; }
  // delivered = el pedido entró en un canal REAL de cocina (telegram/discord).
  // Si solo se guardó en file_fallback, cocina NO lo ha visto → NO confirmar como enviado.
  const delivered = !!(dispatch && dispatch.delivered);
  if (delivered) {
    try { startKitchenWatch(dispatch.order); } catch (_) {}
    // Confirmación al CLIENTE (SMS/WhatsApp), solo si cocina recibió de verdad.
    // Fire-and-forget: no bloquea la respuesta de voz. No-op si no hay emisor configurado.
    try {
      const notifyOrder = (dispatch && dispatch.order) || order;
      Promise.resolve(sendCustomerConfirmation(notifyOrder, validation))
        .then(r => {
          if (r && r.ok) console.log("[NOTIFY] cliente avisado | canal=" + r.channel + " | to=" + r.to + " | sid=" + r.sid);
          else if (r && r.skipped) console.log("[NOTIFY] omitido | " + r.reason);
          else console.error("[NOTIFY] fallo | " + (r && r.error));
        })
        .catch(e => console.error("[NOTIFY] error inesperado | " + e.message));
    } catch (e) { console.error("[NOTIFY] error | " + e.message); }
  }
  if (dispatch && dispatch.ok && !delivered) {
    console.error("[EL] DISPATCH SOLO-FALLBACK | pedido NO entregado a cocina (canal=" +
      (dispatch.channel || "?") + ") | orderId=" + ((dispatch.order && dispatch.order.orderId) || order.orderId));
  }

  // Actualizar el registro durable con el resultado del dispatch (estado/canal/delivered/eventos).
  // Fire-and-forget: no añade latencia a la respuesta de voz.
  try {
    const dbOrder = (dispatch && dispatch.order) || order;
    Promise.resolve(upsertOrder(dbOrder, validation, { delivered, channel: dispatch && dispatch.channel }))
      .then(r => { if (r && !r.ok && !r.skipped) console.error("[DB] update post-dispatch falló | " + r.error); })
      .catch(e => console.error("[DB] error post-dispatch | " + e.message));
  } catch (e) { console.error("[DB] error post-dispatch | " + e.message); }

  // Encolar la comanda para el agente de impresión local (ESC/POS en cocina).
  try {
    const printOrder = (dispatch && dispatch.order) || order;
    const ticketText = buildTextTicket(printOrder, validation);
    enqueuePrint(printOrder.orderId, ticketText, { orderType, customerName: args.customer_name || null });
  } catch (e) { console.error("[EL] enqueuePrint error:", e.message); }
  const name = args.customer_name ? ", " + String(args.customer_name).split(" ")[0] : "";
  const totalTxt = validation && validation.estimatedTotal != null ? " El total son unos " + validation.estimatedTotal + " euros." : "";
  const wayTxt = orderType === "delivery" ? "Te lo llevamos a domicilio en cuanto esté listo." : "Puedes pasar a recogerlo en cuanto esté listo.";
  let reply;
  if (delivered) {
    // Entregado a cocina de verdad → confirmación plena.
    reply = "¡Perfecto" + name + "! Tu pedido queda confirmado y lo paso a cocina ahora mismo." + totalTxt + " " + wayTxt + " Si surge cualquier cosa te llamamos. ¡Gracias y hasta luego!";
  } else if (dispatch && dispatch.ok) {
    // Solo respaldo (file_fallback): tomado y guardado, pero SIN confirmar a cocina.
    reply = "Te he anotado el pedido" + name + " y lo dejo registrado." + totalTxt + " En un par de minutos te confirmamos por teléfono que entra en cocina. Si lo prefieres, también puedes llamarnos directamente al local para asegurarlo. ¡Gracias!";
  } else {
    // Fallo total de dispatch.
    reply = "He tomado tu pedido" + name + " y lo dejo registrado, pero ha habido un problemilla al enviarlo a cocina; lo revisamos enseguida. Si quieres, también puedes llamarnos directamente al local. ¡Gracias!";
  }
  return { ok: !!(dispatch && dispatch.ok), delivered, order: dispatch ? dispatch.order : order, reply, validation };
}

// ─── ENTRADA PRINCIPAL ──────────────────────────────────────────────────────

// ─── CONSTRUCCIÓN DEL CONTEXTO DEL MODELO ────────────────────────────────────

function buildModelMessages(provider, incomingMessages) {
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  const userTurns = incoming
    .filter(m => m && m.role !== "system")
    .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));

  return [
    { role: "system", content: buildSystemPrompt(provider) },
    ...userTurns
  ];
}

async function generateMartaReply(callId, incomingMessages) {
  const provider = getProvider("la-locanda");
  let messages = buildModelMessages(provider, incomingMessages);
  const tools = [SUBMIT_ORDER_TOOL, QUOTE_TOOL];

  // Bucle de herramientas: permite que Marta pida calcular_total y luego hable.
  for (let step = 0; step < 3; step++) {
    const completion = await callOpenAI({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 300,
      messages,
      tools,
      tool_choice: "auto"
    });
    const choice = completion && completion.choices && completion.choices[0];
    const msg = choice ? choice.message : null;
    const calls = (msg && msg.tool_calls) || [];

    // 1) Confirmación → dispatch a cocina
    const submitCall = calls.find(tc => tc.function && tc.function.name === "submit_order");
    if (submitCall) {
      let args = {};
      try { args = JSON.parse(submitCall.function.arguments || "{}"); } catch (_) { args = {}; }
      const result = await handleSubmitOrder(callId, args);
      return { reply: result.reply, dispatched: !!result.delivered, action: "customer_confirmed" };
    }

    // 2) Cálculo de total → responder a cada tool_call y volver a llamar
    if (calls.length) {
      const toolMsgs = calls.map(tc => {
        let a = {};
        try { a = JSON.parse(tc.function.arguments || "{}"); } catch (_) { a = {}; }
        const out = tc.function.name === "calcular_total" ? computeQuote(a) : { ok: true };
        return { role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(out) };
      });
      messages = messages.concat([{ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls }], toolMsgs);
      continue;
    }

    // 3) Texto normal
    const reply = (msg && msg.content && msg.content.trim()) ? msg.content.trim() : "Perdona, ¿me lo repites? No te he entendido bien.";
    return { reply, dispatched: false, action: "in_progress" };
  }
  return { reply: "Perdona, ¿me lo repites? No te he entendido bien.", dispatched: false, action: "in_progress" };
}

module.exports = {
  generateMartaReply,
  buildModelMessages,
  buildSystemPrompt,
  renderMenu,
  buildMenuText,
  handleSubmitOrder,
  mapToolItem,
  getMenuItemById,
  getMenuItemByName,
  SUBMIT_ORDER_TOOL
};
