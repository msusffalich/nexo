# NEXO

![NEXO — Asistente Puente](assets/nexo-logo.png)

**Hub de extracción de contenidos** — evolución del Asistente Puente. Extrae fotos, posts y videos de tus cuentas de **Facebook** e **Instagram**, los normaliza en paquetes estándar y los deja listos para tus otras apps (Momentos, Prisma Editorial, Legado Vivo).

> ⚠️ **El Asistente Puente actual NO se toca.** Sigue en producción con su repo, su servicio Render y su webhook de Meta intactos. NEXO es un servicio **nuevo y separado**.

**v1.4.0 — novedad:** renovación **automática** del token de Facebook: NEXO verifica su vigencia y lo renueva solo antes de que venza (60 días), sin que tengas que repetir el flujo manual. Ver [Token de Facebook](#puesta-en-marcha-pasos-para-miguel).

**v1.3.0:** webhook de WhatsApp **opt-in** con loteo multi-mensaje: las fotos que mandas seguidas se juntan en un solo álbum para **Momentos**, y cada nota de voz queda como transcripción separada. Ver [Webhook de WhatsApp multi-mensaje](#webhook-de-whatsapp-multi-mensaje-v130) y `INSTRUCCIONES.md`.

---

## Cómo funciona

1. **Extrae** — Lee tu contenido propio vía Graph API oficial de Meta (Facebook e Instagram).
2. **Normaliza** — Convierte cada post/foto en un **paquete estándar**: `{package_id, source, author, created_at, text, media[], metadata}`.
3. **Enriquece con IA** — Clasifica por tema (familia, viaje, comida…), resume, etiqueta y **deduplica** (nunca guarda dos veces lo mismo). Con la key configurada, **JEV (TypeSafe AI)** agrega decisiones rápidas: categoría con confianza, puntaje de relevancia y puertas binarias (¿duplicado? ¿entrega segura?).
4. **Entrega** — Guarda los paquetes para que los uses desde el chat con Muse, por API, o los envía a Legado Vivo como borrador.
5. **WhatsApp multi-mensaje (v1.3.0, opt-in)** — Recibe fotos, audios y textos por el webhook `/webhook`, los **agrupa en lotes** por remitente y arma álbumes listos para **Momentos** (las notas de voz van como transcripciones separadas, nunca dentro del álbum).

**Comandos en lenguaje natural** (mismo estilo del puente actual):

| Ejemplo | Hace |
|---|---|
| `tráeme mis fotos de instagram de marzo` | Extrae fotos de IG de marzo |
| `extrae mis posts de facebook del 1 al 15 de enero de 2026` | Extrae posts de FB en ese rango |
| `jala mis videos de instagram de esta semana` | Extrae videos recientes |
| `cómo van mis extracciones` | Muestra el estado de los trabajos |

WhatsApp: el bot actual sigue capturando foto+relato como siempre. El **historial de chats personales** llega en **fase 2** (exportación manual del chat → `importar-whatsapp`).

## Puesta en marcha (pasos para Miguel)

**1. Crea un repo NUEVO en GitHub**
- Nombre sugerido: `nexo` (público o privado, como prefieras).
- Sube estos archivos **planos en la raíz** (todo el código runtime va 100% en la raíz, SIN subcarpetas de código: las carpetas no sobreviven el upload web de GitHub, y eso fue lo que tumbó el deploy de la v1.1.0):
  `package.json`, `index.js`, `config.js`, `store.js`, `intent.js`, `jobs.js`, `normalize.js`, `ai.js`, `jev.js`, `cli.js`, `whatsapp-export.js`, `whatsapp-webhook.js`, `token-refresh.js`, `source-facebook.js`, `source-instagram.js`, `adapter-legado.js`, `adapter-momentos.js`, `test-all.js`, `render.yaml`, `.env.example`, `.gitignore`, `README.md`, `INSTRUCCIONES.md`, `CHANGELOG.md`, y las carpetas no-críticas `test/`, `media/`, `assets/` (con `nexo-logo.png`, `nexo-icon.png` y `favicon.ico`).
- No subas `node_modules/` ni ningún `.env`.

**2. Crea un Web Service NUEVO en Render (no toques el actual)**
- En el dashboard: **New → Web Service** → conecta el repo `nexo`.
- Build Command: `npm install` · Start Command: `npm start` · Plan Free.
- (Opcional) En vez de manual, usa **New → Blueprint** y apunta a este repo: `render.yaml` lo configura solo.

**3. Base de datos nueva en Neon**
- Crea una base **nueva** (separada de la del Asistente Puente) y pega su connection string en la variable `DATABASE_URL` del servicio nuevo.
- Sin `DATABASE_URL` el servicio igual arranca, pero los datos no sobreviven reinicios.

**4. Token de Facebook**
- Ve a [Graph API Explorer](https://developers.facebook.com/tools/explorer/) con tu cuenta.
- Elige tu app, pide permisos `user_posts` y `user_photos`, genera el token y luego extiéndelo a larga duración (el Explorer tiene el botón).
- Pégalo en `FACEBOOK_USER_TOKEN` en Render. **Nunca lo pegues en código ni en chats.**
- **Renovación automática (v1.4.0):** el token vive 60 días. Si además configuras `FACEBOOK_APP_ID` y `FACEBOOK_APP_SECRET` (de tu app en Meta for Developers → Configuración → Información básica), NEXO verifica la vigencia al arrancar y cada 24 h, y **renueva el token solo** cuando vence dentro de 7 días (`FB_TOKEN_REFRESH_MARGIN_DAYS`). El token renovado se guarda en la base de datos y las extracciones usan siempre el vigente. Consulta el estado en `GET /api/facebook/token` (no expone el valor) o fuerza una renovación con `POST /api/facebook/token/refresh`. Sin esas dos variables, la renovación sigue siendo manual como antes.

**5. Instagram (solo si tu cuenta es de empresa/creador)**
- La API oficial exige cuenta **empresa o creador** vinculada a una página de Facebook. Si `@msusffalich` es personal, conviértela primero (Instagram → Configuración → Tipo de cuenta).
- Obtén el ID numérico: en Graph API Explorer, `GET /me/accounts?fields=instagram_business_account`.
- Pégalo en `INSTAGRAM_USER_ID`. Sin esto, la fuente Instagram queda inactiva (Facebook sigue funcionando).

**6. Variables opcionales**
- `OPENAI_API_KEY` — mejora los resúmenes con IA; sin ella usa heurísticas locales gratuitas.
- `TYPESAFE_API_KEY` (o `JEV_API_KEY`) — activa las **decisiones JEV** (ver sección abajo). Opcionales: `JEV_MODEL` (default `jev-latest`), `JEV_BASE_URL` (default `https://api.typesafe.ai`).
- `LEGADO_VIVO_URL`, `BRIDGE_API_KEY`, `LEGADO_FAMILY_ID` — para enviar paquetes a Legado Vivo (puedes reusar los mismos valores del puente actual).
- `DRY_RUN=true` — modo prueba sin llamadas reales.

**7. Qué probar**
- Abre `https://tu-servicio.onrender.com/` → debe decir `"servicio": "nexo"`.
- `POST /api/command` con `{"text": "tráeme mis fotos de facebook de esta semana"}` → crea el trabajo y devuelve `stats`.
- `GET /api/packages` → lista los paquetes extraídos.
- Desde el chat con Muse: `node cli.js extraer "tráeme mis fotos de instagram de marzo"`.

## JEV — decisiones con IA (TypeSafe AI)

NEXO integra **JEV** (`jev-latest`) como cerebro de decisiones rápidas. Importante:

- **JEV no genera texto.** No escribe resúmenes ni etiquetas; eso lo siguen haciendo las heurísticas locales y OpenAI. JEV solo toma **decisiones tipadas** sobre cada paquete:
  - `choice` → categoría temática (familia, viaje, comida…) **con confianza**. Si la confianza es ≥ 0.75, reemplaza la categoría heurística.
  - `score` → puntaje de relevancia del contenido (0–100).
  - `noul` → puertas binarias: **¿duplicado probable?** y **¿entrega segura automática?**
- **Confianza baja → revisión humana, no automatización.** Si la categoría es insegura (< 0.6), hay posible duplicado (> 0.6) o la entrega no es segura (< 0.5), el paquete queda marcado en `metadata.revision_humana` con el motivo.
- **JEV nunca bloquea la extracción.** Sin key, o si el servicio falla (401/422/429/529, timeout), el paquete conserva sus heurísticas locales y sigue su curso normal.
- Los resultados viven en `metadata.jev` de cada paquete (proveedor, modelo, categoría, confianza, relevancia, probabilidades).

**Activarlo:** crea tu API key en [console.typesafe.ai](https://console.typesafe.ai) (o vía el gateway [defapi.org](https://defapi.org)) y pégala en Render como `TYPESAFE_API_KEY` (acepta `JEV_API_KEY` como alias). **Nunca la pegues en código ni en chats.** Sin esta key, NEXO funciona igual con heurísticas.

## Webhook de WhatsApp multi-mensaje (v1.3.0)

**Opt-in:** sin `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `VERIFY_TOKEN` y `APP_SECRET`, el webhook existe pero rechaza los eventos (401/403) y NEXO funciona igual que antes. Se configura con una **app de Meta aparte** de la del Asistente Puente (no se cambia la Callback URL del puente actual).

### Loteo (batching)

- Los mensajes consecutivos **del mismo remitente** se agrupan en un lote si llegan dentro de los **3 minutos** siguientes al anterior (`WA_BATCH_MAX_MS`, default 180000).
- El lote se cierra cuando hay una **pausa de 30 s** sin mensajes (`WA_BATCH_PAUSE_MS`, default 30000) o al llegar al **tope de 3 min** desde su inicio.
- Un texto que es comando (`ayuda`, `estado`, `extrae…`, `agrégala al álbum`) **cierra primero el lote abierto** y se atiende de inmediato. Un texto solo, sin lote abierto, también se atiende de inmediato.
- Idempotencia: si Meta reintenta un evento, el `message_id` duplicado se ignora.

### Triggers del lote

| Lote | Trigger | Qué hace |
|---|---|---|
| 1 foto (+ relato/caption) | `photo_relatos` | Álbum de 1 foto para Momentos |
| 2 fotos + texto | `album_caption` | Álbum de 2 fotos con caption |
| 2 fotos sin texto | `album_no_caption` | Álbum de 2 fotos |
| 3+ fotos (+ texto) | `multi_photo_album` | Álbum con **título de rango de fechas**; la respuesta indica N fotos + rango |
| 1 audio solo | `audio_note` | Nota de voz → transcripción separada |
| 2+ audios | `multi_audio_notes` | Una nota separada por audio, etiquetas `audio_1…N` (y `photo_1…M` si hay fotos) |
| Solo texto | `text_only` | Comando NEXO (`ayuda`, `estado`, `extrae…`) o regla del caption tardío |
| `agrégala al álbum` | `album_add_text` | Anexa el texto pendiente al último álbum |

### Reglas fijas de audio y captions

- El **audio siempre va a transcripciones/notas separadas**, nunca al flujo del álbum (con `OPENAI_API_KEY` se transcribe con Whisper; sin ella la nota queda pendiente de transcripción).
- Un **lote mixto** (fotos + audios) se procesa **por separado**: las fotos siguen el flujo de álbum y los audios el de notas.
- Un **caption que llega después** de creado el álbum **no se anexa solo**: se acusa recibo (`Anotado: "…"`) y se pide el comando explícito. Al decir **"agrégala al álbum"**, se anexa ese texto pendiente al último álbum.

### Álbumes preparados → Momentos

Cada lote cerrado guarda un registro consultable:

- `GET /api/whatsapp/albums` — lista (filtros `?wa_id`, `?limit`)
- `GET /api/whatsapp/albums/:id` — el álbum: `trigger`, `title` (rango de fechas), `items` (solo fotos, `photo_1…N`), `audio_notes` (transcripciones, `audio_1…N`), `texts`, `theme` (uno de los 5 temas de Momentos)
- `GET /api/whatsapp/albums/:id/import` — payload listo para importar desde el chat con Muse (`createalbum` → `uploadmedia` por foto → `addtextitem` por nota/texto)
- `GET /api/whatsapp/media/:albumId/:file` — bytes de cada medio
- `POST /api/whatsapp/albums/:id/import` — intenta la entrega (hoy devuelve `pendiente_importacion` con el payload, porque Momentos no expone API HTTP pública; el día que la tenga se usa `MOMENTOS_BRIDGE_URL`)

El título del álbum usa la zona horaria **America/Lima**: `Fotos del 24 de septiembre de 2026`, o `Fotos del 20 al 24 de septiembre de 2026` si hay rango.

### Variables nuevas (v1.3.0)

| Variable | Para qué |
|---|---|
| `WHATSAPP_TOKEN` | Token del número (system user en business.facebook.com) |
| `PHONE_NUMBER_ID` | ID del número de WhatsApp |
| `VERIFY_TOKEN` | Token de verificación (lo inventas tú; debe coincidir con Meta) |
| `APP_SECRET` | App secret de la app de Meta (valida la firma de los eventos) |
| `WA_BATCH_PAUSE_MS` | Pausa que cierra el lote (default 30000) |
| `WA_BATCH_MAX_MS` | Tope duro del lote (default 180000 = 3 min) |
| `MOMENTOS_AUTHOR` | Autor de los álbumes (default `Miguel Susffalich`) |
| `MOMENTOS_BRIDGE_URL` | (futuro) puente HTTP de Momentos, si algún día existe |

## API

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/` | Estado del servicio |
| GET | `/privacidad` | Política de privacidad (página pública requerida por Meta) |
| GET | `/api/ayuda` | Ejemplos de comandos |
| POST | `/api/command` `{text}` | Comando en lenguaje natural |
| POST | `/api/jobs` `{source,kind,from,to,target_apps}` | Trabajo directo |
| GET | `/api/jobs` · `/api/jobs/:id` | Ver trabajos |
| GET | `/api/packages` · `/api/packages/:id` | Ver paquetes |
| POST | `/api/packages/:id/deliver` `{app:"legado-vivo"}` | Enviar a Legado Vivo |
| POST | `/api/import/whatsapp-export` `{text,chatName}` | Fase 2: importar exportación de WhatsApp |
| GET | `/webhook` | Verificación del webhook de WhatsApp (Meta) |
| POST | `/webhook` | Eventos de WhatsApp (requiere firma `X-Hub-Signature-256`) |
| GET | `/api/whatsapp/albums` | Álbumes/notas preparados (`?wa_id`, `?limit`) |
| GET | `/api/whatsapp/albums/:id` | Un álbum preparado |
| GET | `/api/whatsapp/albums/:id/import` | Payload de importación a Momentos |
| POST | `/api/whatsapp/albums/:id/import` | Intentar entrega a Momentos |
| GET | `/api/whatsapp/media/:albumId/:file` | Bytes de un medio del álbum |

## Adaptadores por app consumidora

- **Legado Vivo** — `POST /api/packages/:id/deliver` envía el paquete como borrador a `POST {LEGADO_VIVO_URL}/api/bridge/drafts` (mismo contrato del puente actual, `draftId: nexo-<package_id>`).
- **Momentos / Prisma Editorial** — por ahora vía el chat con Muse: pide los paquetes (`cli.js paquetes` o `GET /api/packages`) y aliméntalos a la app que corresponda.

## Fase 2 (no incluida en este despliegue)

- Importación del historial de chats personales de WhatsApp vía archivo de exportación (el parser `whatsapp-export.js` ya está incluido y probado; el endpoint `/api/import/whatsapp-export` lo procesa).
- Extracciones programadas automáticas (cron externo que llame a `/api/command`).

## Límites honestos

- **WhatsApp no tiene API oficial para leer tus chats personales.** Por eso la fase 1 no los extrae; la vía es la exportación manual del chat.
- **Facebook/Instagram: solo tus propias cuentas** y lo que la API oficial permite. Instagram exige cuenta empresa/creador.
- La IA con heurísticas locales clasifica bien temas comunes; los resúmenes mejoran con `OPENAI_API_KEY`.
- Los medios se referencian por URL; la descarga local ocurre solo al entregar a Legado Vivo.

## Pruebas

- `npm test` → 26 pruebas (unitarias + E2E en DRY_RUN con APIs simuladas). Sin credenciales reales.
- `node test-all.js` → 36 pruebas: las 26 anteriores no se repiten aquí; son **unitarias del webhook** (triggers, títulos con rango de fechas, comandos, firma, temas de Momentos) + **E2E del loteo multi-mensaje** con `fastify.inject` (caso 3 fotos + 2 audios + texto, caption tardío, comando explícito, remitentes separados, duplicados, tope de 3 min, rango de fechas).
- `TARGET=prod node test-all.js` → verificación de solo lectura contra producción (versión, rutas). Con `WA_E2E=1` y `WA_TEST_APP_SECRET` corre además el E2E firmado contra prod (requiere v1.3.0 desplegado; crea un álbum de prueba).

## Versiones

- **v1.3.0** — Webhook de WhatsApp multi-mensaje (opt-in): `GET/POST /webhook`, loteo por remitente (pausa 30 s / tope 3 min), triggers `photo_relatos`, `album_caption`, `album_no_caption`, `multi_photo_album`, `audio_note`, `multi_audio_notes`, `text_only`, `album_add_text`; audios siempre a transcripciones separadas (Whisper si hay `OPENAI_API_KEY`); caption tardío no se anexa solo (comando explícito `agrégala al álbum`); álbumes preparados para Momentos (`/api/whatsapp/albums…`, título con rango de fechas en America/Lima, payload de importación `createalbum`/`uploadmedia`/`addtextitem`); `test-all.js` con E2E local y chequeo de producción.
- **v1.1.2** — Nueva ruta pública `GET /privacidad` con la política de privacidad (página exigida por Meta para habilitar el inicio de sesión en la app NEXO de Facebook). Sin otros cambios funcionales.
- **v1.1.1** — Todo el código runtime plano en la raíz (`source-facebook.js`, `source-instagram.js`, `adapter-legado.js`; se eliminaron las carpetas `sources/` y `adapters/`). Motivo: las subcarpetas no sobreviven el upload web de GitHub y tumbaban el deploy en Render (`Cannot find module './sources/facebook'`).
- **v1.1.0** — Integración JEV (TypeSafe AI) como motor de decisiones.

---

## English summary

**NEXO** is a content-extraction hub: it pulls photos, posts and videos from your own **Facebook** and **Instagram** accounts via Meta's official Graph API, normalizes each item into a standard **package** (`package_id, source, author, created_at, text, media[], metadata`), enriches it with AI (topic classification, summary, tags, deduplication), and makes it available to your other apps (Momentos, Prisma Editorial, Legado Vivo) via chat, REST API, or direct delivery to Legado Vivo drafts.

It does **not** touch the production Asistente Puente (separate repo, separate Render service, Meta webhook unchanged). WhatsApp personal chat history is **phase 2** (manual chat export; parser included). With `TYPESAFE_API_KEY` set, **JEV (TypeSafe AI)** adds fast typed decisions per package (category with confidence, relevance score, duplicate/safe-delivery gates) — it does not generate text; low confidence flags the package for human review instead of automating. Setup: create a new GitHub repo, upload the flat files, create a **new** Render web service, set env vars (`DATABASE_URL`, `FACEBOOK_USER_TOKEN`, optional `INSTAGRAM_USER_ID`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY`, `LEGADO_*`), then test with `GET /` and `POST /api/command`. `npm test` runs 26 offline tests; `node test-all.js` runs 36 tests including the v1.3.0 WhatsApp multi-message webhook E2E.

**v1.3.0 (WhatsApp multi-message webhook, opt-in):** with `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `VERIFY_TOKEN` and `APP_SECRET` set (on a Meta app separate from the Puente's), `POST /webhook` groups consecutive messages from the same sender into batches (30 s pause or 3 min cap flush). Batch triggers: `photo_relatos` (1 photo), `album_caption` / `album_no_caption` (2 photos), `multi_photo_album` (3+ photos, date-range title, reply states photo count + range), `audio_note` / `multi_audio_notes` (audios always become separate transcriptions, never album items; labeled `audio_1…N`), `text_only`, `album_add_text` (explicit "agrégala al álbum" command — a late caption is acknowledged, never auto-appended). Prepared albums are exposed at `/api/whatsapp/albums…` with an import payload for Momentos (`createalbum` → `uploadmedia` → `addtextitem`).
