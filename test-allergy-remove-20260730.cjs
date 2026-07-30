"use strict";
/**
 * Vozra PID — Test de la herramienta determinista `eliminar_alergia_guardada`.
 *
 * Objetivo (lógica, no parche): cuando el cliente dice "ya no soy alérgico / bórrala",
 * el CÓDIGO borra la alergia de la sesión y del perfil (Supabase) AL INSTANTE, y deja
 * de mencionarla el resto de la llamada. No depende del submit_order final.
 *
 * Sin Supabase configurado, upsertCustomer devuelve skipped → perfil_actualizado=false,
 * pero `eliminadas` DEBE venir poblado para que la sesión y la directiva antirrepetición
 * se disparen igual. Con Supabase, además, borra la fila real.
 */
const assert = require("assert");
const svc = require("./marta-llm.service.js");

let pass = 0, fail = 0;
function t(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log("  ok  " + name); })
    .catch(e => { fail++; console.log("  FAIL " + name + " → " + e.message); });
}

// La tool existe y está bien formada
t("A1 la tool eliminar_alergia_guardada está declarada", () => {
  assert.ok(svc.ALLERGY_REMOVE_TOOL, "falta ALLERGY_REMOVE_TOOL");
  assert.strictEqual(svc.ALLERGY_REMOVE_TOOL.function.name, "eliminar_alergia_guardada");
  assert.deepStrictEqual(svc.ALLERGY_REMOVE_TOOL.function.parameters.required, ["alergias"]);
});

// Contrato del handler: devuelve las alergias eliminadas aunque no haya BD
t("A2 computeRemoveAllergy devuelve eliminadas con teléfono en el historial", async () => {
  const conv = [
    { role: "user", content: "hola soy del 634425921" },
    { role: "assistant", content: "hola Samuel, la de siempre?" },
    { role: "user", content: "ya no soy alérgico al marisco, bórralo" }
  ];
  const out = await svc.computeRemoveAllergy({ alergias: ["marisco"] }, conv);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.eliminadas, ["marisco"]);
  assert.ok("perfil_actualizado" in out);
});

// Sin alergia → no-op seguro
t("A3 sin alergia → ok:false sin romper", async () => {
  const out = await svc.computeRemoveAllergy({ alergias: [] }, []);
  assert.strictEqual(out.ok, false);
});

// Acepta forma singular `alergia`
t("A4 acepta el campo singular alergia", async () => {
  const out = await svc.computeRemoveAllergy({ alergia: "frutos secos" }, [
    { role: "user", content: "mi telefono es 600111222 y ya no tengo alergia a los frutos secos" }
  ]);
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.eliminadas, ["frutos secos"]);
});

// La tool está en la lista que ve el modelo (indirecto: exportada y con nombre correcto)
t("A5 nombre de la tool es estable para el prompt", () => {
  assert.strictEqual(svc.ALLERGY_REMOVE_TOOL.function.name, "eliminar_alergia_guardada");
});

setTimeout(() => {
  console.log("\n" + pass + " ok / " + fail + " fail");
  process.exit(fail ? 1 : 0);
}, 1500);
