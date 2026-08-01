/**
 * test-datos-cliente-20260801.cjs
 *
 * REGLA DEL OWNER (01-08-2026), literal:
 *   "Si un cliente modifica algún dato, este dato se modifica inmediatamente.
 *    Siempre se revisa la base de datos para comprobar si tiene todos los datos
 *    antes de continuar con el pedido; si detecta que le falta algo lo pregunta
 *    antes de tomar la orden de comida. Si es la primera vez que el cliente pide,
 *    se le pregunta al final si quiere que guardemos sus datos para futuros
 *    pedidos. Si ya lo tenemos registrado no se hace nada, se continúa con el
 *    flujo normal."
 *
 * CASO REAL que lo motiva (conv_5501kyyd…), perfil del 679391554 con name=null:
 *   15 [user]  "¿tienes mi nombre registrado o no?"
 *   16 [agent] "tengo tu nombre guardado y no necesito que me lo digas"   ← MENTIRA
 *   17 [user]  "¿me lo puedes confirmar? ¿cuál es?"
 *   18 [agent] "no puedo decir tu nombre por teléfono"   ← política inventada
 *
 *   node test-datos-cliente-20260801.cjs
 */
const assert = require("assert");
const {
  estadoDelPerfil,
  directivaDatosDelCliente,
  tipoDeEntrega,
  nombreCorregidoEnLlamada
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

console.log("══ Datos del cliente: revisar, pedir, guardar ════");

// ── 1. Registrado y completo → NO se hace nada ──────────────────────────────
test("registrado y completo: no se le pide NINGÚN dato", () => {
  const e = estadoDelPerfil({
    registrado: true, nombre: "Samuel Tineo", direccion: "Calle Alpandeire 3",
    telefono: "634425921", tipoEntrega: "domicilio"
  });
  assert.strictEqual(e.completo, true);
  const d = directivaDatosDelCliente(e);
  // Único texto admitido: el freno de la dirección guardada (nace del bug de
  // conv_2001kyz8, donde un perfil COMPLETO igualmente la preguntó dos veces).
  assert.ok(!/FALTA|CLIENTE NUEVO|ANTES de tomar los platos/.test(d),
    "le pide datos a un cliente que ya está completo");
  assert.ok(/PROHIBIDO preguntarla abierta/.test(d),
    "sin este freno vuelve a preguntar la dirección que ya tiene");
});

test("registrado y completo PARA RECOGER: ni siquiera el freno de dirección", () => {
  const e = estadoDelPerfil({
    registrado: true, nombre: "Samuel Tineo", direccion: null,
    telefono: "634425921", tipoEntrega: "recoger"
  });
  assert.strictEqual(directivaDatosDelCliente(e), "", "mete ruido en una recogida");
});

test("registrado, para RECOGER: la dirección no hace falta", () => {
  const e = estadoDelPerfil({
    registrado: true, nombre: "Samuel Tineo", direccion: null,
    telefono: "634425921", tipoEntrega: "recoger"
  });
  assert.strictEqual(e.completo, true, "pide dirección para una recogida");
});

// ── 2. Registrado pero incompleto → pedir SOLO lo que falta ─────────────────
test("CASO REAL: registrado sin nombre → detecta que falta", () => {
  const e = estadoDelPerfil({
    registrado: true, nombre: null, direccion: "Avenida de los Frutales 14",
    telefono: "679391554", tipoEntrega: "domicilio"
  });
  assert.deepStrictEqual(e.faltan, ["nombre"]);
  assert.strictEqual(e.completo, false);
});

test("CASO REAL: prohíbe mentir y manda pedir el nombre ANTES de la comanda", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: true, nombre: null, direccion: "Avenida de los Frutales 14",
    telefono: "679391554", tipoEntrega: "domicilio"
  }));
  assert.ok(/NUNCA afirmes tener un dato que no tienes/.test(d), "puede volver a decir que lo tiene");
  assert.ok(/privacidad/.test(d), "no prohíbe la excusa de privacidad inventada");
  assert.ok(/ANTES de empezar a tomar los platos/.test(d), "no lo pide antes de la comanda");
  assert.ok(/nombre de quién/.test(d), "no le da la frase para pedirlo");
});

test("registrado e incompleto: NO se le pide consentimiento", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: true, nombre: null, direccion: "Avenida 14", telefono: "679391554", tipoEntrega: "domicilio"
  }));
  assert.ok(/NO le preguntes si guardar sus datos/.test(d), "le pediría consentimiento estando ya registrado");
});

test("registrado a domicilio sin dirección → la pide", () => {
  const e = estadoDelPerfil({
    registrado: true, nombre: "Ana Ruiz", direccion: null, telefono: "600111222", tipoEntrega: "domicilio"
  });
  assert.deepStrictEqual(e.faltan, ["dirección"]);
});

// ── 3. Cliente nuevo → pedir datos y consentimiento AL FINAL ────────────────
test("cliente nuevo: pide los datos antes y el consentimiento al final", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: false, nombre: null, direccion: null, telefono: null, tipoEntrega: "domicilio"
  }));
  assert.ok(/CLIENTE NUEVO/.test(d));
  assert.ok(/ANTES de tomar los platos/.test(d), "no pide los datos antes de la comanda");
  assert.ok(/AL FINAL/.test(d), "no pide el consentimiento al final");
  assert.ok(/save_profile_consent=true solo si dice que sí/.test(d));
});

// ── 4. Tipo de entrega ──────────────────────────────────────────────────────
test("detecta domicilio y recogida", () => {
  assert.strictEqual(tipoDeEntrega([U("Sería a domicilio")]), "domicilio");
  assert.strictEqual(tipoDeEntrega([U("Paso a recogerlo yo")]), "recoger");
  assert.strictEqual(tipoDeEntrega([U("Quiero una pizza")]), null);
});

// ── 5. El dato que da el cliente se capta (para poder guardarlo) ────────────
test("si Sarah pide el nombre y el cliente lo dice a secas, se capta", () => {
  assert.strictEqual(nombreCorregidoEnLlamada([
    A("¿A nombre de quién lo pongo?"),
    U("Antonio Roldán")
  ]), "Antonio Roldán");
});

test("una respuesta que NO es un nombre no se capta como tal", () => {
  assert.strictEqual(nombreCorregidoEnLlamada([
    A("¿A nombre de quién lo pongo?"),
    U("una pizza prosciutto y una coca-cola")
  ]), null);
});

test("un nombre suelto SIN que se lo hayan pedido no se capta", () => {
  assert.strictEqual(nombreCorregidoEnLlamada([
    A("¿Es para recoger o a domicilio?"),
    U("Prosciutto")
  ]), null, "confundiría un plato con el nombre del cliente");
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
