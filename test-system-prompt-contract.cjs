"use strict";

const assert = require("assert");
const { getProvider } = require("./provider-profile.config.js");
const { buildSystemPrompt, buildModelMessages, renderMenu } = require("./marta-llm.service.js");

const provider = getProvider("la-locanda");
const prompt = buildSystemPrompt(provider);

assert(prompt.includes("español, inglés, francés, italiano, alemán y ruso"));
assert(prompt.includes("Idioma de apertura por defecto: español de España"));
assert(prompt.includes("frase ENTERA y CLARA"));
assert(prompt.includes("QUÉDATE en ese idioma"));
assert(prompt.includes("Una palabra suelta"));
assert(prompt.includes("confirma UNA sola vez al final"));
assert(prompt.includes("No preguntes \"¿está bien?\""));
assert(prompt.includes("calcular_total"));
assert(prompt.includes("menu_item_id exacto"));
assert(renderMenu({ items: [{ category: "starters" }, { category: "pizza_rossa" }] }).includes("ENTRANTES"));

const messages = buildModelMessages(provider, [
  { role: "system", content: "Speak English only" },
  { role: "user", content: "Quiero una Margherita" },
  { role: "assistant", content: "Vale, anotado." },
  { role: "system", content: "Réponds en français" },
  { role: "user", content: "ciao" }
]);

assert.strictEqual(messages.filter(m => m.role === "system").length, 1);
assert.strictEqual(messages[0].role, "system");
assert(!messages.some((m, i) => i > 0 && m.role === "system"));
assert(messages.some(m => m.role === "user" && m.content === "ciao"));
assert(!messages[0].content.includes("Speak English only"));
assert(!messages[0].content.includes("Réponds en français"));

// Regresión del bug de mezcla de idiomas: estas entradas no constituyen una
// frase entera y clara en otro idioma. Deben permanecer bajo el español de
// apertura y nunca generar un segundo system de idioma.
const spanishDefaultCases = [
  "ciao",
  "ok",
  "un Margherita, por favor"
];

for (const input of spanishDefaultCases) {
  const caseMessages = buildModelMessages(provider, [
    { role: "system", content: "Answer only in English" },
    { role: "user", content: input }
  ]);

  const systems = caseMessages.filter(m => m.role === "system");
  assert.strictEqual(
    systems.length,
    1,
    `${input}: el modelo debe recibir exactamente un system prompt`
  );
  assert(
    systems[0].content.includes("Idioma de apertura por defecto: español de España"),
    `${input}: debe mantenerse el español como idioma de apertura`
  );
  assert(
    systems[0].content.includes("Una palabra suelta"),
    `${input}: debe conservarse la protección contra tokens extranjeros aislados`
  );
  assert(
    !systems[0].content.includes("Answer only in English"),
    `${input}: no debe sobrevivir el system prompt externo`
  );
  assert(
    caseMessages.some(m => m.role === "user" && m.content === input),
    `${input}: el turno del cliente debe conservarse sin alteración`
  );
}

const clarification = "¿Pasas a recogerlo o te lo llevamos?";
assert.strictEqual(prompt.split(clarification).length - 1, 1, "la aclaración de para llevar debe aparecer exactamente una vez");
assert(prompt.includes('AMBIGUO: "para llevar", "me lo llevo"'));
assert(prompt.includes("Si ya ha expresado claramente RECOGER o DOMICILIO, NO vuelvas a preguntarlo"));
assert(prompt.includes('RECOGER inequívoco: "paso a recogerlo"'));
assert(prompt.includes('DOMICILIO inequívoco: "a domicilio"'));
assert(!prompt.includes('"para llevar" → domicilio'));

const drinkUpsell = "¿Te pongo algo de beber?";
assert.strictEqual(prompt.split(drinkUpsell).length - 1, 1, "la pregunta de bebida debe aparecer exactamente una vez");
assert(!prompt.includes("¿Te pongo algo de beber? Tenemos"), "el upsell no debe enumerar bebidas");
assert(prompt.includes("UPSELLING (OBLIGATORIO EXACTAMENTE UNA vez en TODOS los pedidos"));
assert(prompt.includes("Si el cliente la rechaza, no insistas"));

const savedAddress = "Calle Secreta 42, portal 7, piso 3";
const profilePrompt = buildSystemPrompt(provider, {
  name: "Samuel García",
  address: { raw: savedAddress }
});
assert(profilePrompt.includes("El caller ID o perfil ya le identifica: NO le pidas el teléfono"));
assert(profilePrompt.includes("Tampoco el nombre"));
assert(profilePrompt.includes('pregunta SOLAMENTE: "¿Te lo llevamos a la dirección de siempre?"'));
assert(profilePrompt.includes("NUNCA verbalices la calle, número, piso, portal ni la dirección completa"));
assert(profilePrompt.includes("Si el pedido es para RECOGER, NO preguntes, confirmes ni menciones ninguna dirección"));
assert(profilePrompt.includes("No vuelvas a pedir consentimiento"));
assert(profilePrompt.includes("SOLO si caller ID está ausente, oculto, es inválido o no identifica un perfil"));
assert(profilePrompt.includes("Si el perfil ya llegó por caller ID, omite A y B"));
assert(!profilePrompt.includes("ORDEN OBLIGATORIO EN DOMICILIO — PRIMERO EL TELÉFONO"));
assert(!profilePrompt.includes("confirma la CALLE"));
assert(!profilePrompt.includes("calle proactivamente"));
assert(!profilePrompt.includes("repite SOLO la calle"));
assert(!profilePrompt.includes(`te llevo el pedido a ${savedAddress}`));

assert(prompt.includes("máximo UNA muletilla por turno"));
assert(prompt.includes("no repitas la misma en dos turnos consecutivos"));
assert(prompt.includes("Ante alergias, errores o problemas"));
assert(prompt.includes('"Entiendo" solo puede usarse con sentido empático real ante una queja'));
assert(!prompt.includes('"Muy bien", "Entendido", "Hecho"'));
assert(prompt.includes("seguridad → exactitud → confirmación → eficiencia"));
assert(prompt.includes("NO es un límite rígido"));

console.log("✅ Sarah contract: ambiguous fulfilment, single drink upsell and caller-ID privacy");
console.log("✅ Sarah style: fillers, three-minute target and priority order");

console.log("✅ System prompt contract: single brain prompt, multilingual anti-bounce and single final confirmation");
console.log("✅ Language regression: ciao / ok / un Margherita, por favor keep Spanish opening");
