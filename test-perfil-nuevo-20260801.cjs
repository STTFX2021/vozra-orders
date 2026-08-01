/**
 * test-perfil-nuevo-20260801.cjs
 *
 * LO QUE IMPORTA (owner, 01-08): que se CREEN los perfiles nuevos y que, si hay
 * que cambiar un dato, se cambie SIN ENTRAR EN BUCLE. El cliente ya registrado y
 * completo ya funcionaba; el caso interesante es el que llega sin ficha.
 *
 * BUCLE REAL que motiva este test (llamada del 01-08):
 *   Agent: ¿A nombre de quién lo pongo, por favor?
 *   User:  Jodido cabezón.
 *   Agent: Perfecto, Jodido cabezón. ¿A qué dirección te lo llevamos?   ← lo oyó
 *   User:  A, Avenida Los Frutales, Aldea de la Luna, casa 137.
 *   Agent: ¿A nombre de quién lo pongo, por favor?                      ← lo repide
 *   User:  Jodido cabezón.
 *   Agent: ¿A nombre de quién lo pongo, por favor?                      ← otra vez
 *
 * Causa: la captura del nombre exigía mayúscula en TODAS las palabras
 * ("cabezón" en minúscula la tumbaba) → el gate creía que seguía faltando y
 * reinyectaba la orden de pedirlo en cada turno.
 *
 *   node test-perfil-nuevo-20260801.cjs
 */
const assert = require("assert");
const {
  nombreCorregidoEnLlamada,
  estadoDelPerfil,
  directivaDatosDelCliente,
  vecesPedidoCadaDato
} = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log("  ok  " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n       " + e.message); fail++; }
}
const A = c => ({ role: "assistant", content: c });
const U = c => ({ role: "user", content: c });

const BUCLE_REAL = [
  A("PizzeriaLaLocandaCancelada, te atiende Sarah, ¿en qué te puedo ayudar?"),
  U("Me gustaría hacer un pedido a domicilio."),
  A("Perfecto, para empezar, ¿me dices un teléfono de contacto, por favor?"),
  U("Sí, el 679391554."),
  A("¿A nombre de quién lo pongo, por favor?"),
  U("Jodido cabezón."),
  A("Perfecto, Jodido cabezón. ¿A qué dirección te lo llevamos?"),
  U("A, Avenida Los Frutales, Aldea de la Luna, casa 137.")
];

console.log("══ Perfil nuevo / incompleto sin bucle ═══════════");

// ── 1. La captura del nombre, que era la raíz ───────────────────────────────
test("CASO REAL: capta 'Jodido cabezón' (segunda palabra en minúscula)", () => {
  assert.strictEqual(nombreCorregidoEnLlamada(BUCLE_REAL), "Jodido cabezón",
    "si no lo capta, el gate lo repide en cada turno = bucle");
});

test("capta el nombre lo diga como lo diga", () => {
  const casos = [
    ["Antonio Roldán", "Antonio Roldán"],
    ["antonio roldán", "antonio roldán"],
    ["Eh, pues Samuel Tineo", "Samuel Tineo"],
    ["soy María José", "María José"],
    ["Sí, Pedro", "Pedro"],
    ["Valentina", "Valentina"]   // no debe partirse en "vale" + "ntina"
  ];
  for (const [dicho, esperado] of casos) {
    assert.strictEqual(
      nombreCorregidoEnLlamada([A("¿A nombre de quién lo pongo?"), U(dicho)]),
      esperado, "falla con: " + dicho);
  }
});

test("una vez captado, el perfil ya NO está incompleto", () => {
  const nombre = nombreCorregidoEnLlamada(BUCLE_REAL);
  const e = estadoDelPerfil({
    registrado: true, nombre, direccion: "Avenida Los Frutales 137",
    telefono: "679391554", tipoEntrega: "domicilio",
    yaPedidos: vecesPedidoCadaDato(BUCLE_REAL)
  });
  assert.strictEqual(e.completo, true, "seguiría pidiendo el nombre");
  assert.strictEqual(directivaDatosDelCliente(e), "", "seguiría insistiendo");
});

// ── 2. El freno duro: nunca más de dos veces ────────────────────────────────
test("cuenta cuántas veces se ha pedido cada dato", () => {
  const c = vecesPedidoCadaDato(BUCLE_REAL);
  assert.strictEqual(c["nombre"], 1);
  assert.strictEqual(c["teléfono"], 1);
  assert.strictEqual(c["dirección"], 1);
});

test("FRENO: pedido 2 veces sin éxito → prohibido insistir, se sigue", () => {
  const e = estadoDelPerfil({
    registrado: true, nombre: null, direccion: "Avenida 14",
    telefono: "679391554", tipoEntrega: "domicilio",
    yaPedidos: { "nombre": 2 }
  });
  assert.deepStrictEqual(e.faltan, [], "seguiría pidiéndolo una tercera vez");
  assert.deepStrictEqual(e.abandonados, ["nombre"]);
  const d = directivaDatosDelCliente(e);
  assert.ok(/PROHIBIDO volver a preguntarlo/.test(d), "no frena la insistencia");
  assert.ok(/SIGUE con el pedido/.test(d), "no manda continuar sin el dato");
});

test("a la primera vez SÍ se pide (el freno no es un bloqueo)", () => {
  const e = estadoDelPerfil({
    registrado: true, nombre: null, direccion: "Avenida 14",
    telefono: "679391554", tipoEntrega: "domicilio",
    yaPedidos: { "nombre": 1 }
  });
  assert.deepStrictEqual(e.faltan, ["nombre"]);
});

test("la directiva dice explícitamente que dé por bueno lo ya dicho", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: true, nombre: null, direccion: "Avenida 14",
    telefono: "679391554", tipoEntrega: "domicilio", yaPedidos: {}
  }));
  assert.ok(/DALO POR BUENO tal cual/.test(d));
  assert.ok(/NO se lo vuelvas a preguntar/.test(d));
});

// ── 3. Cliente totalmente nuevo ─────────────────────────────────────────────
test("cliente NUEVO: pide los datos antes, consentimiento al final", () => {
  const d = directivaDatosDelCliente(estadoDelPerfil({
    registrado: false, nombre: null, direccion: null, telefono: null,
    tipoEntrega: "domicilio", yaPedidos: {}
  }));
  assert.ok(/CLIENTE NUEVO/.test(d));
  assert.ok(/ANTES de tomar los platos/.test(d));
  assert.ok(/AL FINAL/.test(d));
});

test("cliente nuevo que ya dio teléfono y nombre: solo falta la dirección", () => {
  const e = estadoDelPerfil({
    registrado: false, nombre: "Jodido cabezón", direccion: null,
    telefono: "679391554", tipoEntrega: "domicilio", yaPedidos: {}
  });
  assert.deepStrictEqual(e.faltan, ["dirección"]);
});

console.log("");
console.log(pass + " ok / " + fail + " fail");
process.exit(fail ? 1 : 0);
