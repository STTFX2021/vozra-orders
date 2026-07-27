# NEXT_SESSION — Vozra PID

> Solo Vozra PID. Roomy Food está en `../roomy-food` con su propia memoria.

**Escrito el:** 2026-07-20

## Próximo paso: DESPLEGAR Y VALIDAR EL FIX DEL 20-07
Rama `fix/pid-nombre-generico-y-recoger-20260720`, commit `353a990`. **Commiteado pero NO desplegado ni validado en llamada real.**

1. Mergear a `main` y desplegar en Railway.
2. **Verificar el hash del build desplegado.** El fallo `"Right..."` NO era de código: el saneador ya lo limpiaba en `main`. Railway estaba sirviendo un build viejo → puede haber más fixes del 18-07 sin aplicar (puntos suspensivos, orden teléfono-primero).
3. **Llamada de prueba obligatoria, escenario RECOGER con teléfono nuevo:**
   - NO debe decir muletillas en inglés ni puntos suspensivos.
   - NO debe llamarle "cliente" → debe preguntar "¿A nombre de quién lo dejo?".
   - **NO debe mencionar NINGUNA dirección** (ni pedirla, ni confirmarla).
   - NO debe decir "voy a buscar tu perfil" ni similar.
4. Comprobar en Supabase que el perfil nuevo NO guarda un nombre genérico.

⚠️ Los tests automáticos (20+6+10+2, verdes) **no cubren** `generateMartaReply` ni el prompt. Solo prueban no-regresión.

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
