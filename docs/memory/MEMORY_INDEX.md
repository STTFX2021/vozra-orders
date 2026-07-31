# 🧠 MEMORY INDEX — Vozra / Roomy

> **LÉEME PRIMERO en cada sesión nueva.** Este es el punto de entrada único a la memoria del proyecto. La IA no recuerda nada entre sesiones: todo el contexto vive aquí.

**Última actualización:** 2026-07-31
**Owner:** sam (STTFX2021 / sttfx2021@gmail.com)
**HEAD = producción:** `84f8e94` (todo desplegado, nada pendiente de push)

> **TODO Vozra PID está aquí, en `backend/docs/memory/`.** El snapshot completo y actual vive en `PROJECT_STATE.md` (un solo fichero con todo). Este es el sitio único: los chats van y vienen, esta carpeta permanece (y se versiona en git).

---

## Cómo usar esta memoria

1. **Al empezar a trabajar** → lee `NEXT_SESSION.md` (qué toca hacer ahora) y `PROJECT_STATE.md` (estado real de todo).
2. **Durante la sesión** → trabaja normal.
3. **Al terminar** → ejecuta la rutina de `MEMORY_ROUTINE.md` (actualizar estado + añadir entrada al log + reescribir el "próximo paso").

---

## Archivos de esta carpeta

| Archivo | Qué contiene | Cuándo leerlo |
|---|---|---|
| `MEMORY_INDEX.md` | Este índice | Primero, siempre |
| `PROJECT_STATE.md` | **Fuente de verdad**: qué existe, qué está desplegado, qué está pendiente | Al empezar |
| `NEXT_SESSION.md` | El próximo paso concreto, listo para retomar | Al empezar |
| `SESSION_LOG.md` | Historial cronológico de sesiones (append-only) | Para contexto histórico |
| `MEMORY_ROUTINE.md` | La rutina de cierre y de arranque | Al terminar / al empezar |
| `KEY_FACTS.md` | Datos duros: IDs, URLs, credenciales-referencia (sin secretos) | Cuando necesites un ID/URL |

---

## Resumen de una línea

**Vozra PID / Vozra Orders**: agente de voz de la pizzería La Locanda, EN PRODUCCIÓN.

> **Roomy Food se separó a su propio proyecto** (`../roomy-food`) el 2026-07-18. Este proyecto queda SOLO para Vozra PID. Todo lo de room service de hotel está allí, con su propia memoria.

---

## Regla de oro de la memoria

- **Nunca borres** entradas del `SESSION_LOG.md`: solo se añade.
- **`PROJECT_STATE.md` siempre refleja el presente**: si algo cambió, se actualiza (no se acumula).
- **Sin secretos**: tokens, API keys y contraseñas NUNCA se escriben aquí. Solo referencias ("el token está en Railway → Variables").
