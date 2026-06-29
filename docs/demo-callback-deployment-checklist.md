# Checklist de despliegue

- [ ] Ejecutar `supabase-demo-callbacks.sql`.
- [ ] Añadir variables privadas en Railway.
- [ ] Confirmar que el número de ElevenLabs corresponde a `ELEVENLABS_AGENT_PHONE_NUMBER_ID`.
- [ ] Desplegar el backend.
- [ ] Comprobar preflight CORS desde `https://vozra-direct-demo.lovable.app`.
- [ ] Probar 400 sin consentimiento.
- [ ] Probar 403 con token Turnstile inválido.
- [ ] Probar 200 y recepción real de la llamada.
- [ ] Repetir en menos de 10 minutos y confirmar 429 sin segunda llamada.
