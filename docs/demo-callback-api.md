# API de callback de Vozra PID

`POST /api/demo/callback` inicia una llamada saliente de Sarah solamente después de validar consentimiento, teléfono, Cloudflare Turnstile y límites persistentes.

## Variables de Railway

```text
ELEVENLABS_API_KEY
ELEVENLABS_AGENT_ID=agent_7801kte3e78te9ga2xc076bxsw9e
ELEVENLABS_AGENT_PHONE_NUMBER_ID
TURNSTILE_SECRET
DEMO_DAILY_CAP=50
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ORDERS_SCHEMA=vozra_orders
```

## Preparación de base de datos

Ejecutar `supabase-demo-callbacks.sql` en Supabase SQL Editor antes de habilitar el endpoint en producción.

## Origen permitido

```text
https://vozra-direct-demo.lovable.app
```

## Respuestas

- `200`: llamada aceptada por ElevenLabs.
- `400`: consentimiento, teléfono o token CAPTCHA ausente.
- `403`: Turnstile inválido u origen no permitido.
- `429`: cooldown o límite diario.
- `502`: ElevenLabs no pudo iniciar la llamada.
- `503`: Turnstile o persistencia no disponibles.
