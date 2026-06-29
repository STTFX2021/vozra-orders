# Alcance del PR

Este cambio añade únicamente la entrada segura de la demo web al motor existente. No modifica la lógica de conversación, pedidos, cocina, WhatsApp ni impresión de Vozra Orders.

Incluye:

- Endpoint `POST /api/demo/callback`.
- Verificación Cloudflare Turnstile.
- Normalización E.164.
- Anti-abuso persistente y atómico en Supabase.
- Llamada saliente al agente Sarah mediante ElevenLabs.
- CORS limitado a la demo Lovable.
- Pruebas de contrato y documentación de despliegue.
