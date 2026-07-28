# NEXT_SESSION — Vozra PID

> Solo Vozra PID. Roomy Food está en `../roomy-food` con su propia memoria.

**Escrito el:** 2026-07-28

## Próximo paso: COMMIT + PUSH + DEPLOY + LLAMADA DE PRUEBA
Fixes del 28-07 aplicados en `main` (working tree), **verdes en tests, SIN commit/push/deploy.**

1. **Commit** (incluye los 2 ficheros nuevos sin trackear):
   `git add marta-llm.service.js allergen-ontology.service.js test-pid-fixes-20260728.cjs`
   `git commit -m "fix(pid): alergia sin Oye + retirable/intrinseco + upsell unico + consent forzado + sin ETA inventada"`
2. **Railway (bloqueante real):** `origin/main` = `2bc9448`; `main` local está +5 (con el commit de hoy, +6) SIN pushear. Confirmar el commit desplegado. Si Railway sirve `origin/main`, en producción NO hay ningún fix desde el 20-07 → `git push` y desplegar.
3. **Llamada de prueba obligatoria** tras deploy, dos escenarios:
   - RECOGER, teléfono nuevo: no "cliente" (pregunta "¿a nombre de quién?"), no menciona dirección, no dice "voy a buscar tu perfil", sin muletillas inglesas ni puntos suspensivos.
   - Alergia: "soy alérgico al marisco, ponme una Abruzzo" → debe avisar de los langostinos y ofrecer quitarlos (topping), SIN empezar con "Oye". Upsell: ofrecer bebida una vez; si el cliente la añade, NO volver a ofrecer postre. NO inventar hora de entrega.
4. Supabase: el perfil nuevo NO guarda nombre genérico.

## Ontología de alérgenos (montada, vacía)
`backend/allergen-ontology.service.js`, `ONTOLOGY = {}`. Cuando el restaurante dé la info por plato (qué alérgeno es topping retirable vs intrínseco), rellenar el mapa con el formato del ejemplo comentado. En cuanto tenga datos, la carta que ve Sarah los muestra y deja de deducir. Interino: deduce de la descripción.

⚠️ Los tests automáticos (18 nuevos + 20+6+10+5) **no ejecutan** el LLM. Prueban que la regla y el código determinista existen. Que Sarah OBEDEZCA se valida solo en llamada real.

## Roomy B2 en stash
El trabajo de B2 quedó en `git stash` ("wip-b2") sobre `work/roomy-b2-domain-tenant-registry-20260719`. Para retomarlo: checkout a esa rama + `git stash pop`. Queda pendiente arreglar el test mock (llama sin ctx) y commitear.

### Pista fuerte de la última sesión (simulador, 2026-07-19)
En `node simulator.js` se vio este comportamiento anómalo:

```
Tú: una pizza, pero no estoy seguro de cuál.
🤖 Marta: ¿Algo más o con eso te vale?
Tú: el que?
🤖 Marta: ¿Algo más o con eso te vale?
Tú: como?
🤖 Marta: ¿Algo más o con eso te vale?
```

**Diagnóstico:** el simulador NO usa el cerebro LLM — usa el **motor legacy** `order-slot-filler.service.js` (`processTurn`). Por eso repite la misma frase y no entiende preguntas. Es un bucle del parser por reglas.

**Dos vías posibles, a decidir con el usuario:**
1. Si el fallo que quiere afinar es **este bucle del simulador** → el arreglo real es que el simulador use `generateMartaReply` (el cerebro), o directamente retirar el simulador legacy. Ojo: el motor legacy es deuda técnica ya identificada en B0 y NO se usa en producción.
2. Si el fallo es **en llamadas reales** (ElevenLabs) → entonces sí afecta al cerebro LLM y hay que ver el transcript concreto.

**Importante:** en producción, PID usa `generateMartaReply` (LLM), no `processTurn`. El comportamiento del simulador **no** refleja lo que oye un cliente real.

## Estado de PID
Operativo en producción. Últimos fixes (orden teléfono-primero, sin puntos suspensivos, zona de reparto, pago, promos, incidencias) aplicados en `main`.

## ⚠️ Aviso de despliegue (por B2 de Roomy)
La rama de Roomy B2 introduce fail-closed: el servidor exigirá `SERVICE_DOMAIN` y `TENANT_SLUG`. **Eso NO está en `main`** todavía. Si algún día se mergea, hay que añadir esas variables en Railway ANTES o el servicio no arrancará.

## Deuda conocida (de la auditoría/B0)
- Tests cubren el motor legacy, no el cerebro real (B1 de Roomy ya añadió cobertura del camino real).
- `validateOrder` no bloquea el dispatch → pendiente (B3).
- `/kitchen/ack` sin auth; LLM abierto si falta secret; PII en logs.
- Monitor de ACK en memoria.

## Cómo empezar
MEMORY_INDEX → este archivo → PROJECT_STATE. Preguntar al usuario: "¿Cuál es el fallo de PID que quieres afinar? ¿Lo viste en el simulador o en una llamada real?".
