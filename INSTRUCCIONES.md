# NEXO — Instrucciones / Instructions

> **Español** abajo · **English** below

---

## 🇪🇸 Español

### Qué es NEXO

NEXO es tu hub personal de contenidos: extrae fotos, posts y videos de **tus propias cuentas** de Facebook e Instagram, los normaliza en paquetes estándar y los deja listos para tus apps (Momentos, Prisma Editorial, Legado Vivo).

Desde la **v1.3.0**, además, puede recibir mensajes de **WhatsApp** (opt-in): si le mandas varias fotos seguidas, las **junta en un solo álbum** para Momentos; cada nota de voz queda como **transcripción separada**.

### Puesta en marcha (solo la primera vez)

1. **GitHub:** crea un repo NUEVO llamado `nexo` y sube los archivos del ZIP **planos en la raíz** (sin subcarpetas de código: el upload web de GitHub las pierde y tumba el deploy).
2. **Render:** New → Web Service → conecta el repo `nexo`. Build: `npm install` · Start: `npm start` · Plan Free. (O usa Blueprint con `render.yaml`.)
3. **Base de datos:** crea una base nueva en Neon y pega el connection string en `DATABASE_URL`.
4. **Variables mínimas:** `FACEBOOK_USER_TOKEN` (Graph API Explorer, permisos `user_posts` + `user_photos`, extendido a 60 días).
5. **Opcionales:** `INSTAGRAM_USER_ID`, `OPENAI_API_KEY` (mejores resúmenes + transcripción de audios), `TYPESAFE_API_KEY` (decisiones JEV), `LEGADO_VIVO_URL` + `BRIDGE_API_KEY` + `LEGADO_FAMILY_ID` (entrega a Legado Vivo).
6. **Prueba:** abre `https://tu-servicio.onrender.com/` → debe decir `"servicio": "nexo"` y `"version": "1.4.0"`.

### Renovación automática del token de Facebook (v1.4.0)

El token de usuario de Facebook vive 60 días. Para no renovarlo a mano cada 2 meses:

1. En Render, agrega `FACEBOOK_APP_ID` y `FACEBOOK_APP_SECRET` (de tu app en Meta for Developers → Configuración → Información básica).
2. Listo: NEXO verifica la vigencia al arrancar y cada 24 h, y **renueva el token solo** cuando vence dentro de 7 días (`FB_TOKEN_REFRESH_MARGIN_DAYS`).
3. Consulta el estado en `GET /api/facebook/token` (válido, días restantes, fuente; **nunca** muestra el valor del token). Para forzar una renovación: `POST /api/facebook/token/refresh`.

Sin esas dos variables, la renovación sigue siendo manual (repite el flujo del Graph API Explorer).

### Activar el WhatsApp multi-mensaje (v1.3.0, opcional)

> El Asistente Puente actual **no se toca**: esto usa una app de Meta **aparte**.

1. En [Meta for Developers](https://developers.facebook.com/), con tu app **NEXO** (la creada para el token de Facebook), ve a **WhatsApp → Configuración de la API** y agrega tu número (o usa el número de prueba).
2. En **Webhooks** (del panel de la app): Callback URL `https://tu-servicio.onrender.com/webhook`, token de verificación = el valor de `VERIFY_TOKEN` que inventes. Suscribe el campo **messages**.
3. En Render, configura: `WHATSAPP_TOKEN` (token permanente del system user), `PHONE_NUMBER_ID`, `VERIFY_TOKEN` (el mismo del paso 2), `APP_SECRET` (de la app de Meta).
4. Opcionales: `WA_BATCH_PAUSE_MS` (default 30000), `WA_BATCH_MAX_MS` (default 180000), `MOMENTOS_AUTHOR` (default `Miguel Susffalich`).
5. Prueba: escríbele al número 3 fotos seguidas + 1 audio. En ~30 s te responde con el álbum.

### Cómo usarlo por WhatsApp

- **Manda fotos seguidas** (una tras otra): NEXO espera 30 s sin mensajes y las junta en **un solo álbum** con título de rango de fechas, p. ej. *Fotos del 20 al 24 de septiembre de 2026*.
- **Notas de voz:** cada audio queda como **nota separada con su transcripción** (etiquetas `audio_1`, `audio_2`…); nunca se meten dentro del álbum.
- **Mixto (fotos + audios):** se procesa por separado — álbum por un lado, notas por otro.
- **Texto después del álbum:** si escribes algo después de creado el álbum, **no se anexa solo**. NEXO te dice `Anotado: "…"` y te pide el comando. Escribe **"agrégala al álbum"** y ese texto pendiente se agrega al último álbum.
- **Comandos:** `ayuda` (qué sé hacer), `estado` (cómo van los trabajos), `extrae mis fotos de facebook de esta semana` (inicia una extracción).
- **Límites honestos:** Momentos no tiene API pública, así que el álbum queda **preparado en NEXO** y se importa a Momentos desde el chat con Muse (pídeme "importa el último álbum de NEXO a Momentos"). Sin `OPENAI_API_KEY`, los audios se guardan pero su transcripción queda pendiente.

### Importar un álbum a Momentos (desde el chat con Muse)

1. Pide el payload: `GET https://tu-servicio.onrender.com/api/whatsapp/albums` (elige el `album_id`).
2. `GET /api/whatsapp/albums/<album_id>/import` → trae `album` (para `createalbum`), `media` (para `uploadmedia`, con `fileUrl` por foto) y `textos` (para `addtextitem`: transcripciones `audio_1…N` y textos).
3. En Momentos: `createalbum` → `uploadmedia` por cada foto → `addtextitem` por cada nota/texto. Listo.

### Pruebas

- Local: `node test-all.js` (36 pruebas, sin red ni credenciales).
- Producción (solo lectura): `TARGET=prod node test-all.js`.
- E2E firmado contra prod: `WA_E2E=1 TARGET=prod WA_TEST_APP_SECRET=<APP_SECRET> node test-all.js`.

---

## 🇬🇧 English

### What NEXO is

NEXO is your personal content hub: it pulls photos, posts and videos from **your own** Facebook and Instagram accounts, normalizes them into standard packages, and makes them available to your apps (Momentos, Prisma Editorial, Legado Vivo).

Since **v1.3.0** it can also receive **WhatsApp** messages (opt-in): send several photos in a row and it bundles them into **one album** for Momentos; each voice note becomes a **separate transcription**.

### First-time setup

1. **GitHub:** create a NEW repo named `nexo` and upload the ZIP files **flat at the root** (no code subfolders: GitHub's web upload drops them and breaks the deploy).
2. **Render:** New → Web Service → connect the `nexo` repo. Build: `npm install` · Start: `npm start` · Free plan. (Or use Blueprint with `render.yaml`.)
3. **Database:** create a new Neon database and paste the connection string into `DATABASE_URL`.
4. **Minimum vars:** `FACEBOOK_USER_TOKEN` (Graph API Explorer, `user_posts` + `user_photos` scopes, extended to 60 days).
5. **Optional:** `INSTAGRAM_USER_ID`, `OPENAI_API_KEY` (better summaries + audio transcription), `TYPESAFE_API_KEY` (JEV decisions), `LEGADO_VIVO_URL` + `BRIDGE_API_KEY` + `LEGADO_FAMILY_ID` (Legado Vivo delivery).
6. **Test:** open `https://your-service.onrender.com/` → it must say `"servicio": "nexo"` and `"version": "1.4.0"`.

### Automatic Facebook token renewal (v1.4.0)

The Facebook user token lives 60 days. To avoid renewing it by hand every 2 months:

1. In Render, add `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` (from your app in Meta for Developers → Settings → Basic).
2. Done: NEXO checks validity at boot and every 24 h, and **renews the token by itself** when it expires within 7 days (`FB_TOKEN_REFRESH_MARGIN_DAYS`).
3. Check status at `GET /api/facebook/token` (valid, days remaining, source; it **never** shows the token value). To force a renewal: `POST /api/facebook/token/refresh`.

Without those two variables, renewal stays manual (repeat the Graph API Explorer flow).

### Enabling multi-message WhatsApp (v1.3.0, optional)

> The current Asistente Puente is **untouched**: this uses a **separate** Meta app.

1. In [Meta for Developers](https://developers.facebook.com/), with your **NEXO** app, go to **WhatsApp → API Setup** and add your number (or use the test number).
2. Under the app's **Webhooks**: Callback URL `https://your-service.onrender.com/webhook`, verify token = your `VERIFY_TOKEN` value. Subscribe to the **messages** field.
3. In Render set: `WHATSAPP_TOKEN` (system-user permanent token), `PHONE_NUMBER_ID`, `VERIFY_TOKEN` (same as step 2), `APP_SECRET` (from the Meta app).
4. Optional: `WA_BATCH_PAUSE_MS` (default 30000), `WA_BATCH_MAX_MS` (default 180000), `MOMENTOS_AUTHOR` (default `Miguel Susffalich`).
5. Test: send the number 3 photos in a row + 1 voice note. In ~30 s it replies with the album.

### Using it over WhatsApp

- **Send photos in a row** (one after another): NEXO waits 30 s with no new messages and bundles them into **one album** with a date-range title, e.g. *Fotos del 20 al 24 de septiembre de 2026*.
- **Voice notes:** each audio becomes a **separate note with its transcription** (labels `audio_1`, `audio_2`, …); they never go inside the album.
- **Mixed (photos + audios):** processed separately — album on one side, notes on the other.
- **Text after the album:** if you write something after the album was created, it is **not auto-appended**. NEXO replies `Anotado: "…"` and asks for the explicit command. Write **"agrégala al álbum"** and that pending text is added to the latest album.
- **Commands:** `ayuda` (what I can do), `estado` (job status), `extrae mis fotos de facebook de esta semana` (starts an extraction).
- **Honest limits:** Momentos has no public API, so the album stays **prepared in NEXO** and is imported into Momentos from the Muse chat (ask me "import the latest NEXO album into Momentos"). Without `OPENAI_API_KEY`, audios are saved but their transcription stays pending.

### Importing an album into Momentos (from the Muse chat)

1. Get the payload: `GET https://your-service.onrender.com/api/whatsapp/albums` (pick the `album_id`).
2. `GET /api/whatsapp/albums/<album_id>/import` → returns `album` (for `createalbum`), `media` (for `uploadmedia`, with a `fileUrl` per photo) and `textos` (for `addtextitem`: `audio_1…N` transcriptions and texts).
3. In Momentos: `createalbum` → `uploadmedia` per photo → `addtextitem` per note/text. Done.

### Tests

- Local: `node test-all.js` (36 tests, no network or credentials).
- Production (read-only): `TARGET=prod node test-all.js`.
- Signed E2E against prod: `WA_E2E=1 TARGET=prod WA_TEST_APP_SECRET=<APP_SECRET> node test-all.js`.
