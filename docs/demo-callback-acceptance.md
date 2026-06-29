# Comprobaciones de aceptación

El contrato automatizado `test-demo-callback.cjs` verifica:

1. Composición E.164 para números nacionales e internacionales.
2. Rechazo `400` sin consentimiento.
3. Rechazo `403` con Turnstile inválido.
4. Rechazo `429` durante el cooldown, sin segunda llamada al proveedor.
5. Respuesta `200` y una única llamada al proveedor con datos válidos.

La prueba real de recepción en móvil requiere configurar las variables privadas en Railway y ejecutar `supabase-demo-callbacks.sql`.
