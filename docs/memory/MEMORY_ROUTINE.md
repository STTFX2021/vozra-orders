# MEMORY_ROUTINE — Rutina de cierre y arranque de sesión

> Dos rutinas cortas. Una al empezar a trabajar, otra al terminar. Su objetivo: que ninguna sesión empiece "en frío" ni termine perdiendo lo hecho.

---

## 🟢 RUTINA DE ARRANQUE (al empezar a trabajar)

**Disparador:** el usuario dice algo como "seguimos", "retomamos", "buenas, ¿por dónde íbamos?", o simplemente empieza a pedir trabajo sin contexto.

**Pasos (la IA los hace sola, sin que el usuario lo pida):**
1. Leer `docs/memory/MEMORY_INDEX.md`.
2. Leer `docs/memory/NEXT_SESSION.md` (el próximo paso).
3. Leer `docs/memory/PROJECT_STATE.md` (estado real).
4. Si hace falta un ID/URL/ruta, consultar `docs/memory/KEY_FACTS.md`.
5. Resumir al usuario en 3-4 líneas: dónde lo dejamos y cuál es el siguiente paso propuesto.
6. Preguntar: "¿Arrancamos con [próximo paso], o prefieres otra cosa?".

No empezar a trabajar a ciegas. Primero contexto, luego acción.

---

## 🔴 RUTINA DE CIERRE (al terminar de trabajar)

**Disparador:** el usuario dice "lo dejamos aquí", "cerramos por hoy", "guarda la memoria", "hasta mañana", o similar.

**Pasos:**
1. **Actualizar `PROJECT_STATE.md`**: reflejar lo que cambió esta sesión (nuevos fixes, nuevo estado de bloques, lo que pasó de pendiente a hecho). Es una foto del PRESENTE: se reescribe lo que cambió, no se acumula.
2. **Añadir una entrada nueva a `SESSION_LOG.md`**: fecha, qué se hizo, decisiones clave, pendiente al cerrar. La entrada nueva va ARRIBA (justo bajo el título). NUNCA borrar entradas viejas.
3. **Reescribir `NEXT_SESSION.md`**: cuál es el próximo paso concreto para la sesión siguiente, y qué comprobar antes de arrancar.
4. **Actualizar `KEY_FACTS.md`** solo si aparecieron IDs/URLs/rutas nuevas.
5. **Actualizar la fecha** de "Última actualización" en los archivos tocados.
6. **Commit + push** de la carpeta de memoria (si el usuario lo aprueba):
   ```
   cd 'D:\VOZRA\vozra_proyecto_completo_20260620\vozra-orders'
   git add docs/memory/
   git commit -m "memoria: cierre de sesión YYYY-MM-DD"
   git push origin main
   ```
7. Confirmar al usuario en 2 líneas: "Memoria actualizada. La próxima vez retomamos por [X]."

---

## Reglas de la memoria

- **Sin secretos.** Tokens, API keys y contraseñas NUNCA se escriben. Solo referencias ("está en Railway → Variables").
- **`SESSION_LOG.md` es sagrado**: solo se añade, jamás se borra.
- **`PROJECT_STATE.md` es el presente**: si algo dejó de ser cierto, se corrige.
- **Honestidad**: si algo quedó a medias o roto, se anota tal cual. La memoria no es un escaparate, es una herramienta de trabajo.
- **Frases para disparar la rutina de cierre**, para que el usuario la recuerde: **"guarda la memoria"** o **"cerramos sesión"**.
