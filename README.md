# NEXO

![NEXO — Asistente Puente](assets/nexo-logo.png)

**Hub de extracción de contenidos** — evolución del Asistente Puente. Extrae fotos, posts y videos de tus cuentas de **Facebook** e **Instagram**, los normaliza en paquetes estándar y los deja listos para tus otras apps (Momentos, Prisma Editorial, Legado Vivo).

> ⚠️ **El Asistente Puente actual NO se toca.** Sigue en producción con su repo, su servicio Render y su webhook de Meta intactos. NEXO es un servicio **nuevo y separado**.

---

## Cómo funciona

1. **Extrae** — Lee tu contenido propio vía Graph API oficial de Meta (Facebook e Instagram).
2. **Normaliza** — Convierte cada post/foto en un **paquete estándar**: `{package_id, source, author, created_at, text, media[], metadata}`.
3. **Enriquece con IA** — Clasifica por tema (familia, viaje, comida…), resume, etiqueta y **deduplica** (nunca guarda dos veces lo mismo). Con la key configurada, **JEV (TypeSafe AI)** agrega decisiones rápidas: categoría con confianza, puntaje de relevancia y puertas binarias (¿duplicado? ¿entrega segura?).
4. **Entrega** — Guarda los paquetes para que los uses desde el chat con Muse, por API, o los envía a Legado Vivo como borrador.

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
  `package.json`, `index.js`, `config.js`, `store.js`, `intent.js`, `jobs.js`, `normalize.js`, `ai.js`, `jev.js`, `cli.js`, `whatsapp-export.js`, `source-facebook.js`, `source-instagram.js`, `adapter-legado.js`, `render.yaml`, `.env.example`, `.gitignore`, `README.md`, y las carpetas no-críticas `test/`, `media/`, `assets/` (con `nexo-logo.png`, `nexo-icon.png` y `favicon.ico`).
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

## API

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/` | Estado del servicio |
| GET | `/api/ayuda` | Ejemplos de comandos |
| POST | `/api/command` `{text}` | Comando en lenguaje natural |
| POST | `/api/jobs` `{source,kind,from,to,target_apps}` | Trabajo directo |
| GET | `/api/jobs` · `/api/jobs/:id` | Ver trabajos |
| GET | `/api/packages` · `/api/packages/:id` | Ver paquetes |
| POST | `/api/packages/:id/deliver` `{app:"legado-vivo"}` | Enviar a Legado Vivo |
| POST | `/api/import/whatsapp-export` `{text,chatName}` | Fase 2: importar exportación de WhatsApp |

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

`npm test` → 26 pruebas (unitarias + E2E en DRY_RUN con APIs simuladas). Sin credenciales reales.

## Versiones

- **v1.1.1** — Todo el código runtime plano en la raíz (`source-facebook.js`, `source-instagram.js`, `adapter-legado.js`; se eliminaron las carpetas `sources/` y `adapters/`). Motivo: las subcarpetas no sobreviven el upload web de GitHub y tumbaban el deploy en Render (`Cannot find module './sources/facebook'`).
- **v1.1.0** — Integración JEV (TypeSafe AI) como motor de decisiones.

---

## English summary

**NEXO** is a content-extraction hub: it pulls photos, posts and videos from your own **Facebook** and **Instagram** accounts via Meta's official Graph API, normalizes each item into a standard **package** (`package_id, source, author, created_at, text, media[], metadata`), enriches it with AI (topic classification, summary, tags, deduplication), and makes it available to your other apps (Momentos, Prisma Editorial, Legado Vivo) via chat, REST API, or direct delivery to Legado Vivo drafts.

It does **not** touch the production Asistente Puente (separate repo, separate Render service, Meta webhook unchanged). WhatsApp personal chat history is **phase 2** (manual chat export; parser included). With `TYPESAFE_API_KEY` set, **JEV (TypeSafe AI)** adds fast typed decisions per package (category with confidence, relevance score, duplicate/safe-delivery gates) — it does not generate text; low confidence flags the package for human review instead of automating. Setup: create a new GitHub repo, upload the flat files, create a **new** Render web service, set env vars (`DATABASE_URL`, `FACEBOOK_USER_TOKEN`, optional `INSTAGRAM_USER_ID`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY`, `LEGADO_*`), then test with `GET /` and `POST /api/command`. `npm test` runs 26 offline tests.
