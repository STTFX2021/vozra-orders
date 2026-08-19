# Configuración del agente Sarah (ElevenLabs)

**La fuente de verdad es este directorio, no el panel.**

| Fichero | Qué es |
|---|---|
| `agent-sarah.config.json` | Ajustes del agente (temperature, voz, tools, fillers, Custom LLM) |
| `prompt-sarah.md` | Prompt del agente. **Solo estilo**: cómo suena Sarah |
| `publicar-agente.cjs` | Publica el repo → agente. Sin `--publicar` solo enseña el diff |

## Por qué existe esto

Hasta el 18-08 el prompt y los ajustes del panel vivían **fuera de git y fuera de los
tests**. Cualquiera podía cambiarlos sin dejar rastro y romper producción con la suite
en verde. No es hipotético: ese mismo día se "arregló" el `first_message` poniéndole
espacios, deshaciendo una decisión deliberada de sam (sin espacios el saludo sale
seguido; con espacios suena lento), y estuvo así en producción varias horas.

## Uso

```bash
node elevenlabs/publicar-agente.cjs             # diff repo vs agente, NO publica
node elevenlabs/publicar-agente.cjs --publicar  # publica
```

Necesita `ELEVENLABS_API_KEY` y `ELEVENLABS_CUSTOM_LLM_SECRET` en el entorno.
El `${ELEVENLABS_CUSTOM_LLM_SECRET}` del JSON se sustituye al publicar: **nunca**
metas un secreto en estos ficheros (hay un test que lo comprueba).

## Regla

1. Si tocas el panel a mano, refléjalo aquí. Si no, el siguiente `--publicar` lo pisa.
2. El prompt de este directorio es **estilo**. Qué preguntar, qué bloquear, qué ofrecer,
   cuánto cuesta y cuándo se manda a cocina lo decide el backend, en código.
3. `test-elevenlabs-config-20260819.cjs` protege las decisiones de sam. Si falla, es
   que alguien ha cambiado algo que se decidió a propósito.
