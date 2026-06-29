# Vozra PID — callback telefónico de la demo

## Despliegue

1. Ejecutar `supabase-demo-callbacks.sql` una sola vez en Supabase SQL Editor.
2. Configurar las variables de entorno del backend en Railway.
3. Desplegar la rama y comprobar `POST /api/demo/callback` desde el origen permitido.

## Variables requeridas

```text
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=agent_7801kte3e78te9ga2xc076bxsw9e
ELEVENLABS_AGENT_PHONE_NUMBER_ID=
TURNSTILE_SECRET=
DEMO_DAILY_CAP=50
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_ORDERS_SCHEMA=vozra_orders
```

## Contrato

```http
POST /api/demo/callback
Origin: https://vozra-direct-demo.lovable.app
Content-Type: application/json
```

```json
{
  "phone": "+34600123456",
  "country": "ES",
  "consent": true,
  "captchaToken": "turnstile-token"
}
```

Respuesta correcta:

```json
{ "ok": true }
```

## Límites

- Una llamada por número cada 10 minutos.
- Dos intentos por número y día.
- Límite global diario configurable con `DEMO_DAILY_CAP`.
- Los intentos se reservan atómicamente en `vozra_orders.demo_callbacks` antes de llamar a ElevenLabs.
