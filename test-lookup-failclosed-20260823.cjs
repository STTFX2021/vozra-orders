"use strict";
/**
 * GATE FAIL-CLOSED DE LECTURA DE PERFIL (23-08-2026)
 *
 * El bug: si Supabase se cae, `buscar_cliente` devolvia {encontrado:false} y
 * Sarah le decia "no te encuentro" a un cliente REGISTRADO. La autoridad de
 * identidad se degradaba en silencio: sin error, sin senal.
 *
 * Este test se pone ROJO si alguien vuelve a tragarse el error.
 */
const assert = require("assert");
const Module = require("module");

let modo = "ok";
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /marta-llm\.service\.js$/.test(parent.filename || "") && request === "./customer-store.js") {
    return {
      getCustomerByPhone: async (phone, options) => {
        if (modo === "caido") {
          if (options && options.throwOnError === true) throw new Error("profile read failed");
          return null;
        }
        if (modo === "nuevo") return null;
        return { phone, name: "Pedro", address: { raw: "Calle Mar 3" }, restrictions: { allergies: ["gluten"], preferences: [] }, orderCount: 4 };
      },
      upsertCustomer: async () => ({ ok: true }),
      updateCustomerAllergies: async () => ({ ok: true, allergies: [] })
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const marta = require("./marta-llm.service.js");
Module._load = originalLoad;

let ok = 0, fail = 0;
async function test(nombre, fn) {
  try { await fn(); console.log("  ok  " + nombre); ok++; }
  catch (e) { console.log("  FAIL " + nombre + "\n       " + e.message); fail++; }
}

(async () => {
  console.log("== Lectura de perfil: fail-closed ==================");

  await test("EL BUG: Supabase caido NO se convierte en 'no te encuentro' silencioso", async () => {
    modo = "caido";
    const out = await marta.computeLookup({ phone: "600123456" });
    assert.strictEqual(out.consulta_fallida, true,
      "la consulta fallida no viene marcada: vuelve el fail-open " + JSON.stringify(out));
  });

  await test("computeLookup pide throwOnError (si no, nunca se entera del fallo)", async () => {
    let pedido = null;
    const orig2 = Module._load;
    Module._load = function (request, parent, isMain) {
      if (parent && /marta-llm\.service\.js$/.test(parent.filename || "") && request === "./customer-store.js") {
        return { getCustomerByPhone: async (p, o) => { pedido = o; return null; }, upsertCustomer: async () => ({ ok: true }), updateCustomerAllergies: async () => ({ ok: true }) };
      }
      return orig2.call(this, request, parent, isMain);
    };
    delete require.cache[require.resolve("./marta-llm.service.js")];
    const m2 = require("./marta-llm.service.js");
    Module._load = orig2;
    await m2.computeLookup({ phone: "600123456" });
    assert.ok(pedido && pedido.throwOnError === true, "computeLookup NO pasa throwOnError:true");
  });

  await test("EL LIMITE: un cliente que de verdad no existe sigue siendo 'nuevo', no un error", async () => {
    modo = "nuevo";
    delete require.cache[require.resolve("./marta-llm.service.js")];
    const out = await marta.computeLookup({ phone: "600999999" });
    assert.strictEqual(out.encontrado, false, "un desconocido tiene que salir encontrado=false");
    assert.ok(!out.consulta_fallida, "un desconocido NO puede marcarse como fallo tecnico");
  });

  await test("un cliente registrado se sigue reconociendo igual", async () => {
    modo = "ok";
    const out = await marta.computeLookup({ phone: "600123456" });
    assert.strictEqual(out.encontrado, true);
    assert.strictEqual(out.nombre, "Pedro");
    assert.strictEqual(out.direccion, "Calle Mar 3");
    assert.deepStrictEqual(out.alergias_guardadas, ["gluten"]);
  });

  await test("el gate corta el turno con resolve_profile_read (no lo deja seguir)", async () => {
    const src = require("fs").readFileSync(require.resolve("./marta-llm.service.js"), "utf8");
    const bloque = src.slice(src.indexOf("let lookupFallido"), src.indexOf("`calcular_total` solo crea la"));
    assert.ok(bloque.length > 0, "no se encontro el bloque del dispatch de tools");
    assert.ok(/consulta_fallida === true/.test(bloque), "el dispatch no marca lookupFallido");
    assert.ok(/if \(lookupFallido\)/.test(bloque) && /resolve_profile_read/.test(bloque),
      "falta el corte fail-closed tras las tools");
  });

  console.log("\n" + ok + " ok / " + fail + " fail");
  process.exit(fail ? 1 : 0);
})();
