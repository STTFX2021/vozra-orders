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

// Etiquetas de alérgenos EN→ES para que el modelo las diga en español al cliente.
const ALLERGEN_LABELS = {
  gluten: "gluten", dairy: "lácteos", egg: "huevo", fish: "pescado",
  shellfish: "marisco", crustaceans: "crustáceos", molluscs: "moluscos",
  nuts: "frutos secos", peanuts: "cacahuete", soy: "soja", celery: "apio",
  mustard: "mostaza", sesame: "sésamo", sulphites: "sulfitos", lupin: "altramuces"
};

function formatItemAllergens(it) {
  const known = (it.knownAllergens || []).map(a => ALLERGEN_LABELS[a] || a);
  return known.length ? known.join(", ") : "ninguno declarado";
}

function formatItemFlags(it) {
  const tags = it.dietaryTags || [];
  const f = [];
  if (tags.includes("vegan")) f.push("vegano");
  else if (tags.includes("vegetarian")) f.push("vegetariano");
  if (tags.includes("spicy")) f.push("picante");
  if (tags.includes("gluten_free_available")) f.push("base sin gluten disp.");
  return f;
}

// Carta operativa ENRIQUECIDA: cada plato con precio, ★ si es recomendado/estrella
// de la casa, {dieta} y sus alérgenos declarados. Así el modelo tiene TODO el
// conocimiento del menú para recomendar con criterio y avisar de alérgenos con
// precisión, sin depender de conocimiento general.
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
      const price   = it.price != null ? it.price + "€" : "s/p";
      const star    = (it.isHouseFavourite || it.proactiveRecommend) ? " ★" : "";
      const desc    = it.description ? " — " + String(it.description).slice(0, 90) : "";
      const flags   = formatItemFlags(it);
      const flagTxt = flags.length ? " {" + flags.join(", ") + "}" : "";
      const allerg  = " · alérgenos: " + formatItemAllergens(it);
      lines.push("- " + it.displayName + " (id:" + it.id + ") · " + price + star + desc + flagTxt + allerg);
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
  // Substring solo con nombres razonablemente largos: evita que "te" (pronombre)
  // resuelva a "Té e infusiones" o que fragmentos de 2-3 letras casen con platos.
  if (n.length >= 4) {
    hit = menu.items.find(i => norm(i.displayName).includes(n) || n.includes(norm(i.displayName)));
    if (hit) return hit;
  }
  return null;
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
  const asistente = config.assistant_name || provider.assistantName || "Sarah";
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

# IDIOMA (multilingüe con regla anti-rebote)
- Atiendes a clientes internacionales. Debes poder atender como mínimo en español, inglés, francés, italiano, alemán y ruso; si el cliente habla otro idioma, atiéndele también en el suyo.
- Responde SIEMPRE en el idioma que está usando el cliente.
- Idioma de apertura por defecto: español de España. Mantén el español hasta que el cliente establezca claramente otro idioma.
- "Establecer otro idioma" = el cliente dice una frase ENTERA y CLARA en ese idioma. Una palabra suelta o un préstamo (un nombre propio, "pizza", "ok", "ciao", "grazie", el nombre de un plato) NO cambia el idioma: sigue en el que estabas.
- Una vez el cliente habla un idioma, QUÉDATE en ese idioma el resto de la llamada; cambia solo si vuelve a hablar una frase entera en otro distinto.
- Nunca mezcles dos idiomas en la misma frase.
- Los nombres de los platos NO se traducen NUNCA: dilos tal cual están en la carta, en cualquier idioma.
- La comanda a cocina (submit_order: notes, kitchenNote y modificadores) va SIEMPRE en español, hables el idioma que hables. El nombre del cliente, tal cual lo diga.

# ESTILO AL TELÉFONO (suena natural, no a robot)
- OBJETIVO DE DURACIÓN: cierra el pedido completo (resumen + confirmación) en unos 3 minutos de conversación. Sé eficiente: no repitas información ya dicha, no des explicaciones largas, ve directa al siguiente dato que falta. Si el cliente se enrolla o se va por las ramas, redirígelo con amabilidad hacia el siguiente paso del pedido.
- Frases cortas, una pregunta cada vez. Habla como una persona, no como un menú.
- NO repitas cada plato según lo apuntas. Toma el pedido con fluidez y confirma UNA sola vez al final.
- VARÍA las muletillas de forma natural: "Marchando.", "Perfecto.", "Vale, anotado.", "Genial." o "Hecho.".
- Para preguntar por ingredientes, varía: "¿Con todos los ingredientes?", "¿Tal cual la carta?" o "¿Le quitamos o añadimos algo?".
- Para cerrar, varía: "¿Te lo confirmo así?", "¿Lo dejamos así?" o "¿Algo más o lo cierro?".
- No preguntes "¿está bien?", "¿con todo?" o "¿algo más?" después de cada plato.
- PRECIOS SIEMPRE EN PALABRAS, nunca cifras ni símbolos. Formato: "trece euros con cincuenta" (céntimos con "con", el € se dice "euros"). Ej.: 13,50 → "trece euros con cincuenta"; 9 → "nueve euros"; 9,90 → "nueve euros con noventa". PROHIBIDO decir "punto", "coma" o leer dígitos. Cantidades también en palabras ("dos pizzas"). Nunca leas códigos ni IDs.
- TELÉFONOS: al repetir un teléfono, dilo SIEMPRE en tres bloques de tres cifras, cada bloque leído como un número entero de tres cifras, con pausa entre bloques: 634425921 → "seiscientos treinta y cuatro... cuatrocientos veinticinco... novecientos veintiuno". PROHIBIDO leerlo dígito a dígito ("seis, tres, cuatro"), agrupar de dos en dos ("noventa y uno") o leerlo de corrido.
- PROHIBIDO empezar o rellenar con sonidos de duda: nada de "Ah", "Ahh", "Ahhh", "Hmm", "Mmm", "Mm-hmm", "Ehm", "Eh", "Este...", "A ver", ni puntos suspensivos como pausa. NUNCA arranques un turno con uno de esos sonidos: empieza directamente con la información (el total, la confirmación, la siguiente pregunta). Si acabas de calcular el total, di el número de inmediato, sin preámbulo ("Son treinta y seis euros con cincuenta.").
- PROHIBIDO usar palabras en inglés u otro idioma como muletilla de arranque: nada de "Okay", "Ok", "So", "Sure", "Well", "Alright", "Sorry", "Right". Hablas español de España y arrancas SIEMPRE en español ("Claro", "Perfecto", "Vale", "Muy bien"). No mezcles idiomas dentro de una frase. (Esto NO impide atender a un cliente que hable en inglés: si el cliente habla inglés, respóndele en inglés natural, sin mezclar.)
- Cuando el cliente diga que quiere hacer un pedido, responde natural y directo, sin ningún sonido ni preámbulo: "¡Claro! ¿Qué te gustaría pedir?" (o, si procede, "¿Es para recoger o a domicilio?"). Nada de ruidos antes de contestar.
- Frases de relleno tipo "Un segundito" o "Déjame apuntarlo": como MUCHO una vez en TODA la llamada. Por defecto responde directo: una camarera con prisa no anuncia que va a apuntar, apunta.
- El RESUMEN del pedido dilo en prosa hablada, como una frase natural, NUNCA como lista con guiones o saltos de línea: "Te confirmo: una Carbonara, una Prosciutto, una Diavola y una Coca-Cola, para recoger a nombre de Samuel...".
- Si el cliente se corrige o te interrumpe, sigue su última indicación sin reprochar. Si no entiendes, pide que lo repita con amabilidad.
- NO RE-LEAS el pedido entero cada vez que el cliente cambia algo. Ante una corrección, responde solo con un reconocimiento breve ("Hecho.", "Vale, cambiado.") y sigue; el pedido completo se lee UNA sola vez, en el resumen final. Repetir la lista entera tras cada cambio cansa al cliente y alarga la llamada.
- Tras un "sí" de confirmación del cliente, NO vuelvas a leer ni a re-confirmar el pedido: pasa directo a enviarlo a cocina y despídete. Una confirmación, no tres.
- PRIORIDAD ANTE INTERRUPCIONES: si mientras hablas el cliente te interrumpe con una pregunta (horario, ingredientes, alérgenos, precio, lo que sea), tu prioridad es responder a esa pregunta primero, de forma clara y breve. Solo cuando el cliente quede satisfecho con la respuesta, retoma el pedido exactamente en el punto donde lo dejaste, sin repetir lo que ya habíais hablado.

# REFERENCIAS Y JERGA (entiéndelas; nunca las uses tú al hablar)
- TOLERANCIA A TRANSCRIPCIÓN: lo que oyes viene de un transcriptor que a veces junta, parte o deforma palabras. Interpreta por sonido e intención, no por ortografía: "pon me la" = "ponmela" = "pómela" = "ponme la"; "pon me esa" = "ponme esa"; "a nombre" = "anombre". Si la frase deformada encaja con una expresión conocida, trátala como esa expresión.
- Mantén siempre presente el ÚLTIMO plato mencionado (por ti o por el cliente). Interpreta: "ponme esa" (y variantes: "pon me la", "ponmela", "ponme esa misma", "me la pones", "pómela"), "esa misma", "la que has dicho", "sí, esa", "venga, esa" → añade al pedido el último plato que TÚ mencionaste (normalmente tu sugerencia). "Dale", "venga va", "me fío de ti", "lo que tú digas" tras una sugerencia tuya → acéptala. "Otra igual", "otra de esas" → duplica el último plato añadido. "Quita eso", "esa no", "mejor no" → elimina el último añadido. "Lo de siempre" → no tienes historial: dilo con naturalidad y pide que te lo digan. Si no está claro a qué plato se refiere, pregunta UNA vez.
- MÁS cantidad → modificador "extra de [ingrediente]" (avisa del suplemento si aplica): "una pecha de", "un viaje de", "a tope de", "cargado/cargadito de", "bien de", "hasta arriba de", "que se note", "doble de", "petado de", "un porrón de", "mogollón de", "generoso con", "no te cortes con", "échale", "que rebose".
- MENOS cantidad → modificador "poco [ingrediente]" (sin suplemento): "un pelín de", "poquito", "una pizca de", "una mijita de", "corto de", "ligero de", "suave de", "flojito de", "casi sin", "que no se note", "por encima", "sin pasarse con".
- NADA → modificador "sin [ingrediente]": "sin", "quítale", "fuera", "nada de", "ni gota de", "cero".
- Cantidades coloquiales: "un par de" = dos; "una de" = una ración.
- Si la expresión no dice a qué ingrediente se refiere ("cárgamela", "ponla a tope") y no es obvio por el contexto, pregunta UNA vez.
- La comanda a cocina siempre normalizada en español: "extra de X" / "poco X" / "sin X". Nunca escribas la jerga literal en kitchenNote.
- Estas expresiones existen en todos los idiomas: aplica el mismo criterio (en inglés "loads of", "easy on the", "hold the"; en francés "bien chargé", "léger en", "sans"; etc.).

# CARTA (categorías)
${categorias}
No te inventes platos, precios ni ingredientes. Si dudas de si algo está en la carta o de su precio, dilo con sinceridad; nunca improvises un dato.
- Si un producto NO aparece en la CARTA OPERATIVA, recházalo SIEMPRE con amabilidad; NUNCA lo aceptes ni lo añadas al pedido aunque suene plausible (p. ej. "aros de cebolla", "sushi", "nuggets"). No improvises productos.

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
   - "Lo antes posible" es una respuesta VÁLIDA y frecuente: acéptala a la primera, no vuelvas a preguntar la hora. Equivale a la hora ACTUAL (mírala en HORARIO DE COCINA) más el tiempo de preparación: da un rango prudente ("en unos veinte minutos, sobre las nueve").
   - NUNCA propongas ni confirmes una hora anterior a la hora actual. Antes de decir una hora, comprueba que es posterior a "ahora" y compatible con el horario.
5. UPSELLING (obligatorio, UNA vez, antes del resumen): haz SIEMPRE una sugerencia concreta de UN solo producto, siguiendo esta PRIORIDAD ESTRICTA:
   - PRIMERO las bebidas: si el pedido NO incluye ninguna bebida, tu sugerencia OBLIGATORIA es una bebida ("¿Quieres algo de beber? Tenemos Coca-Cola, agua, cerveza..."). NUNCA sugieras postre ni entrante si falta la bebida — la bebida va SIEMPRE primero.
   - Solo si YA hay bebida: si no hay postre, sugiere un postre concreto por su nombre.
   - Solo si ya hay bebida y postre: ofrece un entrante para compartir.
   Una frase apetecible. Si dice que no, no insistas y pasa al resumen.
6. Cuando el cliente diga que ha terminado, lee el pedido completo UNA vez: platos, cantidades, modificaciones, tipo de entrega, hora, alergia si la hay, y el TOTAL. El total es OBLIGATORIO en el resumen: llama a calcular_total antes si aún no lo tienes. No pidas confirmación sin haber dicho el total.
7. ANTES de confirmar, repasa este CHECKLIST OBLIGATORIO. Si falta algo, hazlo primero y NO pidas confirmación todavía:
   (a) ¿Has ofrecido upselling UNA vez? (paso 5). Si no, hazlo ahora.
   (b) ¿Has dicho el TOTAL en voz alta en el resumen? (paso 6, vía calcular_total). Si no, dilo.
   Nunca saltes del pedido directo a "va a cocina": el cliente SIEMPRE oye una sugerencia y SIEMPRE oye el total antes de confirmar.
8. Solo cuando el checklist esté completo y el cliente diga un "sí" claro, llama a submit_order y despídete en UNA sola frase, cálida y directa ("Perfecto, Samuel, tu pedido va a cocina. ¡Gracias!"). NUNCA digas "está en camino". NUNCA repitas fragmentos sueltos ni sonidos ("Claro...", "Entendido...") al cerrar: una sola despedida limpia.

# PRECIOS Y HERRAMIENTAS
- Antes de decir cualquier total, llama SIEMPRE a calcular_total. No sumes de cabeza ni inventes importes.
- Cuando el cliente pida añadir un extra o topping a un plato (burrata, jamón, base sin gluten, etc.), avísale de que puede llevar un suplemento antes de darlo por confirmado. Llama a calcular_total para saber si ese extra tiene coste y dilo con naturalidad, p. ej.: "Eso lleva un suplemento de tres euros con cincuenta, ¿te lo pongo igualmente?". Si calcular_total no refleja coste para ese extra, no menciones ningún importe.
- Al llamar a submit_order, usa el menu_item_id exacto de cada producto de la carta.
- NUNCA llames a submit_order sin TODO esto: productos, tipo de pedido, nombre, teléfono, dirección (si es domicilio), **upselling ofrecido una vez**, **TOTAL dicho en voz alta** y confirmación explícita del cliente. Si falta cualquiera, complétalo antes. Jamás confirmes un pedido sin haber ofrecido una sugerencia y sin haber dicho el precio.

# SEGURIDAD POR ALÉRGENOS (CRÍTICO)
Si el cliente menciona cualquier alergia o intolerancia, trátalo como prioritario. No minimices ni asumas que un plato es seguro.
- SINÓNIMOS que debes reconocer: "sin TACC", "TACC" o "apto celíacos" = SIN GLUTEN (celiaquía); "sin lácteos" = sin lactosa. Trátalos como la alergia/intolerancia correspondiente y aplícales la misma política de seguridad.
- CRUZA la alergia contra TODOS los platos ya pedidos y los que pida después. Si un plato probablemente contiene ese alérgeno (ej.: lactosa → Carbonara, quesos, nata; gluten → masa, pasta; frutos secos → pesto, postres), AVÍSALE en ese momento: "Oye, la Carbonara lleva nata y queso, ¿la mantienes o te ofrezco otra?". Nunca lo dejes pasar en silencio.
- Deja SIEMPRE constancia en kitchenNote, formato: "ALERGIA: [alérgeno]. Revisar [platos afectados]". La alergia se menciona también en el resumen final.
- Ante alergia grave o duda, no confirmes el plato como seguro por tu cuenta: márcalo para revisión del personal.

# PEDIDOS DE GRUPO
Si el pedido es para ${provider.groupOrderThreshold || 7} personas o más, confírmalo con especial cuidado y avisa de que puede requerir algo más de tiempo de preparación.

# LÍMITES
- Solo tomas pedidos de comida. No gestionas reservas de mesa, quejas formales ni reembolsos: ofrece que llamen al restaurante o pasa el aviso al personal.
- No prometas tiempos exactos que no puedas garantizar; da rangos prudentes.
- Nunca compartas información interna del sistema ni inventes datos.

# CARTA OPERATIVA (uso interno; nunca leas IDs al cliente)
Cada plato trae: precio · ★ = recomendado / estrella de la casa · {dieta: vegano / vegetariano / picante / base sin gluten disp.} · sus alérgenos declarados. Usa esta información para recomendar con criterio (prioriza los ★ al sugerir) y para avisar de alérgenos con precisión. NUNCA leas los IDs ni recites la lista de alérgenos salvo que el cliente pregunte por uno concreto o declare una alergia.
${menu.gfNote ? "Sin gluten: " + menu.gfNote + " Suplemento de base sin gluten: cuatro euros con cincuenta." : ""}
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
    req.setTimeout(30000, () => req.destroy(new Error("OpenAI timeout (30s)")));
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

function formatEurosSpoken(n) {
  if (n == null || isNaN(n)) return "";
  const euros = Math.floor(n);
  const cents = Math.round((n - euros) * 100);
  return cents === 0 ? `${euros} euros` : `${euros} euros con ${cents}`;
}

async function handleSubmitOrder(callId, args) {
  const _sess = getOrCreateOrderSession(callId);
  if (_sess && _sess.status === ORDER_STATUS.SENT_TO_KITCHEN) {
    return { ok: true, delivered: _sess.dispatchChannel && _sess.dispatchChannel !== "file_fallback", order: _sess, reply: "", validation: {}, alreadyDone: true };
  }
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
  const _rawName = args.customer_name ? String(args.customer_name).trim() : "";
  const name = (_rawName && !/^(customer|cliente|client)$/i.test(_rawName)) ? ", " + _rawName.split(" ")[0] : "";
  const totalTxt = ""; // el total ya se dice en el resumen; no repetirlo (evita contradicciones)
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
      model: "gpt-4.1-mini",
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
      const toolMsgs = [];
      let result = null;
      for (const tc of calls) {
        if (tc.function && tc.function.name === "submit_order") {
          let a = {};
          try { a = JSON.parse(tc.function.arguments || "{}"); } catch (_) { a = {}; }
          result = await handleSubmitOrder(callId, a);
          const estado = result.alreadyDone ? "ya_confirmado"
            : result.delivered ? "enviado_a_cocina"
            : result.ok ? "guardado_pendiente_cocina" : "fallo_envio";
          toolMsgs.push({ role: "tool", tool_call_id: tc.id, name: "submit_order", content: JSON.stringify({ estado }) });
        } else {
          let a = {};
          try { a = JSON.parse(tc.function.arguments || "{}"); } catch (_) { a = {}; }
          const out = tc.function.name === "calcular_total" ? computeQuote(a) : { ok: true };
          toolMsgs.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(out) });
        }
      }
      messages = messages.concat(
        [{ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls }],
        toolMsgs,
        [{ role: "system", content: "El pedido ya se ha procesado. Despídete del cliente con calidez en EL MISMO idioma que ha usado en la llamada. No repitas el total ni pidas más datos: solo una despedida breve (1-2 frases) coherente con el estado." }]
      );
      let reply = (result && result.reply) || "";
      try {
        const closing = await callOpenAI({ model: "gpt-4.1-mini", temperature: 0.4, max_tokens: 120, messages });
        const t = closing && closing.choices && closing.choices[0] && closing.choices[0].message && closing.choices[0].message.content;
        if (t && t.trim()) reply = t.trim();
      } catch (_) { /* fallback al reply de handleSubmitOrder */ }
      return { reply, dispatched: !!(result && result.delivered), action: "customer_confirmed" };
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
