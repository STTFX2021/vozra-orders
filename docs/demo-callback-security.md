# Límites de seguridad de la demo

- Las claves de ElevenLabs, Turnstile y Supabase permanecen exclusivamente en Railway.
- El navegador solo puede llamar desde `https://vozra-direct-demo.lovable.app`.
- Cloudflare Turnstile se verifica en servidor antes de reservar o disparar una llamada.
- La reserva del intento es atómica y persistente para evitar carreras y costes duplicados.
- Los logs enmascaran el teléfono y conservan un identificador de solicitud.
- Si la persistencia no está disponible, el endpoint falla cerrado y no llama al proveedor.
