# NEXO — Changelog

## v1.4.0 — 25 de septiembre de 2026

**Renovación automática del token de Facebook.**

- El token de usuario de Facebook vive 60 días. NEXO ahora lo verifica solo con `/debug_token` y lo renueva con `fb_exchange_token` cuando vence dentro del margen (`FB_TOKEN_REFRESH_MARGIN_DAYS`, 7 días por defecto). El token renovado se guarda en `hub_service_tokens` (PostgreSQL) y las extracciones usan siempre el token vigente (BD primero, `FACEBOOK_USER_TOKEN` como respaldo).
- Nuevas variables: `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` (sin ellas, la renovación queda en modo manual como antes).
- Nuevas rutas: `GET /api/facebook/token` (estado: válido, días restantes, fuente, modo auto/manual) y `POST /api/facebook/token/refresh` (forzar renovación). Ninguna expone el valor del token.
- Chequeo al arrancar + re-chequeo diario (24 h). Los fallos se registran en el log sin detener el servicio.
- `test-all.js`: 43 pruebas (7 nuevas de token-refresh con fetch simulado, sin red ni credenciales).
- Docs: `README.md`, `INSTRUCCIONES.md` (bilingüe), `.env.example`.

## v1.3.0 — 24 de septiembre de 2026

**Webhook de WhatsApp multi-mensaje (opt-in).**

- Nuevas rutas `GET /webhook` (verificación de Meta) y `POST /webhook` (eventos con firma `X-Hub-Signature-256`; 200 inmediato, proceso en segundo plano; `message_id` duplicados ignorados).
- Loteo por remitente: los mensajes consecutivos se agrupan si llegan dentro de 3 min (`WA_BATCH_MAX_MS`); el lote se cierra con 30 s de pausa (`WA_BATCH_PAUSE_MS`) o al tope de 3 min.
- Triggers: `photo_relatos` (1 foto), `album_caption` / `album_no_caption` (2 fotos), `multi_photo_album` (3+ fotos, título con rango de fechas en America/Lima, respuesta con N fotos + rango), `audio_note` (1 audio), `multi_audio_notes` (2+ audios, etiquetas `audio_1…N` / `photo_1…M`), `text_only`, `album_add_text`.
- Reglas fijas: el audio siempre va a transcripciones/notas separadas (Whisper con `OPENAI_API_KEY`; sin ella queda pendiente), nunca al álbum; lotes mixtos se procesan por separado; el caption tardío no se anexa solo (comando explícito `agrégala al álbum`).
- Álbumes preparados para Momentos: `GET /api/whatsapp/albums`, `GET /api/whatsapp/albums/:id`, `GET /api/whatsapp/albums/:id/import` (payload `createalbum`/`uploadmedia`/`addtextitem`), `POST /api/whatsapp/albums/:id/import`, `GET /api/whatsapp/media/:albumId/:file`; tema Momentos inferido (celebrations/festivities/memories/travel/entertainment).
- Textos inmediatos: `ayuda`, `estado`, `extrae…` cierran el lote y se atienden sin esperar.
- Nuevas variables: `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `VERIFY_TOKEN`, `APP_SECRET`, `WA_BATCH_PAUSE_MS`, `WA_BATCH_MAX_MS`, `MOMENTOS_AUTHOR`, `MOMENTOS_BRIDGE_URL` (futuro).
- `test-all.js`: 36 pruebas (unitarias + E2E del loteo con `fastify.inject` + chequeo de producción con `TARGET=prod`).
- Docs: `README.md`, `INSTRUCCIONES.md` (bilingüe), manual v2 (bilingüe, DOCX), spec v1.3.0 (DOCX).

## v1.1.2 — 23 de septiembre de 2026

- Nueva ruta pública `GET /privacidad` con la política de privacidad (exigida por Meta para habilitar el inicio de sesión en la app NEXO de Facebook). Sin otros cambios funcionales.

## v1.1.1 — 22 de septiembre de 2026

- Todo el código runtime plano en la raíz (`source-facebook.js`, `source-instagram.js`, `adapter-legado.js`; se eliminaron las carpetas `sources/` y `adapters/`). Motivo: las subcarpetas no sobreviven el upload web de GitHub y tumbaban el deploy en Render (`Cannot find module './sources/facebook'`).

## v1.1.0 — 22 de septiembre de 2026

- Integración JEV (TypeSafe AI) como motor de decisiones: `choice` (categoría con confianza), `score` (relevancia 0–100), `noul` (puertas ¿duplicado? / ¿entrega segura?). Sin key o ante fallo, heurísticas locales sin bloquear.

## v1.0.0 — 22 de septiembre de 2026

- Versión inicial: hub de extracción Facebook/Instagram → paquetes estándar → enriquecimiento IA → entrega a Legado Vivo. Comandos en lenguaje natural, parser de exportación de WhatsApp (fase 2), DRY_RUN, `npm test` con 26 pruebas.
