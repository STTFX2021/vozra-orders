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
const { getCustomerByPhone, upsertCustomer } = require("./customer-store.js");
const { checkDeliveryAddress } = require("./delivery-zone.service.js");
const { applyPromotions, listActivePromotions } = require("./promotions.service.js");
const { lookupOrdersForCustomer, registerIncident } = require("./incident.service.js");

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

// Filtra nombres placeholder que el modelo a veces cuela ("Cliente", "Customer"):
// nunca deben usarse como nombre real ni guardarse en el perfil.
function realCustomerName(n) {
  const s = n == null ? "" : String(n).trim();
  if (!s || /^(cliente|customer|client|usuario|user)$/i.test(s)) return null;
  return s;
}

function buildSystemPrompt(provider = getProvider("la-locanda"), profile = null) {
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

  // Bloque de cliente recurrente: solo aparece si hay perfil guardado CON consentimiento.
  const nombreCli = realCustomerName(profile && profile.name);
  const dirCli = profile && profile.address ? (profile.address.raw || profile.address) : null;
  const perfilBloque = profile
    ? `\n# CLIENTE RECURRENTE (perfil guardado con su consentimiento previo)
Este teléfono ya tiene un perfil.${nombreCli ? ` El cliente se llama ${nombreCli}.` : ""}${dirCli ? ` Dirección de reparto guardada: ${dirCli}.` : ""}
- Salúdale por su nombre al empezar${nombreCli ? ` ("¡Hola, ${String(nombreCli).split(" ")[0]}! Soy Sarah, ¿qué te pongo hoy?")` : ""}.
- NO le pidas el teléfono: ya lo tienes.${nombreCli ? " Tampoco el nombre." : " Su nombre NO consta: pídeselo con naturalidad cuando haga falta (nunca le llames \"cliente\")."}
- Si el pedido es a domicilio, NO preguntes la dirección: CONFÍRMALA ("¿Te lo llevo a la misma dirección, ${dirCli || "la de siempre"}?"). Solo si dice que ha cambiado, pídele la nueva.
- La dirección guardada sirve SOLO para DOMICILIO. Si el pedido es para RECOGER, NI LA MENCIONES: la recogida es SIEMPRE en el local (${nombre}). JAMÁS digas la dirección del cliente como lugar de recogida.
- Usa esos datos guardados en la comanda salvo que el cliente los cambie en esta llamada.
`
    : "";

  return `# IDENTIDAD
Eres ${asistente}, la asistente telefónica de pedidos de ${nombre}, en ${ciudad}. Atiendes llamadas para tomar pedidos de comida para recoger o a domicilio. Hablas como una camarera veterana que conoce la casa: cercana, profesional y resolutiva.
${perfilBloque}

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
- OBJETIVO DE DURACIÓN: cierra el pedido completo (resumen + confirmación) en MENOS de 3 minutos siempre que puedas. Sé eficiente: no repitas información ya dicha, no des explicaciones largas, ve directa al siguiente dato que falta. Si el cliente se enrolla, redirígelo con amabilidad hacia el siguiente paso. El tiempo es valioso: coge el pedido rápido.
- NO preguntes por opciones que el cliente no ha pedido (tipo de base, tamaños, extras): asume siempre lo estándar y sigue. Solo preguntas por una variante si el cliente la menciona o si es imprescindible para completar el pedido.
- ANTI-BUCLE GENERAL: NUNCA repitas la misma pregunta dos veces seguidas. Si tras preguntar una vez el cliente no lo aclara, toma la opción por defecto más razonable y CONTINÚA con el pedido; el cliente podrá corregirte. Nunca te quedes atascada insistiendo en lo mismo.
- Frases cortas, una pregunta cada vez. Habla como una persona, no como un menú.
- NO repitas cada plato según lo apuntas. Toma el pedido con fluidez y confirma UNA sola vez al final.
- NO recites los ingredientes de un plato cuando el cliente lo pide. Simplemente anótalo y sigue ("Marchando.", "Vale, anotado."). Solo dices los ingredientes si el cliente PREGUNTA por ellos ("¿qué lleva?", "¿qué tiene?", "¿cuáles son los ingredientes?", "¿lleva X?" o cualquier expresión parecida); entonces sí los enumeras con claridad. La ÚNICA excepción es una alerta de alérgeno (ver SEGURIDAD POR ALÉRGENOS): si el cliente ha declarado alergia, avisas del ingrediente peligroso aunque no pregunte.
- VARÍA las muletillas de forma natural: "Marchando.", "Perfecto.", "Vale, anotado.", "Genial." o "Hecho.".
- NO preguntes de forma proactiva si quiere modificar cada plato ("¿le quitamos o añadimos algo?", "¿con todos los ingredientes?"). Toma cada plato TAL CUAL la carta; el cliente ya te dirá si quiere algún cambio. Solo gestionas las modificaciones que el cliente pida por su cuenta.
- TAMAÑO: las pizzas de La Locanda tienen un ÚNICO tamaño. NO preguntes por el tamaño. Solo si el cliente pregunta o pide un tamaño concreto (mediana o familiar), infórmale con naturalidad de que hay un único tamaño estándar. (Si algún día la carta tuviera varios tamaños, entonces sí habría que preguntarlo.)
- Para cerrar, varía: "¿Te lo confirmo así?", "¿Lo dejamos así?" o "¿Algo más o lo cierro?".
- SUGERENCIAS (cuando el cliente pide "sugiéreme algo" y está indeciso): NO recites varios platos ni una categoría entera. Ve cercando el círculo. Primero ACOTA con una pregunta corta: "¿Te apetece más pizza, pasta, carne o algo de pescado?". Con su respuesta, si hace falta afina una vez más ("¿la prefieres picante o suave?") y entonces sugiere UN plato concreto (dos como mucho) por su nombre. De lo general a lo concreto; nunca sueltes la lista entera.
- No preguntes "¿está bien?", "¿con todo?" o "¿algo más?" después de cada plato.
- PRECIOS SIEMPRE EN PALABRAS, nunca cifras ni símbolos. Formato: "trece euros con cincuenta" (céntimos con "con", el € se dice "euros"). Ej.: 13,50 → "trece euros con cincuenta"; 9 → "nueve euros"; 9,90 → "nueve euros con noventa". PROHIBIDO decir "punto", "coma" o leer dígitos. Cantidades también en palabras ("dos pizzas"). Nunca leas códigos ni IDs.
- TELÉFONOS: al repetir un teléfono, dilo SIEMPRE en tres bloques de tres cifras, cada bloque leído como un número entero de tres cifras, separados por COMAS: 634425921 → "seiscientos treinta y cuatro, cuatrocientos veinticinco, novecientos veintiuno". PROHIBIDO leerlo dígito a dígito ("seis, tres, cuatro"), agrupar de dos en dos ("noventa y uno") o leerlo de corrido.
- PROHIBIDOS LOS PUNTOS SUSPENSIVOS (regla absoluta): NUNCA escribas tres puntos seguidos ni el carácter de puntos suspensivos en NINGUNA parte de tu respuesta. El sintetizador de voz los convierte en ruidos y silencios raros. Si necesitas una pausa, usa una COMA o un PUNTO. Ni al principio, ni en medio, ni al final de la frase. Ninguna excepción.
- PROHIBIDO usar "Entiendo" o "Entendido" como muletilla de arranque (ni solos, ni entre comillas): NUNCA empieces un turno así. Ve directo a la información. Para variar usa: "Perfecto", "Marchando", "Hecho", "Vale", "Genial".
- PROHIBIDO empezar o rellenar con sonidos de duda: nada de "Ah", "Ahh", "Ahhh", "Hmm", "Mmm", "Mm-hmm", "Ehm", "Eh", "Este", "A ver". NUNCA arranques un turno con uno de esos sonidos: empieza directamente con la información (el total, la confirmación, la siguiente pregunta). Si acabas de calcular el total, di el número de inmediato, sin preámbulo ("Son treinta y seis euros con cincuenta.").
- PROHIBIDO usar palabras o expresiones en inglés cuando hablas en español: nada de "Okay", "Ok", "So", "Sure", "Well", "Alright", "Sorry", "Right", "I got it", "Got it", "Sure thing" NI NINGUNA otra palabra/frase en inglés. Hablas español de España y arrancas SIEMPRE en español ("Claro", "Perfecto", "Vale", "Muy bien", "Entendido", "Hecho"). No mezcles idiomas dentro de una frase. (Esto NO impide atender a un cliente que hable en inglés: si el cliente habla en inglés, respóndele TODO en inglés natural; pero nunca mezcles los dos.)
- Cuando el cliente diga que quiere hacer un pedido, responde natural y directo, sin ningún sonido ni preámbulo: "¡Claro! ¿Qué te gustaría pedir?" (o, si procede, "¿Es para recoger o a domicilio?"). Nada de ruidos antes de contestar.
- Frases de relleno tipo "Un segundito" o "Déjame apuntarlo": como MUCHO una vez en TODA la llamada. Por defecto responde directo: una camarera con prisa no anuncia que va a apuntar, apunta.
- El RESUMEN del pedido dilo en prosa hablada, como una frase natural, NUNCA como lista con guiones o saltos de línea: "Te confirmo: una Carbonara, una Prosciutto, una Diavola y una Coca-Cola, para recoger a nombre de Samuel."
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

${(() => {
  try {
    const promos = listActivePromotions(slug);
    if (!promos.length) return "";
    return "\n# PROMOCIONES ACTIVAS\n" +
      "- Ofertas vigentes hoy: " + promos.map(p => p.label).filter(Boolean).join("; ") + ".\n" +
      "- Puedes mencionarlas si encajan con lo que pide, UNA vez y sin insistir. NUNCA calcules tú el descuento: el total correcto lo devuelve calcular_total.\n";
  } catch (_) { return ""; }
})()}
# DESAMBIGUACIÓN DE PLATOS (obligatorio, CRÍTICO)
- REGLA DE ORO (léela primero): solo preguntas para aclarar cuando el cliente da el nombre ambiguo A SECAS. Si el cliente ya ha dicho la categoría junto al nombre, la ambigüedad NO EXISTE: añade el plato directamente y NO preguntes NUNCA. Preguntar algo que el cliente acaba de especificar es un ERROR grave y molesto.
- CÓMO DECIDIR (haz este chequeo mental antes de añadir):
  1) ¿El cliente ha dicho o insinuado la categoría en la MISMA frase o justo antes? Palabras/pistas de categoría: "pizza", "pizza blanca", "pasta", "espaguetis"/"spaghetti", "un plato de pasta", "entrante", "para empezar", "de primero", "ensalada", "risotto", "arroz". Si SÍ → añade el plato de ESA categoría y NO preguntes.
  2) Solo si el cliente NO ha dado ninguna pista de categoría y el nombre coincide con DOS O MÁS platos → pregunta UNA vez, corta, ofreciendo las opciones por categoría.
- Ejemplos que NO se preguntan (el cliente ya especificó, añade directo):
  · "quiero una PIZZA carbonara" → Carbonara (pizza blanca). NO preguntes.
  · "ponme una PASTA carbonara" / "unos ESPAGUETIS carbonara" → Spaghetti alla Carbonara. NO preguntes.
  · "la PIZZA parmigiana" → Parmigiana (pizza). "el ENTRANTE de parmigiana" / "las BERENJENAS parmigiana" → Berenjenas Parmigiana. NO preguntes.
- Ejemplo que SÍ se pregunta (nombre a secas, sin categoría):
  · "quiero una carbonara" → "¿La carbonara la quieres de pasta o la pizza?".
  · "ponme una parmigiana" → "¿La parmigiana, el entrante de berenjenas o la pizza?".
- Colisiones conocidas de la carta (no exhaustivas — aplica el mismo criterio a cualquier otra que detectes): "carbonara" (pasta / pizza blanca), "parmigiana" (entrante / pizza), "vegetariana", "italiana" y otros nombres cortos que se repitan entre categorías.
- Esta pregunta de aclaración es la ÚNICA excepción al ANTI-BUCLE, y SOLO cuando el nombre viene a secas. Hazla UNA sola vez; si el cliente no aclara, toma la opción más pedida/razonable y sigue.
- Si el nombre coincide con UN SOLO plato, NO preguntes: añádelo directo.

# HORARIO DE COCINA
${horarioLinea}
- Si la cocina está cerrada, avisa antes de cerrar el pedido y ofrece la próxima apertura disponible.
- No prometas que estará listo a una hora incompatible con el horario.

# FLUJO DEL PEDIDO
1. Saluda. Lo PRIMERO que necesitas —ANTES de tomar platos— es saber si es para RECOGER (pasa el cliente a por él) o A DOMICILIO (se lo llevamos). Interpreta lo que el cliente ya te diga:
   - "para recoger", "paso a recogerla", "la recojo", "voy a por ella", "me la llevo yo" = RECOGER.
   - "a domicilio", "que me la traigáis", "a mi casa", "a mi dirección", "reparto", "delivery" = DOMICILIO.
   - "para llevar" / "para llevármela" / "que me la llevéis" = A DOMICILIO (se la llevamos a su dirección). Tómalo como domicilio DIRECTAMENTE, sin preguntar "¿recoger o domicilio?": di algo como "¡Perfecto! ¿A qué dirección te la llevamos?". Solo si el cliente dice que pasa él a recogerla, cámbialo a recoger.
   - ORDEN OBLIGATORIO EN DOMICILIO — PRIMERO EL TELÉFONO, DESPUÉS LA DIRECCIÓN. Nunca al revés. Sigue estos pasos EXACTAMENTE:
     PASO A) Pide el TELÉFONO lo primero: "¡Perfecto! ¿Me dices un teléfono de contacto?".
     PASO B) En cuanto lo tengas, llama a buscar_cliente con ese número. SIEMPRE, sin excepción, antes de pedir nada más.
     PASO C) Si encontrado=true → NO le pidas la dirección. SALÚDALE POR SU NOMBRE y CONFÍRMALE la dirección guardada: "¡Ah, [nombre]! ¿Te lo llevo a la de siempre, [dirección]?". Si dice que sí, esa es la dirección y sigues. Si dice que ha cambiado, entonces sí le pides la nueva.
     PASO D) Si encontrado=false → AHORA sí pídele la dirección completa: "¿A qué dirección te lo llevamos?".
     PASO E) Con la dirección ya fijada (confirmada o nueva), valida la zona de reparto y pasa a los platos.
   - PROHIBIDO pedir la dirección antes de tener el teléfono y haber consultado el perfil. Hacer que un cliente recurrente dicte una dirección que ya tenemos guardada es un ERROR grave: le hace perder tiempo y da sensación de que no le conocemos.
   - PROHIBIDO pedir dos veces el mismo dato. Si ya tienes teléfono o dirección de este cliente, no los vuelvas a pedir: confírmalos si acaso, una sola vez.
   - En RECOGER el orden es el mismo: primero el TELÉFONO, luego buscar_cliente, y si encontrado=true salúdale por su nombre y NO le pidas el nombre otra vez; si encontrado=false, pídele el nombre. En RECOGER no existe dirección: JAMÁS pidas, confirmes ni menciones ninguna dirección (ni la del perfil); el cliente recoge SIEMPRE en el local.
   - ZONA DE REPARTO (obligatorio en domicilio): una vez fijada la dirección (paso C o D), llama a validar_direccion ANTES de tomar los platos. Según el resultado:
     · dentro_de_zona = true → sigue con normalidad, no menciones la zona.
     · dentro_de_zona = false → dile con amabilidad que ahí no llegamos con el reparto y OFRÉCELE ALTERNATIVAS: que pase a recogerlo por el local, o un punto de entrega más cercano si te lo indica. Si acepta recoger, cambia el pedido a RECOGER y continúa. Si no acepta, agradece el interés y despídete con cordialidad, sin tomar el pedido.
     · dentro_de_zona = "desconocido" → NO bloquees ni menciones nada raro: sigue con el pedido con normalidad (el personal lo revisará).
   Si el cliente YA ha dejado claro el tipo, NO se lo vuelvas a preguntar. Solo preguntas cuando no haya dado NINGUNA indicación.
   ANTI-BUCLE (crítico): NUNCA preguntes el tipo de pedido más de UNA vez, y JAMÁS repitas la misma pregunta dos veces seguidas. En cuanto tengas cualquier indicación (incluida "para llevar" → domicilio), tómala y sigue con el pedido; el cliente podrá corregirte si hace falta. No te quedes en bucle.
2. Luego pregunta qué quiere pedir y apunta cada plato con su cantidad y modificaciones. NO lo repitas en voz alta uno a uno.
3. Datos de contacto: normalmente YA los tienes del paso 1 (teléfono primero, luego perfil o dirección). Aquí solo COMPRUEBAS que no falta ninguno:
   - DOMICILIO: teléfono + dirección completa. Los DOS.
   - RECOGER: teléfono + nombre.
   Si alguno falta, pídelo AHORA (solo el que falte, nunca uno que ya tengas). JAMÁS llames a submit_order sin el teléfono, ni sin dirección en domicilio, ni sin nombre en recoger.
4. HORA DE RECOGIDA/ENTREGA: NO preguntes "¿para qué hora?" ni ofrezcas ni digas "lo antes posible". Por defecto, NOTIFICA tú directamente el tiempo estimado: coge la hora ACTUAL (mírala en HORARIO DE COCINA), súmale el tiempo de preparación y comunícaselo como un dato, no como pregunta.
   - Si es RECOGER: dile cuándo puede pasar a recogerla. Ej.: "En unos veinte minutos la tienes lista, sobre las nueve, cuando quieras pasas a recogerla."
   - Si es DOMICILIO: dile cuándo se le entregará. Ej.: "Te la llevamos en unos treinta minutos, sobre las nueve y cuarto."
   - Solo si el cliente PIDE una hora concreta más tarde, respétala (si es compatible con el horario). Si te pide antes de lo posible, dile el mínimo real con naturalidad.
   - NUNCA propongas ni confirmes una hora anterior a la hora actual. Antes de decir una hora, comprueba que es posterior a "ahora" y compatible con el horario.
5. UPSELLING (obligatorio, UNA vez, antes del resumen): haz SIEMPRE una sugerencia concreta de UN solo producto, siguiendo esta PRIORIDAD ESTRICTA:
   - PRIMERO las bebidas: si el pedido NO incluye ninguna bebida, tu sugerencia OBLIGATORIA es una bebida ("¿Quieres algo de beber? Tenemos Coca-Cola, agua o cerveza."). NUNCA sugieras postre ni entrante si falta la bebida — la bebida va SIEMPRE primero.
   - Solo si YA hay bebida: si no hay postre, sugiere un postre concreto por su nombre.
   - Solo si ya hay bebida y postre: ofrece un entrante para compartir.
   Una frase apetecible. Si dice que no, no insistas y pasa al resumen.
6. Cuando el cliente diga que ha terminado, lee el pedido completo UNA vez: platos, cantidades, modificaciones, tipo de entrega, hora, alergia si la hay, y el TOTAL. El total es OBLIGATORIO en el resumen: llama a calcular_total antes si aún no lo tienes. No pidas confirmación sin haber dicho el total.
7. ANTES de confirmar, repasa este CHECKLIST OBLIGATORIO. Si falta algo, hazlo primero y NO pidas confirmación todavía:
   (a) ¿Has ofrecido upselling UNA vez? (paso 5). Si no, hazlo ahora.
   (b) ¿Has dicho el TOTAL en voz alta en el resumen? (paso 6, vía calcular_total). Si no, dilo.
   Nunca saltes del pedido directo a "va a cocina": el cliente SIEMPRE oye una sugerencia y SIEMPRE oye el total antes de confirmar.
8. Cuando el checklist esté completo y el cliente diga un "sí" claro al pedido, gestiona el CONSENTIMIENTO DE DATOS antes de enviar:
   - Si es CLIENTE RECURRENTE (ya hay perfil guardado), NO preguntes nada de guardar datos: llama a submit_order directamente con save_profile_consent=false.
   - Si es cliente NUEVO (no hay perfil), hazle UNA última pregunta antes de enviar: "Por último, ¿quieres que guarde tu nombre y tu dirección para que la próxima vez sea más rápido? Solo si me das permiso." Si dice que SÍ → llama a submit_order con save_profile_consent=true. Si dice que NO → save_profile_consent=false. No insistas ni lo repitas.
9. Tras submit_order, despídete en UNA sola frase, cálida y directa ("Perfecto, Samuel, tu pedido va a cocina. ¡Gracias!"). NUNCA digas "está en camino". NUNCA repitas fragmentos sueltos ni sonidos de relleno al cerrar: una sola despedida limpia, sin puntos suspensivos.

# PRECIOS Y HERRAMIENTAS
- RECONOCER AL CLIENTE: el TELÉFONO es lo PRIMERO que pides (ver paso 1). En cuanto lo tengas, llama SIEMPRE a buscar_cliente con ese número, antes de pedir dirección o nombre. Si devuelve encontrado=true, salúdale por su nombre y CONFIRMA su dirección guardada en vez de pedírsela ("¡Ah, Samuel! ¿Te lo llevo a la de siempre, Calle X número 3?"); si dice que ha cambiado, pídele la nueva. Si encontrado=false, entonces sí le pides los datos que falten. NUNCA le hagas dictar una dirección que ya tenemos guardada. No menciones que "buscas" nada ni digas "veo que tienes una dirección guardada similar"; hazlo con naturalidad, como quien reconoce a un cliente de siempre.
- Antes de decir cualquier total, llama SIEMPRE a calcular_total. No sumes de cabeza ni inventes importes.
- Cuando el cliente pida añadir un extra o topping a un plato (burrata, jamón, base sin gluten, etc.), avísale de que puede llevar un suplemento antes de darlo por confirmado. Llama a calcular_total para saber si ese extra tiene coste y dilo con naturalidad, p. ej.: "Eso lleva un suplemento de tres euros con cincuenta, ¿te lo pongo igualmente?". Si calcular_total no refleja coste para ese extra, no menciones ningún importe.
- BASE DE LA PIZZA: NO preguntes de forma estándar "¿base normal o sin gluten?" — asume SIEMPRE base normal y no lo menciones. Solo sacas el tema de la base sin gluten si el cliente menciona por su cuenta una alergia, celiaquía, gluten o "sin TACC". En ESE caso, ofrécesela y, si la quiere, avísale del suplemento de CUATRO EUROS CON CINCUENTA por pizza antes de darla por hecha ("La base sin gluten son cuatro euros con cincuenta más por pizza, ¿te la pongo así?"). Nunca la des por hecha sin haber dicho ese suplemento.
- Al llamar a submit_order, usa el menu_item_id exacto de cada producto de la carta.
- NUNCA llames a submit_order sin TODO esto: productos, tipo de pedido, nombre, teléfono, dirección (si es domicilio), **upselling ofrecido una vez**, **TOTAL dicho en voz alta** y confirmación explícita del cliente. Si falta cualquiera, complétalo antes. Jamás confirmes un pedido sin haber ofrecido una sugerencia y sin haber dicho el precio.

# SEGURIDAD POR ALÉRGENOS (CRÍTICO)
- CANDADO DE ACTIVACIÓN (léelo primero): TODA esta sección se activa ÚNICA y EXCLUSIVAMENTE si el cliente ha DECLARADO por su cuenta una alergia o intolerancia en ESTA llamada (p. ej. "soy alérgico a algo", "soy celíaco", "no puedo tomar lactosa", "sin gluten"). Si el cliente NO ha declarado ninguna alergia, está PROHIBIDO avisar de alérgenos, mencionar que un plato "lleva nata, queso o gluten" o recitar ingredientes de forma proactiva. Pedir una pizza con extra de queso, beicon u orégano NO es declarar una alergia: anótalo y sigue, sin advertencias. Soltar una alerta de alérgenos que nadie ha pedido confunde al cliente y es un ERROR.
- Si el cliente menciona cualquier alergia o intolerancia, trátalo como prioritario. No minimices ni asumas que un plato es seguro.
- SINÓNIMOS que debes reconocer: "sin TACC", "TACC" o "apto celíacos" = SIN GLUTEN (celiaquía); "sin lácteos" = sin lactosa. Trátalos como la alergia/intolerancia correspondiente y aplícales la misma política de seguridad.
- CRUZA la alergia contra TODOS los platos ya pedidos y los que pida después. Si un plato probablemente contiene ese alérgeno (ej.: lactosa → Carbonara, quesos, nata; gluten → masa, pasta; frutos secos → pesto, postres), AVÍSALE en ese momento: "Oye, la Carbonara lleva nata y queso, ¿la mantienes o te ofrezco otra?". Nunca lo dejes pasar en silencio.
- Deja SIEMPRE constancia en kitchenNote, formato: "ALERGIA: [alérgeno]. Revisar [platos afectados]". La alergia se menciona también en el resumen final.
- Ante alergia grave o duda, no confirmes el plato como seguro por tu cuenta: márcalo para revisión del personal.

# PEDIDOS DE GRUPO
Si el pedido es para ${provider.groupOrderThreshold || 7} personas o más, confírmalo con especial cuidado y avisa de que puede requerir algo más de tiempo de preparación.

# FORMA DE PAGO
- En este local SOLO se acepta EFECTIVO. NO preguntes la forma de pago: simplemente INFÓRMALO una vez, con naturalidad, al cerrar el pedido ("El pago es en efectivo, ${provider.payment && provider.payment.methods && provider.payment.methods.includes("card") ? "o con tarjeta" : "al recogerlo"}."). Si es a domicilio, dilo así: "El pago es en efectivo al repartidor.". Al llamar a submit_order usa payment_method="cash".
- Si el cliente pregunta si puede pagar con tarjeta, dile con amabilidad que de momento solo se admite efectivo.

# CONSULTA SOBRE UN PEDIDO YA HECHO (no es un pedido nuevo)
Si el cliente NO quiere pedir sino preguntar por un pedido que ya hizo (estado, retraso, algo incorrecto o que falta, cambiar algo), cambia a este flujo:
1. Pídele su TELÉFONO y llama a consultar_pedido con ese número.
2. Si encontrado=true: dile el estado en lenguaje natural (nunca leas ids ni códigos). Si hay varios, usa el más reciente salvo que él aclare otro.
3. Si encontrado=false: pídele algún dato más (nombre, qué pidió, hace cuánto). Si aun así no lo localizas, discúlpate y deriva al personal con registrar_incidencia (escalar=true).
4. IDENTIFICA el motivo y llama a registrar_incidencia con el reason que corresponda: estado_pedido, retraso, producto_incorrecto, producto_faltante, modificacion_pedido u otra_incidencia.
   · Si solo quería saber el estado y ya se lo has dicho → escalar=false.
   · Si hay un problema real (falta algo, llegó mal, quiere cambiarlo, va muy tarde) → escalar=true: dile que avisas al personal y que le atenderán enseguida.
5. NUNCA prometas reembolsos, compensaciones ni tiempos exactos. Tú registras y trasladas.
6. Si la herramienta devuelve avisado_el_personal=false y registrada=false, sé HONESTA: dile que no has podido dejar constancia y que llame en unos minutos; no afirmes que ya está gestionado.

# OTRAS CONSULTAS (ni pedido ni incidencia)
- Este teléfono es exclusivo para PEDIDOS y consultas sobre pedidos. Para cualquier otra cosa (proveedores, colaboraciones, facturación, empleo, prensa), dilo con amabilidad y pide que lo gestionen por los canales del restaurante o que llamen en horario de oficina preguntando por el encargado. No inventes extensiones, correos ni departamentos que no conoces.

# LÍMITES
- Solo tomas pedidos de comida. No gestionas reservas de mesa. Para reembolsos NO prometas nada (no puedes autorizar dinero).
- QUEJAS / RECLAMACIONES: el cliente YA está llamando al restaurante, así que NUNCA le digas "llame al restaurante" (es un bucle absurdo). En su lugar, discúlpate con empatía y ofrece TOMAR NOTA de la queja para pasarla al encargado: pídele su nombre y un teléfono, dile que el encargado le llamará para resolverlo, y deja constancia en una nota para el personal. No prometas reembolso; solo trasladas la reclamación. Después, con tacto, ofrece ayudarle con un pedido si le apetece.
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
        notes:         { type: "string", description: "nota general del pedido." },
        payment_method: { type: "string", enum: ["cash", "card"], description: "forma de pago. En este local SOLO se acepta efectivo ('cash'): no lo preguntes, solo infórmalo." },
        save_profile_consent: { type: "boolean", description: "true SOLO si el cliente ha dado permiso EXPLÍCITO para guardar su nombre, teléfono y dirección para futuros pedidos (se le pregunta tras confirmar el pedido). false o ausente si no consintió." }
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

// ─── HERRAMIENTA buscar_cliente ─────────────────────────────────────────────
// Busca un perfil guardado (con consentimiento) por teléfono. Funciona en web
// y en teléfono: en cuanto el cliente DICE su número, Marta puede reconocerlo.
const LOOKUP_TOOL = {
  type: "function",
  function: {
    name: "buscar_cliente",
    description: "Busca si un teléfono tiene un perfil guardado (nombre + dirección) de un pedido anterior. Llámala en cuanto el cliente te diga su número de teléfono. Si devuelve encontrado=true, salúdale por su nombre y CONFIRMA su dirección en vez de volver a pedírsela.",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string", description: "el teléfono que ha dado el cliente, solo dígitos." }
      },
      required: ["phone"]
    }
  }
};

// ─── HERRAMIENTA validar_direccion ──────────────────────────────────────────
// Comprueba si la dirección entra en el radio de reparto ANTES de tomar platos.
const ZONE_TOOL = {
  type: "function",
  function: {
    name: "validar_direccion",
    description: "Comprueba si una dirección de entrega está dentro de la zona de reparto. Llámala SIEMPRE justo después de que el cliente te dé la dirección, ANTES de empezar a tomar los platos. Devuelve dentro_de_zona true/false/desconocido.",
    parameters: {
      type: "object",
      properties: {
        address: { type: "string", description: "dirección completa tal como la ha dicho el cliente." }
      },
      required: ["address"]
    }
  }
};

// ─── HERRAMIENTA consultar_pedido ───────────────────────────────────────────
// Rama de CONSULTA: localiza los pedidos recientes de un teléfono.
const ORDER_LOOKUP_TOOL = {
  type: "function",
  function: {
    name: "consultar_pedido",
    description: "Busca los pedidos recientes de un teléfono para responder a una CONSULTA o incidencia (estado, retraso, producto incorrecto). Llámala cuando el cliente NO quiere pedir sino preguntar por un pedido ya hecho, en cuanto te dé su teléfono.",
    parameters: {
      type: "object",
      properties: {
        phone: { type: "string", description: "teléfono del cliente, solo dígitos." }
      },
      required: ["phone"]
    }
  }
};

// ─── HERRAMIENTA registrar_incidencia ───────────────────────────────────────
// Deja constancia y, si hace falta, avisa al personal.
const INCIDENT_TOOL = {
  type: "function",
  function: {
    name: "registrar_incidencia",
    description: "Registra una incidencia sobre un pedido y avisa al personal si tú no puedes resolverla. Úsala tras identificar el motivo de la consulta. Si el cliente solo quería saber el estado y ya se lo has dicho, usa escalar=false.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: ["estado_pedido", "retraso", "producto_incorrecto", "producto_faltante", "modificacion_pedido", "otra_incidencia"],
          description: "motivo de la consulta."
        },
        detail:        { type: "string", description: "resumen breve de lo que cuenta el cliente." },
        order_id:      { type: "string", description: "id del pedido si lo has localizado." },
        phone:         { type: "string", description: "teléfono del cliente." },
        customer_name: { type: "string", description: "nombre del cliente si lo sabes." },
        escalar:       { type: "boolean", description: "true si necesita atención del personal; false si tú ya lo has resuelto." }
      },
      required: ["reason"]
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

  // Promociones: motor configurable. Hoy `promotions: []` → no-op, total intacto.
  let promo = { discounts: [], totalDiscount: 0, newTotal: estimatedTotal, labels: [] };
  try {
    promo = applyPromotions(items, { orderType: args && args.order_type, baseTotal: estimatedTotal }, "la-locanda");
  } catch (e) { console.error("[PROMO] error | " + e.message); }

  const out = {
    total_eur: promo.totalDiscount > 0 ? promo.newTotal : estimatedTotal,
    moneda: currency || "EUR",
    productos_sin_precio: sinPrecio
  };
  if (promo.totalDiscount > 0) {
    out.total_sin_descuento_eur = estimatedTotal;
    out.descuento_eur = promo.totalDiscount;
    out.promociones_aplicadas = promo.labels;
  }
  return out;
}

// Busca un perfil guardado por teléfono (para la tool buscar_cliente).
async function computeLookup(args) {
  const phone = args && args.phone;
  let prof = null;
  try { prof = phone ? await getCustomerByPhone(phone) : null; } catch (_) { prof = null; }
  if (!prof) return { encontrado: false };
  return {
    encontrado: true,
    nombre: prof.name || null,
    direccion: prof.address ? (prof.address.raw || prof.address) : null,
    pedidos_previos: prof.orderCount || 0
  };
}

// Valida la zona de reparto (tool validar_direccion).
// FAIL-OPEN: ante fallo técnico devuelve "desconocido" para no perder la venta.
async function computeZone(args) {
  const address = args && args.address;
  let z;
  try { z = await checkDeliveryAddress(address, "la-locanda"); }
  catch (e) {
    console.error("[ZONA] error | " + e.message);
    return { dentro_de_zona: "desconocido", motivo: "error_tecnico" };
  }
  const map = { in_zone: true, out_of_zone: false, unknown: "desconocido" };
  return {
    dentro_de_zona: map[z.status],
    distancia_km:   z.distanceKm,
    radio_km:       z.radiusKm,
    motivo:         z.reason
  };
}

// Consulta de pedidos por teléfono (tool consultar_pedido).
async function computeOrderLookup(args) {
  try { return await lookupOrdersForCustomer(args && args.phone, 3); }
  catch (e) {
    console.error("[CONSULTA] error | " + e.message);
    return { encontrado: false, motivo: "error_consulta" };
  }
}

// Registro de incidencia + derivación al personal (tool registrar_incidencia).
async function computeIncident(args) {
  try {
    const r = await registerIncident({
      orderId:      args.order_id || null,
      phone:        args.phone || null,
      customerName: args.customer_name || null,
      reason:       args.reason,
      detail:       args.detail || null,
      escalate:     args.escalar !== false,
      providerSlug: "la-locanda"
    });
    return {
      registrada: !!r.registrada,
      avisado_el_personal: !!r.derivada,
      ok: !!r.ok
    };
  } catch (e) {
    console.error("[INCID] error | " + e.message);
    return { registrada: false, avisado_el_personal: false, ok: false };
  }
}

// Devuelve la salida de una tool_call (calcular_total, buscar_cliente, u otras).
async function toolOutput(tc) {
  const name = tc && tc.function && tc.function.name;
  let a = {};
  try { a = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch (_) { a = {}; }
  if (name === "calcular_total")       return computeQuote(a);
  if (name === "buscar_cliente")       return await computeLookup(a);
  if (name === "validar_direccion")    return await computeZone(a);
  if (name === "consultar_pedido")     return await computeOrderLookup(a);
  if (name === "registrar_incidencia") return await computeIncident(a);
  return { ok: true };
}

function formatEurosSpoken(n) {
  if (n == null || isNaN(n)) return "";
  const euros = Math.floor(n);
  const cents = Math.round((n - euros) * 100);
  return cents === 0 ? `${euros} euros` : `${euros} euros con ${cents}`;
}

// Anti-duplicado por CONTENIDO (no depende del callId, que en web es inestable).
// Si el MISMO pedido (teléfono + productos + tipo) se intenta enviar de nuevo en
// menos de DEDUP_WINDOW_MS, se bloquea → evita 6 comandas iguales a cocina.
const _recentDispatch = new Map(); // firma -> timestamp
const DEDUP_WINDOW_MS = 120000;    // 2 minutos

function orderSignature(args) {
  const phone = String(args.phone || "").replace(/\D/g, "");
  const items = (args.items || [])
    .map(i => `${i.quantity || 1}x${String(i.menu_item_id || i.name || "").toLowerCase().trim()}`)
    .sort()
    .join("|");
  return `${phone}::${items}::${args.order_type || ""}`;
}

async function handleSubmitOrder(callId, args) {
  const _sess = getOrCreateOrderSession(callId);
  if (_sess && _sess.status === ORDER_STATUS.SENT_TO_KITCHEN) {
    return { ok: true, delivered: _sess.dispatchChannel && _sess.dispatchChannel !== "file_fallback", order: _sess, reply: "", validation: {}, alreadyDone: true };
  }

  // Guard de contenido: bloquea duplicados aunque el callId cambie cada turno.
  const _sig = orderSignature(args);
  const _now = Date.now();
  for (const [k, t] of _recentDispatch) { if (_now - t > DEDUP_WINDOW_MS) _recentDispatch.delete(k); }
  if (_recentDispatch.has(_sig) && (_now - _recentDispatch.get(_sig)) < DEDUP_WINDOW_MS) {
    console.warn("[EL] DUPLICADO bloqueado (misma firma <2min) | " + _sig);
    return { ok: true, delivered: true, order: _sess || null, reply: "", validation: {}, alreadyDone: true };
  }
  _recentDispatch.set(_sig, _now);  // reservar de inmediato para bloquear concurrentes
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
    paymentMethod: args.payment_method || "cash",
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

  // Guardar perfil del cliente SOLO si dio consentimiento explícito (para futuros pedidos).
  // Fire-and-forget: no bloquea la respuesta de voz. GDPR: sin consent, no se guarda.
  if (args.save_profile_consent === true) {
    try {
      const addr = (patch.address && patch.address.raw) ? patch.address : (args.address ? { raw: args.address } : null);
      Promise.resolve(upsertCustomer({
        phone: args.phone || null,
        name: realCustomerName(args.customer_name),
        address: addr,
        providerSlug: "la-locanda",
        consent: true
      }))
        .then(r => {
          if (r && r.ok) console.log("[CUST] perfil guardado con consentimiento | " + (args.phone || ""));
          else if (r && r.skipped) console.log("[CUST] guardado omitido | " + r.reason);
        })
        .catch(e => console.error("[CUST] error guardando perfil | " + e.message));
    } catch (e) { console.error("[CUST] error perfil | " + e.message); }
  }
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

function buildModelMessages(provider, incomingMessages, profile = null) {
  const incoming = Array.isArray(incomingMessages) ? incomingMessages : [];
  const userTurns = incoming
    .filter(m => m && m.role !== "system")
    .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
    .map(m => ({ role: m.role, content: String(m.content) }));

  return [
    { role: "system", content: buildSystemPrompt(provider, profile) },
    ...userTurns
  ];
}

// Red de seguridad: limpia cualquier fragmento de relleno del INICIO de la respuesta
// (interjecciones "Ah/Mmm", muletillas en inglés "Okay/Right/I got it", y palabras
// entrecomilladas o con puntos suspensivos tipo "Entiendo...", "¡Claro!.") antes de
// enviarla a ElevenLabs. No toca respuestas normales (probado). Belt-and-suspenders
// por si el modelo se salta la regla del prompt.
function sanitizeReply(text) {
  if (!text) return text;
  const original = String(text).trim();
  // Normaliza comillas tipográficas (el modelo a veces emite “Right…”): las
  // reglas de abajo solo ven " y ', así “Right…” no se escapa del filtro.
  let t = original.replace(/[\u201C\u201D\u201E]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // Muletillas entrecomilladas en CUALQUIER posición: "Entiendo". / "Got it".
  t = t.replace(/"(?:entiendo|entendido|got\s*it|okay|ok|right|vale|claro|perfecto)[\s.…]*"[\s.,!…]*/gi, " ").replace(/\s{2,}/g, " ").trim();
  let prev;
  // Muletillas en INGLÉS que el modelo cuela al arrancar un turno. Se eliminan
  // siempre que aparezcan al principio. Ampliada tras detectar "Duly noted...".
  const EN = "okay|ok|so|sure|well|alright|sorry|right|got\\s*it|i\\s*got\\s*it|you\\s*know|" +
             "duly\\s*noted|noted|understood|of\\s*course|indeed|certainly|absolutely|" +
             "very\\s*well|i\\s*see|let\\s*me\\s*see|one\\s*moment|perfect";
  // Arranques en ESPAÑOL que solo son ruido cuando van seguidos de puntos
  // suspensivos ("Entendido...", "Perfecto..."). Con coma son legítimos y NO se tocan.
  const ES = "entiendo|entendido|entonces|claro|vale|bueno|ya|perfecto|genial|estupendo|de\\s*acuerdo|a\\s*ver";
  do {
    prev = t;
    // 1) fragmento entrecomillado corto al inicio: "Ahhh, claro..." / "Got it..."
    t = t.replace(/^[¡¿\s]*["'][^"']{1,30}["'][\s.,!…"']*/, "").trim();
    // 2) interjección o muletilla (es/en) al inicio, con comilla de cierre opcional
    t = t.replace(new RegExp("^[¡¿\"'\\s]*(?:ah+|hmm+|mmm+|mm-?hmm|ehm|eh|este|" + EN + ")[\"']?\\b[\\s.,!…\"']*", "i"), "").trim();
    // 3) arranque en español SOLO si va seguido de puntos suspensivos.
    //    Admite signos entre medias ("¡Entiendo!..." debe caer igual que "Entiendo...").
    t = t.replace(new RegExp("^[¡¿\"'\\s]*(?:" + ES + ")\\s*[!¡?¿]*\\s*(?:\\.{2,}|…)[\"']?[\\s.,!…\"']*", "i"), "").trim();
    // 3b) "Entiendo."/"Entendido." como frase-muletilla inicial seguida de otra frase
    t = t.replace(/^[¡¿"'\s]*(?:entiendo|entendido)[."'!]*\s+(?=[A-ZÁÉÍÓÚÑ¡¿"])/i, "").trim();
    // 4) restos: comillas/puntos/comas sueltos al inicio (NO toca ¡¿ ni letras)
    t = t.replace(/^[\s.,!…"']+/, "").trim();
  } while (t !== prev && t.length);

  // 5) NORMALIZACIÓN FINAL: fuera TODOS los puntos suspensivos, estén donde estén.
  //    ElevenLabs los convierte en ruidos y silencios raros al sintetizar la voz.
  //    Un signo de puntuación previo se conserva; el resto pasa a punto.
  t = t.replace(/([!?.,;:])\s*(?:\.{2,}|…)/g, "$1");   // "¡Entiendo!..." -> "¡Entiendo!"
  t = t.replace(/\s*(?:\.{2,}|…)/g, ".");              // "pedido..."     -> "pedido."
  t = t.replace(/\.\s*\./g, ".").replace(/([!?])\s*\./g, "$1"); // sin puntuación duplicada
  t = t.replace(/\s{2,}/g, " ").trim();

  return t.length ? t.charAt(0).toUpperCase() + t.slice(1) : original;
}

async function generateMartaReply(callId, incomingMessages, callerPhone = null) {
  const provider = getProvider("la-locanda");
  let profile = null;
  if (callerPhone) {
    try { profile = await getCustomerByPhone(callerPhone); }
    catch (e) { console.error("[CUST] lookup error | " + e.message); profile = null; }
  }
  let messages = buildModelMessages(provider, incomingMessages, profile);
  const tools = [SUBMIT_ORDER_TOOL, QUOTE_TOOL, LOOKUP_TOOL, ZONE_TOOL, ORDER_LOOKUP_TOOL, INCIDENT_TOOL];

  // Bucle de herramientas: permite encadenar validar_direccion / consultar_pedido /
  // calcular_total y luego hablar. 5 pasos: hay 6 tools y un turno puede necesitar
  // varias (p. ej. validar dirección → calcular total → enviar pedido).
  for (let step = 0; step < 5; step++) {
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
          const out = await toolOutput(tc);
          toolMsgs.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(out) });
        }
      }
      // Despedida INSTANTÁNEA: usamos la respuesta ya redactada por handleSubmitOrder
      // en vez de otra llamada a OpenAI. Quita el round-trip más sensible (justo al
      // confirmar) → sin pausa ni "ruidito de pensando" de ElevenLabs, sin quedarse pillada.
      const reply = sanitizeReply((result && result.reply && result.reply.trim())
        ? result.reply.trim()
        : "¡Perfecto! Tu pedido queda confirmado y va a cocina. ¡Gracias y hasta luego!");
      return { reply, dispatched: !!(result && result.delivered), action: "customer_confirmed" };
    }

    // 2) Otras tools (calcular_total, buscar_cliente) → responder y volver a llamar
    if (calls.length) {
      const toolMsgs = await Promise.all(calls.map(async tc => {
        const out = await toolOutput(tc);
        return { role: "tool", tool_call_id: tc.id, name: tc.function.name, content: JSON.stringify(out) };
      }));
      messages = messages.concat([{ role: "assistant", content: msg.content || null, tool_calls: msg.tool_calls }], toolMsgs);
      continue;
    }

    // 3) Texto normal
    const reply = sanitizeReply((msg && msg.content && msg.content.trim()) ? msg.content.trim() : "Perdona, ¿me lo repites? No te he entendido bien.");
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
