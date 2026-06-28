"use strict";

const assert = require("assert");
const { getProvider } = require("./provider-profile.config.js");
const { buildSystemPrompt, buildModelMessages, renderMenu } = require("./marta-llm.service.js");

const provider = getProvider("la-locanda");
const prompt = buildSystemPrompt(provider);

assert(prompt.includes("Habla SIEMPRE en español de España por defecto."));
assert(prompt.includes("frase COMPLETA y CLARA"));
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
// frase completa y clara en otro idioma. Deben permanecer bajo la regla dura
// de español por defecto y nunca generar un segundo system de idioma.
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
    systems[0].content.includes("Habla SIEMPRE en español de España por defecto."),
    `${input}: debe mantenerse el español como idioma por defecto`
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

console.log("✅ System prompt contract: brain-only prompt, Spanish default and single final confirmation");
console.log("✅ Language regression: ciao / ok / un Margherita, por favor remain Spanish-default");
