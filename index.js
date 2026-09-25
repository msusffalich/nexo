'use strict';

/**
 * NEXO — servidor.
 *
 * Hub de extracción de contenidos (Facebook, Instagram, WhatsApp-fase2).
 * NO toca el Asistente Puente en producción: vive en su propio servicio de
 * Render con su propio repo. Desde v1.3.0 puede recibir webhooks de Meta de
 * forma OPCIONAL (WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, APP_SECRET)
 * en /webhook, sin cambiar la Callback URL del app Meta del puente actual:
 * se configura un webhook aparte (otra app de Meta u otro número).
 *
 * Rutas:
 *   GET  /                              estado del servicio
 *   POST /api/command {text}            comando en lenguaje natural -> trabajo
 *   POST /api/jobs {source,kind,from,to,target_apps}   trabajo directo
 *   GET  /api/jobs                      últimos trabajos
 *   GET  /api/jobs/:id                  detalle de un trabajo
 *   GET  /api/packages                  paquetes (filtros: source, status, limit)
 *   GET  /api/packages/:id              un paquete
 *   POST /api/packages/:id/deliver {app}  entregar a app consumidora
 *   POST /api/import/whatsapp-export {text, chatName}  (FASE 2)
 *   GET  /api/ayuda                     ejemplos de comandos
 *   GET  /privacidad                    política de privacidad (requerida por Meta)
 *   --- v1.3.0: webhook de WhatsApp multi-mensaje (opt-in) ---
 *   GET  /webhook                       verificación de Meta
 *   POST /webhook                       eventos de WhatsApp (firma X-Hub-Signature-256)
 *   GET  /api/whatsapp/albums           álbumes/notas preparados (?wa_id, ?limit)
 *   GET  /api/whatsapp/albums/:id       un álbum preparado
 *   GET  /api/whatsapp/albums/:id/import  payload de importación a Momentos
 *   POST /api/whatsapp/albums/:id/import  intentar entrega a Momentos
 *   GET  /api/whatsapp/media/:albumId/:file  bytes de un medio del álbum
 *   --- v1.4.0: renovación automática del token de Facebook ---
 *   GET  /api/facebook/token            estado del token (válido, días restantes)
 *   POST /api/facebook/token/refresh    forzar renovación ahora
 */

const fastify = require('fastify')({ logger: true });
const fs = require('node:fs');
const path = require('node:path');
const { cfg, fuentesActivas, webhookEnabled } = require('./config');
const store = require('./store');
const { parseCommand } = require('./intent');
const jobs = require('./jobs');
const { toPackage } = require('./normalize');
const ai = require('./ai');
const legado = require('./adapter-legado');
const momentos = require('./adapter-momentos');
const wh = require('./whatsapp-webhook');
const { parseExport } = require('./whatsapp-export');
const tokenRefresh = require('./token-refresh');

const VERSION = '1.4.0';

// Instancia perezosa del webhook (usa la config del entorno al primer uso).
let _webhook = null;
function getWebhook() {
  if (!_webhook) {
    _webhook = wh.createWebhook({
      cfg: cfg(),
      store,
      momentos,
      intent: require('./intent'),
      jobs,
      logger: fastify.log,
    });
  }
  return _webhook;
}

// Parser JSON que conserva el cuerpo crudo para validar la firma de Meta.
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  req.rawBody = body || '';
  try {
    done(null, body ? JSON.parse(body) : {});
  } catch (err) {
    done(err);
  }
});

const PRIVACIDAD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de privacidad — NEXO</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}h1{font-size:1.6em}</style>
</head>
<body>
<h1>Política de privacidad — NEXO</h1>
<p><strong>Última actualización:</strong> 23 de septiembre de 2026.</p>
<p><strong>NEXO</strong> es un hub personal de extracción de contenidos. Su único usuario es su propio titular: extrae fotos, publicaciones y videos de <strong>sus propias cuentas</strong> de Facebook e Instagram (mediante tokens de acceso que él mismo genera y autoriza en Meta) y de exportaciones de chats de WhatsApp que él mismo sube manualmente.</p>
<h2>Datos que se manejan</h2>
<ul>
<li>Contenido de las cuentas propias de Facebook e Instagram (texto, fotos, videos, fechas) obtenido exclusivamente vía la API oficial de Meta con autorización del titular.</li>
<li>Archivos de exportación de WhatsApp subidos manualmente por el titular.</li>
</ul>
<h2>Finalidad</h2>
<p>Normalizar ese contenido en paquetes estándar y entregarlo a las aplicaciones personales del titular (Momentos, Prisma Editorial, Legado Vivo). No existe ningún otro uso.</p>
<h2>Almacenamiento y compartición</h2>
<p>Los datos se almacenan en la base de datos privada del titular (PostgreSQL) dentro de su propio servicio en la nube. <strong>No se comparten, venden ni ceden datos a terceros.</strong> No hay analítica ni rastreo de terceros.</p>
<h2>Eliminación</h2>
<p>El titular puede eliminar sus datos en cualquier momento escribiendo a <a href="mailto:msusffalich@hotmail.com">msusffalich@hotmail.com</a>.</p>
<h2>Contacto</h2>
<p>Miguel Susffalich Tomasevich — <a href="mailto:msusffalich@hotmail.com">msusffalich@hotmail.com</a></p>
</body>
</html>`;

fastify.get('/privacidad', async (req, reply) => {
  reply.type('text/html; charset=utf-8').send(PRIVACIDAD_HTML);
});

fastify.get('/', async () => {
  const c = cfg();
  return {
    nombre: 'NEXO',
    servicio: 'nexo',
    version: VERSION,
    almacen: store.backend(),
    dry_run: c.dryRun,
    fuentes_configuradas: fuentesActivas(c),
    ia: ['heuristica-local'].concat(c.openaiKey ? ['openai'] : [], c.jev.key ? ['jev-decisiones'] : []).join('+'),
    adaptador_legado_vivo: legado.bridgeEnabled(c),
    webhook_whatsapp: webhookEnabled(c)
      ? 'activo (loteo multi-mensaje)'
      : 'inactivo (configura WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN y APP_SECRET)',
    nota: 'No modifica el Asistente Puente en producción.',
  };
});

fastify.get('/api/ayuda', async () => ({
  ejemplos: [
    'tráeme mis fotos de instagram de marzo',
    'extrae mis posts de facebook del 1 al 15 de enero de 2026',
    'jala mis videos de instagram de esta semana',
    'busca mis fotos de facebook de los últimos 60 días',
    'cómo van mis extracciones',
  ],
  nota_whatsapp: 'El historial de chats personales de WhatsApp llega en fase 2 (exportación manual del chat). Por el webhook /webhook (v1.3.0) sí puedes mandarle fotos y audios: los agrupa en álbumes para Momentos.',
}));

fastify.post('/api/command', async (req, reply) => {
  const { text } = req.body || {};
  if (!text) return reply.code(400).send({ ok: false, error: 'falta text' });
  const parsed = parseCommand(text);

  if (parsed.intent === 'ayuda') {
    return { ok: true, intent: 'ayuda', ejemplos: (await fastify.inject({ method: 'GET', url: '/api/ayuda' })).json().ejemplos };
  }
  if (parsed.intent === 'estado') {
    return { ok: true, intent: 'estado', trabajos: await store.listJobs(10) };
  }
  if (parsed.intent === 'extraer') {
    if (parsed.error === 'fuente_no_detectada') {
      return reply.code(400).send({ ok: false, error: 'no detecté la fuente (¿facebook o instagram?)', interpretacion: parsed });
    }
    if (parsed.error === 'whatsapp_fase_2') {
      return reply.code(400).send({
        ok: false,
        error: 'whatsapp_fase_2',
        detalle: 'El historial de WhatsApp aún no se extrae solo: exporta el chat desde tu teléfono y usa /api/import/whatsapp-export (fase 2).',
      });
    }
    const c = cfg();
    const fuentes = fuentesActivas(c);
    if (!fuentes.includes(parsed.source)) {
      return reply.code(400).send({ ok: false, error: `fuente no configurada: ${parsed.source}`, configuradas: fuentes });
    }
    const { job_id, stats } = await jobs.extraer(
      { source: parsed.source, kind: parsed.kind, from: parsed.from, to: parsed.to, target_apps: [] },
      c
    );
    return { ok: true, job_id, interpretacion: parsed, stats };
  }
  return reply.code(400).send({ ok: false, error: 'no entendí el comando', interpretacion: parsed });
});

fastify.post('/api/jobs', async (req, reply) => {
  const { source, kind, from, to, target_apps } = req.body || {};
  if (!source || !from || !to) {
    return reply.code(400).send({ ok: false, error: 'se requiere source, from (YYYY-MM-DD) y to (YYYY-MM-DD)' });
  }
  const c = cfg();
  if (!fuentesActivas(c).includes(source)) {
    return reply.code(400).send({ ok: false, error: `fuente no configurada: ${source}` });
  }
  const { job_id, stats } = await jobs.extraer({ source, kind: kind || 'todo', from, to, target_apps: target_apps || [] }, c);
  return { ok: true, job_id, stats };
});

fastify.get('/api/jobs', async (req) => ({ trabajos: await store.listJobs(parseInt(req.query.limit || '20', 10)) }));

fastify.get('/api/jobs/:id', async (req, reply) => {
  const j = await store.getJob(req.params.id);
  if (!j) return reply.code(404).send({ ok: false, error: 'trabajo no existe' });
  return j;
});

fastify.get('/api/packages', async (req) => ({
  paquetes: await store.listPackages({
    source: req.query.source,
    status: req.query.status,
    limit: parseInt(req.query.limit || '50', 10),
  }),
}));

fastify.get('/api/packages/:id', async (req, reply) => {
  const p = await store.getPackage(req.params.id);
  if (!p) return reply.code(404).send({ ok: false, error: 'paquete no existe' });
  return p;
});

fastify.post('/api/packages/:id/deliver', async (req, reply) => {
  const p = await store.getPackage(req.params.id);
  if (!p) return reply.code(404).send({ ok: false, error: 'paquete no existe' });
  const app = (req.body && req.body.app) || 'legado-vivo';
  if (app !== 'legado-vivo') return reply.code(400).send({ ok: false, error: `adaptador no soportado: ${app}` });
  const r = await legado.deliver(p, cfg());
  if (r.ok) await store.setPackageStatus(p.package_id, 'entregado_legado');
  return r;
});

// ---- v1.3.0: webhook de WhatsApp multi-mensaje (opt-in) ----

// Verificación del webhook (la usa Meta al configurarlo)
fastify.get('/webhook', async (req, reply) => {
  const r = getWebhook().handleVerify(req.query || {});
  return reply.code(r.status).send(r.body);
});

// Recepción de eventos: 200 inmediato, procesamiento en segundo plano
// (igual que el Asistente Puente, para evitar reintentos de Meta).
fastify.post('/webhook', async (req, reply) => {
  const c = cfg();
  if (!wh.signatureValid(req.rawBody, req.headers['x-hub-signature-256'], c.appSecret)) {
    fastify.log.warn('Firma X-Hub-Signature-256 inválida en /webhook.');
    return reply.code(401).send({ error: 'Firma inválida' });
  }
  reply.code(200).send({ ok: true });
  getWebhook().ingestPayload(req.body).catch((err) => fastify.log.error(err, 'Error procesando webhook WhatsApp'));
});

// Álbumes y notas preparados por el webhook (para importar a Momentos)
fastify.get('/api/whatsapp/albums', async (req) => ({
  albums: await store.listWaAlbums({
    waId: req.query.wa_id || undefined,
    limit: parseInt(req.query.limit || '20', 10),
  }),
}));

fastify.get('/api/whatsapp/albums/:id', async (req, reply) => {
  const a = await store.getWaAlbum(req.params.id);
  if (!a) return reply.code(404).send({ ok: false, error: 'álbum no existe' });
  return a;
});

// Payload listo para importar a Momentos desde el chat con Muse
// (acciones createalbum / uploadmedia / addtextitem).
fastify.get('/api/whatsapp/albums/:id/import', async (req, reply) => {
  const a = await store.getWaAlbum(req.params.id);
  if (!a) return reply.code(404).send({ ok: false, error: 'álbum no existe' });
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return momentos.importPayload(a, `${proto}://${req.headers.host}`);
});

fastify.post('/api/whatsapp/albums/:id/import', async (req, reply) => {
  const a = await store.getWaAlbum(req.params.id);
  if (!a) return reply.code(404).send({ ok: false, error: 'álbum no existe' });
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const r = await momentos.deliver(a, cfg(), { baseUrl: `${proto}://${req.headers.host}` });
  if (r.ok) {
    a.import_status = 'entregado';
    await store.saveWaAlbum(a);
  }
  return r;
});

// Bytes de un medio del álbum (para la importación asistida a Momentos).
fastify.get('/api/whatsapp/media/:albumId/:file', async (req, reply) => {
  const albumId = String(req.params.albumId || '').replace(/[^a-zA-Z0-9_]/g, '');
  const file = path.basename(String(req.params.file || ''));
  if (!albumId || !/^(photo|audio|text)_\d+\.[a-z0-9]+$/i.test(file)) {
    return reply.code(400).send({ ok: false, error: 'archivo inválido' });
  }
  const full = path.join(__dirname, 'media', 'wa', albumId, file);
  if (!fs.existsSync(full)) return reply.code(404).send({ ok: false, error: 'no encontrado' });
  const mime = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  }[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return reply.type(mime).send(fs.readFileSync(full));
});

// ---- v1.4.0: estado y renovación del token de Facebook ----
// Nunca exponen el valor del token: solo estado (válido, días restantes).

fastify.get('/api/facebook/token', async () => {
  const st = await tokenRefresh.ensureFreshToken({ store, cfg: cfg(), logger: fastify.log });
  return { ok: st.ok, estado: st };
});

fastify.post('/api/facebook/token/refresh', async () => {
  // Fuerza la renovación aunque falte mucho para el vencimiento.
  const st = await tokenRefresh.ensureFreshToken({ store, cfg: cfg(), logger: fastify.log, marginDays: 36500 });
  return { ok: st.ok && st.refreshed, estado: st };
});

// FASE 2: importación de exportación manual de WhatsApp
fastify.post('/api/import/whatsapp-export', async (req, reply) => {
  const { text, chatName } = req.body || {};
  if (!text) return reply.code(400).send({ ok: false, error: 'falta text (contenido del .txt exportado)' });
  const c = cfg();
  const items = parseExport(text, { chatName: chatName || 'chat' });
  let nuevos = 0;
  for (const raw of items) {
    const pkg = toPackage(raw, null, null);
    if (await store.seenDedupeKey(pkg.metadata.dedupe_key)) continue;
    await ai.enrich(pkg, c.openaiKey, undefined, { jev: c.jev });
    pkg.target_apps = ['legado-vivo', 'momentos'];
    await store.savePackage(pkg);
    nuevos += 1;
  }
  return { ok: true, mensajes: items.length, nuevos, nota: 'fase 2: importación manual' };
});

async function start() {
  await store.init();
  const c = cfg();
  // v1.4.0: chequeo inicial del token de Facebook (lo renueva si está
  // dentro del margen) y re-chequeo diario. Nunca detiene el arranque.
  try {
    const st = await tokenRefresh.ensureFreshToken({ store, cfg: c, logger: fastify.log });
    fastify.log.info({ facebook_token: st }, 'chequeo inicial del token de Facebook');
  } catch (e) {
    fastify.log.warn(e, 'chequeo inicial del token falló; se sigue con el token del entorno');
  }
  const iv = setInterval(() => {
    tokenRefresh.ensureFreshToken({ store, cfg: cfg(), logger: fastify.log })
      .catch((e) => fastify.log.warn(e, 'renovación programada del token de Facebook falló'));
  }, 24 * 3600 * 1000);
  if (iv.unref) iv.unref();
  await fastify.listen({ port: c.port, host: '0.0.0.0' });
  fastify.log.info(`nexo v${VERSION} en puerto ${c.port} (almacen: ${store.backend()}, dry_run: ${c.dryRun})`);
}

if (require.main === module) {
  start().catch((e) => { fastify.log.error(e); process.exit(1); });
}

module.exports = { fastify, start, getWebhook };
