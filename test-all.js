'use strict';

/**
 * NEXO — suite completa v1.5.0 (unitarias + E2E).
 *
 *   node test-all.js                -> todo en LOCAL (recomendado, sin red real)
 *   TARGET=prod node test-all.js    -> verificación contra producción
 *   WA_E2E=1 TARGET=prod WA_TEST_APP_SECRET=... node test-all.js
 *                                   -> además corre el E2E firmado contra prod
 *                                      (crea un álbum de prueba en el NEXO de
 *                                      producción; requiere v1.5.0 desplegado)
 *
 * En local: DRY_RUN=true, almacén JSON temporal, fastify.inject (sin puertos
 * ni red). No usa credenciales reales. Limpia data.json al terminar.
 */

// ---------- entorno ANTES de requerir el código ----------
delete process.env.DATABASE_URL; // forzar backend JSON
process.env.DRY_RUN = 'true';
process.env.APP_SECRET = 'test-app-secret';
process.env.VERIFY_TOKEN = 'test-verify-token';
process.env.WA_BATCH_PAUSE_MS = '150';  // loteo acelerado para pruebas
process.env.WA_BATCH_MAX_MS = '600';
process.env.MOMENTOS_AUTHOR = 'Autor de Prueba';
process.env.OPENAI_API_KEY = 'test-key'; // solo para la transcripción simulada en DRY_RUN

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const wh = require('./whatsapp-webhook');
const momentos = require('./adapter-momentos');

const REPO = __dirname;
const DATA_FILE = path.join(REPO, 'data.json');
const DATA_BACKUP = path.join('/tmp', `nexo-data-backup-${Date.now()}.json`);

let passed = 0;
let failed = 0;
function ok(name, fn) {
  const run = async () => {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  };
  return run().catch((e) => {
    failed += 1;
    console.error(`  ✗ ${name}: ${e.message}`);
    if (process.env.VERBOSE) console.error(e);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sign(body, secret) {
  return 'sha256=' + crypto.createHmac('sha256', secret || process.env.APP_SECRET).update(body, 'utf8').digest('hex');
}

// ---------- constructores de payloads WhatsApp (formato Meta) ----------

const SENDER = '15551234567';
function imgMsg(id, from, tsSec, mediaId, caption) {
  return { id, from, timestamp: String(tsSec), type: 'image', image: { id: mediaId, caption: caption || '' } };
}
function audioMsg(id, from, tsSec, mediaId) {
  return { id, from, timestamp: String(tsSec), type: 'audio', audio: { id: mediaId } };
}
function textMsg(id, from, tsSec, body) {
  return { id, from, timestamp: String(tsSec), type: 'text', text: { body } };
}
function waPayload(messages) {
  return { entry: [{ id: '1', changes: [{ value: { messages } }] }] };
}
// 24/09/2026 15:00 Lima ~= 20:00 UTC
const T0 = Math.floor(Date.UTC(2026, 8, 24, 20, 0, 0) / 1000);

// ============================ MODO LOCAL ============================

async function runLocal() {
  console.log('NEXO v1.5.0 — suite local (DRY_RUN, sin red)');
  try { fs.copyFileSync(DATA_FILE, DATA_BACKUP); } catch { /* sin datos previos */ }
  try { fs.unlinkSync(DATA_FILE); } catch { /* limpio */ }

  const { fastify, getWebhook } = require('./index');
  const store = require('./store');
  await store.init();
  const webhook = getWebhook();
  const outbound = [];
  webhook.__setTestSink((m) => outbound.push(m));
  const clearOutbound = () => { outbound.length = 0; };

  async function postWebhook(messages, secret) {
    const body = JSON.stringify(waPayload(messages));
    const res = await fastify.inject({
      method: 'POST',
      url: '/webhook',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sign(body, secret),
      },
    });
    return res;
  }

  console.log('\n[unit] classifyBatch — triggers');
  const I = (caption) => ({ id: 'x', type: 'image', at: 1, caption: caption || '', text: '' });
  const A = () => ({ id: 'x', type: 'audio', at: 1, caption: '', text: '' });
  const T = (text) => ({ id: 'x', type: 'text', at: 1, caption: '', text });
  await ok('1 foto -> photo_relatos', () => {
    assert.equal(wh.classifyBatch([I()]).trigger, 'photo_relatos');
  });
  await ok('1 foto + caption -> photo_relatos con caption', () => {
    const c = wh.classifyBatch([I('atardecer lindo')]);
    assert.equal(c.trigger, 'photo_relatos');
    assert.ok(c.captions.includes('atardecer lindo'));
  });
  await ok('2 fotos sin texto -> album_no_caption', () => {
    assert.equal(wh.classifyBatch([I(), I()]).trigger, 'album_no_caption');
  });
  await ok('2 fotos + texto -> album_caption', () => {
    assert.equal(wh.classifyBatch([I(), I(), T('paseo')]).trigger, 'album_caption');
  });
  await ok('3 fotos + texto -> multi_photo_album', () => {
    const c = wh.classifyBatch([I(), I(), I(), T('qué día')]);
    assert.equal(c.trigger, 'multi_photo_album');
    assert.equal(c.photoTrigger, 'multi_photo_album');
  });
  await ok('1 audio solo -> audio_note', () => {
    const c = wh.classifyBatch([A()]);
    assert.equal(c.trigger, 'audio_note');
    assert.equal(c.audioTrigger, 'audio_note');
  });
  await ok('2 audios -> multi_audio_notes', () => {
    assert.equal(wh.classifyBatch([A(), A()]).trigger, 'multi_audio_notes');
  });
  await ok('2 audios + 1 foto -> trigger photo_relatos + notas multi_audio_notes', () => {
    const c = wh.classifyBatch([A(), A(), I()]);
    assert.equal(c.trigger, 'photo_relatos');
    assert.equal(c.audioTrigger, 'multi_audio_notes');
    assert.equal(c.photoTrigger, 'photo_relatos');
  });
  await ok('3 fotos + 1 audio -> multi_photo_album + audio_note', () => {
    const c = wh.classifyBatch([I(), I(), I(), A()]);
    assert.equal(c.trigger, 'multi_photo_album');
    assert.equal(c.audioTrigger, 'audio_note');
  });
  await ok('solo textos -> text_only', () => {
    assert.equal(wh.classifyBatch([T('hola')]).trigger, 'text_only');
  });

  console.log('\n[unit] albumTitleFor — título con rango de fechas');
  await ok('un día -> "Fotos del 24 de septiembre de 2026"', () => {
    assert.equal(wh.albumTitleFor([T0 * 1000, (T0 + 3600) * 1000]), 'Fotos del 24 de septiembre de 2026');
  });
  await ok('rango mismo mes -> "Fotos del 20 al 24 de septiembre de 2026"', () => {
    const d1 = Date.UTC(2026, 8, 20, 20, 0, 0);
    const d2 = Date.UTC(2026, 8, 24, 20, 0, 0);
    assert.equal(wh.albumTitleFor([d1, d2]), 'Fotos del 20 al 24 de septiembre de 2026');
  });
  await ok('cruza de mes -> nombra ambos extremos', () => {
    const d1 = Date.UTC(2026, 7, 30, 20, 0, 0);
    const d2 = Date.UTC(2026, 8, 2, 20, 0, 0);
    assert.equal(wh.albumTitleFor([d1, d2]), 'Fotos del 30 de agosto al 2 de septiembre de 2026');
  });
  await ok('sin fechas -> genérico', () => {
    assert.equal(wh.albumTitleFor([]), 'Fotos de WhatsApp');
  });

  console.log('\n[unit] isAlbumAddCommand + signatureValid');
  await ok('detecta "agrégala al álbum" y variantes', () => {
    assert.ok(wh.isAlbumAddCommand('agrégala al álbum'));
    assert.ok(wh.isAlbumAddCommand('Agrega esto al album por favor'));
    assert.ok(wh.isAlbumAddCommand('añádela al álbum'));
    assert.ok(!wh.isAlbumAddCommand('qué lindo el álbum'));
    assert.ok(!wh.isAlbumAddCommand('hola'));
  });
  await ok('splitAlbumAddCommand separa comando y resto', () => {
    const s1 = wh.splitAlbumAddCommand('agrégala al álbum: fue un día hermoso');
    assert.ok(s1.isCommand);
    assert.equal(s1.remainder, 'fue un día hermoso');
    const s2 = wh.splitAlbumAddCommand('por favor agrégala al álbum');
    assert.ok(s2.isCommand);
    assert.equal(s2.remainder, '');
    const s3 = wh.splitAlbumAddCommand('hola, ¿cómo estás?');
    assert.ok(!s3.isCommand);
  });
  await ok('firma válida pasa, inválida/ausente no', () => {
    const body = '{"hola":1}';
    assert.ok(wh.signatureValid(body, sign(body), process.env.APP_SECRET));
    assert.ok(!wh.signatureValid(body, sign(body, 'otra'), process.env.APP_SECRET));
    assert.ok(!wh.signatureValid(body, null, process.env.APP_SECRET));
    assert.ok(!wh.signatureValid(body, sign(body), ''));
  });

  console.log('\n[unit] adapter-momentos');
  await ok('themeFor mapea a los 5 temas', () => {
    assert.equal(momentos.themeFor('fiesta de cumpleaños de mi hijo'), 'celebrations');
    assert.equal(momentos.themeFor('navidad en familia'), 'festivities');
    assert.equal(momentos.themeFor('viaje a la playa'), 'travel');
    assert.equal(momentos.themeFor('concierto anoche'), 'entertainment');
    assert.equal(momentos.themeFor('atardecer tranquilo'), 'memories');
  });
  await ok('importPayload arma pasos/media/textos', () => {
    const p = momentos.importPayload({
      album_id: 'wa_abc', title: 'Fotos del 24 de septiembre de 2026', author: 'X',
      theme: 'travel', language: 'es', date_from: '2026-09-24', caption: 'lindo día',
      trigger: 'multi_photo_album',
      items: [{ label: 'photo_1', caption: 'playa', taken_at: '2026-09-24T20:00:00.000Z', file: 'photo_1.jpg', mime: 'image/jpeg' }],
      audio_notes: [{ label: 'audio_1', transcription: 'hola mundo', taken_at: '2026-09-24T20:01:00.000Z' }],
      texts: [],
    }, 'https://srv.test');
    assert.equal(p.album.title, 'Fotos del 24 de septiembre de 2026');
    assert.equal(p.album.theme, 'travel');
    assert.equal(p.media.length, 1);
    assert.ok(p.media[0].fileUrl.includes('/api/whatsapp/media/wa_abc/photo_1.jpg'));
    assert.equal(p.textos.length, 1);
    assert.ok(p.textos[0].text.includes('hola mundo'));
  });
  await ok('deliver sin bridge -> pendiente_importacion', async () => {
    const r = await momentos.deliver({ album_id: 'x', title: 'T', items: [], audio_notes: [], texts: [] }, { momentosBridgeUrl: '' }, { baseUrl: 'https://s' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'pendiente_importacion');
    assert.ok(r.import.pasos.length === 3);
  });

  console.log('\n[e2e] verificación y firma del webhook');
  await ok('GET / responde versión 1.5.0', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/' });
    const j = r.json();
    assert.equal(j.version, '1.5.0');
    assert.ok(j.webhook_whatsapp.includes('inactivo')); // sin WHATSAPP_TOKEN en pruebas
  });
  await ok('GET /webhook verifica con token correcto', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CH' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body, 'CH');
  });
  await ok('GET /webhook rechaza token incorrecto', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/webhook?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=CH' });
    assert.equal(r.statusCode, 403);
  });
  await ok('POST /webhook sin firma -> 401', async () => {
    const r = await fastify.inject({ method: 'POST', url: '/webhook', payload: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(r.statusCode, 401);
  });
  await ok('POST /webhook con firma mala -> 401', async () => {
    const r = await postWebhook([textMsg('m0', SENDER, T0, 'hola')], 'secreto-malo');
    assert.equal(r.statusCode, 401);
  });

  console.log('\n[e2e] caso principal: 3 fotos + 2 audios + texto (un lote)');
  await ok('los 6 mensajes se aceptan (200)', async () => {
    clearOutbound();
    const msgs = [
      imgMsg('w1', SENDER, T0, 'media_1', ''),
      imgMsg('w2', SENDER, T0 + 5, 'media_2', ''),
      imgMsg('w3', SENDER, T0 + 10, 'media_3', ''),
      audioMsg('w4', SENDER, T0 + 15, 'media_4'),
      audioMsg('w5', SENDER, T0 + 20, 'media_5'),
      textMsg('w6', SENDER, T0 + 25, 'qué lindo día en la playa'),
    ];
    for (const m of msgs) {
      const r = await postWebhook([m]);
      assert.equal(r.statusCode, 200);
    }
  });
  let albumId;
  await ok('tras la pausa se crea 1 álbum multi_photo_album', async () => {
    await sleep(600); // > WA_BATCH_PAUSE_MS (150ms)
    const r = await fastify.inject({ method: 'GET', url: '/api/whatsapp/albums' });
    const albums = r.json().albums;
    assert.equal(albums.length, 1);
    const a = albums[0];
    albumId = a.album_id;
    assert.equal(a.trigger, 'multi_photo_album');
    assert.equal(a.photo_trigger, 'multi_photo_album');
    assert.equal(a.audio_trigger, 'multi_audio_notes');
    assert.equal(a.kind, 'album');
    assert.equal(a.counts.photos, 3);
    assert.equal(a.counts.audios, 2);
    assert.equal(a.title, 'Fotos del 24 de septiembre de 2026');
    assert.equal(a.theme, 'travel'); // "playa" en el caption
    assert.deepEqual(a.items.map((i) => i.label), ['photo_1', 'photo_2', 'photo_3']);
    assert.deepEqual(a.audio_notes.map((x) => x.label), ['audio_1', 'audio_2']);
    assert.ok(a.caption.includes('qué lindo día en la playa'));
    // audios: notas separadas con transcripción (simulada en DRY_RUN)
    assert.ok(a.audio_notes.every((x) => x.transcription && x.transcription.length > 0));
    // las fotos NO mezclan audios en items
    assert.ok(a.items.every((i) => i.kind === 'image'));
  });
  await ok('la respuesta trae N fotos + rango de fechas y las notas aparte', async () => {
    const texts = outbound.map((o) => o.text).join('\n');
    assert.ok(/3 fotos/.test(texts), 'menciona 3 fotos');
    assert.ok(texts.includes('24 de septiembre de 2026'), 'menciona el rango/fecha');
    assert.ok(texts.includes('audio_1') && texts.includes('audio_2'), 'etiquetas audio_N');
    assert.ok(/no dentro del álbum|notas separadas/.test(texts), 'audios fuera del flujo del álbum');
  });
  await ok('GET /api/whatsapp/albums/:id/import trae el payload', async () => {
    const r = await fastify.inject({ method: 'GET', url: `/api/whatsapp/albums/${albumId}/import` });
    assert.equal(r.statusCode, 200);
    const p = r.json();
    assert.equal(p.album.title, 'Fotos del 24 de septiembre de 2026');
    assert.equal(p.media.length, 3);
    assert.ok(p.textos.length >= 2);
    assert.equal(p.nexo_album_id, albumId);
  });

  console.log('\n[e2e] caption tardío NO se anexa solo; comando explícito sí');
  await ok('texto suelto tras el álbum -> acuse + pista del comando', async () => {
    clearOutbound();
    const r = await postWebhook([textMsg('w7', SENDER, T0 + 400, 'qué linda quedó la foto')]);
    assert.equal(r.statusCode, 200);
    await sleep(150);
    const texts = outbound.map((o) => o.text).join('\n');
    assert.ok(/Anotado/.test(texts), 'acusa recibo');
    assert.ok(/agrégala al álbum/.test(texts), 'pide el comando explícito');
    const a = (await fastify.inject({ method: 'GET', url: `/api/whatsapp/albums/${albumId}` })).json();
    // el álbum ya traía el texto w6 del lote (text_1); el w7 NO se anexó solo
    assert.equal((a.texts || []).length, 1);
    assert.ok(a.texts[0].text.includes('qué lindo día en la playa'));
    assert.ok(!a.texts.some((t) => t.text.includes('qué linda quedó la foto')), 'w7 no anexado');
  });
  await ok('"agrégala al álbum" anexa el caption pendiente (w7), no el comando', async () => {
    clearOutbound();
    const r = await postWebhook([textMsg('w8', SENDER, T0 + 410, 'agrégala al álbum por favor')]);
    assert.equal(r.statusCode, 200);
    await sleep(150);
    const texts = outbound.map((o) => o.text).join('\n');
    assert.ok(/Agregado al álbum/.test(texts));
    assert.ok(texts.includes('qué linda quedó la foto'), 'anexa el caption pendiente');
    const a = (await fastify.inject({ method: 'GET', url: `/api/whatsapp/albums/${albumId}` })).json();
    assert.equal(a.texts.length, 2);
    assert.equal(a.texts[1].label, 'text_2');
    assert.ok(a.texts[1].text.includes('qué linda quedó la foto'));
  });

  console.log('\n[e2e] remitentes separados, duplicados y tope de 3 min');
  await ok('otro remitente arma su propio lote (photo_relatos)', async () => {
    clearOutbound();
    await postWebhook([imgMsg('b1', '15557654321', T0 + 500, 'media_b1', 'mi foto')]);
    await sleep(600);
    const albums = (await fastify.inject({ method: 'GET', url: '/api/whatsapp/albums' })).json().albums;
    assert.equal(albums.length, 2);
    const b = albums.find((a) => a.wa_id === '15557654321');
    assert.ok(b);
    assert.equal(b.trigger, 'photo_relatos');
    assert.ok(b.caption.includes('mi foto'));
  });
  await ok('mensaje duplicado (mismo id) se ignora', async () => {
    await postWebhook([imgMsg('b1', '15557654321', T0 + 500, 'media_b1', 'mi foto')]);
    await sleep(400);
    const albums = (await fastify.inject({ method: 'GET', url: '/api/whatsapp/albums' })).json().albums;
    assert.equal(albums.length, 2, 'sin álbum nuevo por duplicado');
  });
  await ok('tope de 3 min: mensajes separados por >600ms van a lotes distintos', async () => {
    await postWebhook([imgMsg('c1', '15550001111', T0 + 900, 'media_c1', '')]);
    await sleep(800); // > WA_BATCH_MAX_MS: el lote se cerró por tope
    await postWebhook([imgMsg('c2', '15550001111', T0 + 910, 'media_c2', '')]);
    await sleep(600);
    const albums = (await fastify.inject({ method: 'GET', url: '/api/whatsapp/albums?wa_id=15550001111' })).json().albums;
    assert.equal(albums.length, 2, 'dos lotes separados');
    assert.ok(albums.every((a) => a.trigger === 'photo_relatos'));
  });
  await ok('rango de fechas en el título (2 fotos, 20 y 24 sep)', async () => {
    const d1 = Math.floor(Date.UTC(2026, 8, 20, 20, 0, 0) / 1000);
    const d2 = Math.floor(Date.UTC(2026, 8, 24, 20, 0, 0) / 1000);
    await postWebhook([imgMsg('d1', '15550002222', d1, 'media_d1', '')]);
    await postWebhook([imgMsg('d2', '15550002222', d2, 'media_d2', ''), textMsg('d3', '15550002222', d2 + 5, 'recuerdos')]);
    await sleep(600);
    const albums = (await fastify.inject({ method: 'GET', url: '/api/whatsapp/albums?wa_id=15550002222' })).json().albums;
    assert.equal(albums.length, 1);
    assert.equal(albums[0].trigger, 'album_caption');
    assert.equal(albums[0].title, 'Fotos del 20 al 24 de septiembre de 2026');
  });

  console.log('\n[e2e] texto inmediato: ayuda y estado no esperan el lote');
  await ok('"ayuda" responde al instante', async () => {
    clearOutbound();
    const r = await postWebhook([textMsg('e1', '15550003333', T0 + 1000, 'ayuda')]);
    assert.equal(r.statusCode, 200);
    await sleep(150);
    assert.ok(outbound.some((o) => /Soy NEXO por WhatsApp/.test(o.text)));
  });

  console.log('\n[unit] token-refresh v1.4.0 — debug, exchange y ensureFreshToken');
  const tr = require('./token-refresh');

  // fetch simulado: debug_token dice que el token vence en 60 días,
  // oauth/access_token devuelve uno nuevo.
  const fakeFetch = async (url) => {
    if (url.includes('/debug_token')) {
      const exp = Math.floor(Date.now() / 1000) + 60 * 24 * 3600;
      return { ok: true, json: async () => ({ data: { is_valid: true, expires_at: exp, scopes: ['user_posts', 'user_photos'] } }) };
    }
    if (url.includes('/oauth/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'NUEVO_TOKEN_60_DIAS', token_type: 'bearer', expires_in: 5184000 }) };
    }
    throw new Error(`URL inesperada: ${url}`);
  };
  const tcfg = () => ({ facebookToken: 'TOKEN_ENTORNO', facebookAppId: 'APP_ID', facebookAppSecret: 'APP_SECRET', fbTokenRefreshMarginDays: 7 });

  await ok('debugToken reporta válido con expiración', async () => {
    const d = await tr.debugToken({ token: 'X', appId: 'A', appSecret: 'S', fetchImpl: fakeFetch });
    assert.equal(d.valid, true);
    assert.ok(d.expires_at instanceof Date);
    assert.ok(d.scopes.includes('user_posts'));
  });
  await ok('exchangeToken devuelve el token nuevo', async () => {
    const e = await tr.exchangeToken({ token: 'VIEJO', appId: 'A', appSecret: 'S', fetchImpl: fakeFetch });
    assert.equal(e.access_token, 'NUEVO_TOKEN_60_DIAS');
    assert.equal(e.expires_in, 5184000);
  });
  await ok('token fresco (>margen) no se renueva y queda registrado en BD', async () => {
    const st = await tr.ensureFreshToken({ store, cfg: tcfg(), fetchImpl: fakeFetch, nowMs: Date.now() });
    assert.equal(st.ok, true);
    assert.equal(st.refreshed, false);
    assert.ok(st.dias_restantes >= 59);
    const saved = await store.getServiceToken('facebook');
    assert.equal(saved.access_token, 'TOKEN_ENTORNO');
  });
  await ok('token por vencer (<margen) se renueva y se guarda', async () => {
    const nearFetch = async (url) => {
      if (url.includes('/debug_token')) {
        const exp = Math.floor(Date.now() / 1000) + 2 * 24 * 3600; // vence en 2 días
        return { ok: true, json: async () => ({ data: { is_valid: true, expires_at: exp, scopes: [] } }) };
      }
      return fakeFetch(url);
    };
    const st = await tr.ensureFreshToken({ store, cfg: tcfg(), fetchImpl: nearFetch, nowMs: Date.now() });
    assert.equal(st.ok, true);
    assert.equal(st.refreshed, true);
    assert.ok(st.dias_restantes >= 59);
    const saved = await store.getServiceToken('facebook');
    assert.equal(saved.access_token, 'NUEVO_TOKEN_60_DIAS');
  });
  await ok('token inválido se reporta sin intentar exchange', async () => {
    let exchangeCalled = false;
    const badFetch = async (url) => {
      if (url.includes('/debug_token')) return { ok: true, json: async () => ({ data: { is_valid: false } }) };
      exchangeCalled = true;
      return fakeFetch(url);
    };
    const st = await tr.ensureFreshToken({ store, cfg: tcfg(), fetchImpl: badFetch, nowMs: Date.now() });
    assert.equal(st.ok, false);
    assert.equal(st.reason, 'token_invalido');
    assert.equal(exchangeCalled, false);
  });
  await ok('sin APP_ID/SECRET la renovación queda en manual', async () => {
    const st = await tr.ensureFreshToken({ store, cfg: { facebookToken: 'T' }, fetchImpl: fakeFetch, nowMs: Date.now() });
    assert.equal(st.ok, true);
    assert.equal(st.auto, false);
    assert.equal(st.reason, 'manual_sin_credenciales_app');
  });
  await ok('GET /api/facebook/token no expone el valor del token', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/api/facebook/token' });
    const body = r.json();
    assert.equal(r.statusCode, 200);
    assert.ok(body.estado);
    assert.ok(!JSON.stringify(body).includes('TOKEN_ENTORNO'));
    assert.ok(!JSON.stringify(body).includes('NUEVO_TOKEN_60_DIAS'));
  });

  console.log('\n[unit+e2e] embeddings + búsqueda semántica + Q&A v1.5.0');
  const embeddings = require('./embeddings');

  // fetch simulado de OpenAI: vectores deterministas por palabra clave,
  // para probar el ranking de verdad (playa=[1,0,0], montaña=[0,1,0]).
  const embVec = (text) => {
    const t = String(text).toLowerCase();
    if (t.includes('playa')) return [1, 0, 0];
    if (t.includes('montaña')) return [0, 1, 0];
    return [0, 0, 1];
  };
  const fakeOpenAI = async (url, opts) => {
    const body = JSON.parse((opts && opts.body) || '{}');
    if (url.includes('/v1/embeddings')) {
      return { ok: true, json: async () => ({ data: (body.input || []).map((tx, i) => ({ index: i, embedding: embVec(tx) })) }) };
    }
    if (url.includes('/v1/chat/completions')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Fuimos a la playa en familia [1].' } }] }) };
    }
    throw new Error(`URL inesperada: ${url}`);
  };
  embeddings.__setFetchForTests(fakeOpenAI);

  await ok('embedTexts devuelve vectores con fetch simulado', async () => {
    const r = await embeddings.embedTexts({ texts: ['hola', 'playa'], apiKey: 'K', model: 'text-embedding-3-small' });
    assert.equal(r.ok, true);
    assert.equal(r.vectors.length, 2);
    assert.deepEqual(r.vectors[1], [1, 0, 0]);
  });
  await ok('embedTexts sin apiKey reporta sin_api_key', async () => {
    const r = await embeddings.embedTexts({ texts: ['hola'] });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'sin_api_key');
  });

  const mkPkg = (id, text, source) => ({
    package_id: id, source, created_at: '2026-09-01T12:00:00Z', text, media: [],
    metadata: { source_id: id, dedupe_key: `dk_${id}`, permalink: `https://fb.test/${id}` },
    target_apps: [], status: 'listo',
  });
  const pkgPlaya = mkPkg('pkg_test_playa', 'Día increíble en la playa con la familia', 'facebook');
  const pkgMonte = mkPkg('pkg_test_monte', 'Caminata por la montaña con amigos', 'facebook');
  await store.savePackage(pkgPlaya);
  await store.savePackage(pkgMonte);
  const embCfg = { store, apiKey: 'K', model: 'text-embedding-3-small' };

  await ok('embedPackage guarda el embedding del paquete', async () => {
    const a = await embeddings.embedPackage(pkgPlaya, embCfg);
    const b = await embeddings.embedPackage(pkgMonte, embCfg);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const got = await store.getPackage('pkg_test_playa');
    assert.deepEqual(got.embedding, [1, 0, 0]);
  });
  await ok('searchSimilar ordena por similitud (playa primero)', async () => {
    const er = await embeddings.embedTexts({ texts: ['playa'], apiKey: 'K' });
    const hits = await store.searchSimilar({ embedding: er.vectors[0], limit: 5 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].package.package_id, 'pkg_test_playa');
    assert.ok(hits[0].score > hits[1].score);
  });
  await ok('GET /api/search?q=playa devuelve citas sin secretos', async () => {
    const r = await fastify.inject({ method: 'GET', url: '/api/search?q=playa&limit=5' });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.ok(body.resultados.length >= 2);
    assert.equal(body.resultados[0].package_id, 'pkg_test_playa');
    assert.ok(body.resultados[0].extracto.includes('playa'));
    assert.ok(!JSON.stringify(body).includes('test-key'));
  });
  await ok('POST /api/qa responde con citas numeradas', async () => {
    const r = await fastify.inject({ method: 'POST', url: '/api/qa', payload: { question: '¿A dónde fuimos?' } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.ok(body.answer.includes('[1]'));
    assert.ok(Array.isArray(body.citations));
    assert.equal(body.citations[0].package_id, 'pkg_test_playa');
    assert.equal(body.citations[0].n, 1);
    assert.ok(body.citations[0].permalink.includes('fb.test'));
    assert.ok(!JSON.stringify(body).includes('test-key'));
  });
  await ok('POST /api/embeddings/backfill vectoriza los pendientes', async () => {
    await store.savePackage(mkPkg('pkg_test_backfill', 'Atardecer tranquilo sin playa ni montaña', 'facebook'));
    const r = await fastify.inject({ method: 'POST', url: '/api/embeddings/backfill', payload: { limit: 50 } });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.ok, true);
    assert.ok(body.procesados >= 1);
    const resto = await store.packagesMissingEmbeddings(10);
    assert.equal(resto.length, 0);
  });
  await ok('sin OPENAI_API_KEY, /api/search y /api/qa responden 503', async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const s = await fastify.inject({ method: 'GET', url: '/api/search?q=playa' });
      assert.equal(s.statusCode, 503);
      assert.equal(s.json().error, 'busqueda_semantica_desactivada');
      const q = await fastify.inject({ method: 'POST', url: '/api/qa', payload: { question: 'x' } });
      assert.equal(q.statusCode, 503);
    } finally {
      process.env.OPENAI_API_KEY = saved;
    }
  });

  console.log(`\n${passed} pasadas, ${failed} fallidas.`);
  try {
    if (fs.existsSync(DATA_BACKUP)) {
      fs.copyFileSync(DATA_BACKUP, DATA_FILE);
      fs.unlinkSync(DATA_BACKUP);
    } else {
      fs.unlinkSync(DATA_FILE);
    }
  } catch { /* limpieza */ }
  if (failed > 0) process.exitCode = 1;
}

// ============================ MODO PROD ============================

async function runProd() {
  const base = (process.env.NEXO_PROD_URL || 'https://nexo-4yw6.onrender.com').replace(/\/+$/, '');
  console.log(`NEXO — verificación contra producción: ${base}`);
  let root;
  try {
    const r = await fetch(`${base}/`);
    root = await r.json();
  } catch (e) {
    console.error(`✗ no se pudo contactar producción: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  versión en producción: ${root.version}`);
  console.log(`  webhook_whatsapp: ${root.webhook_whatsapp}`);

  if (root.version !== '1.5.0') {
    console.log('\n  ⊘ E2E del webhook OMITIDO (no es fallo): producción aún no corre v1.5.0.');
    console.log('  Para habilitarlo:');
    console.log('    1) Sube el ZIP nexo-v1.5.0.zip al repo GitHub "nexo" (archivos planos en la raíz).');
    console.log('    2) Render redespliega solo; verifica GET / → "version": "1.5.0".');
    console.log('    3) Configura en Render: WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, APP_SECRET');
    console.log('       (y opcional WA_BATCH_PAUSE_MS, WA_BATCH_MAX_MS, MOMENTOS_AUTHOR).');
    console.log('    4) En la app de Meta (aparte de la del puente): webhook -> ' + base + '/webhook');
    console.log('    5) Re-corre: WA_E2E=1 TARGET=prod WA_TEST_APP_SECRET=<APP_SECRET> node test-all.js');
    return;
  }

  // v1.3.0 en producción: chequeos de solo lectura
  await ok('ruta /webhook existe (403 sin verify_token)', async () => {
    const r = await fetch(`${base}/webhook`);
    assert.equal(r.status, 403);
  });
  await ok('GET /api/whatsapp/albums responde', async () => {
    const r = await fetch(`${base}/api/whatsapp/albums?limit=1`);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).albums));
  });
  // v1.5.0 en producción: chequeos de solo lectura (503 = falta OPENAI_API_KEY, no es fallo)
  await ok('GET /api/search responde (200 o 503 sin OPENAI_API_KEY)', async () => {
    const r = await fetch(`${base}/api/search?q=playa&limit=2`);
    assert.ok([200, 503].includes(r.status), `status inesperado: ${r.status}`);
    const j = await r.json();
    assert.ok('ok' in j);
  });

  if (process.env.WA_E2E === '1') {
    const secret = process.env.WA_TEST_APP_SECRET;
    if (!secret) {
      console.log('  ⊘ E2E firmado omitido: falta WA_TEST_APP_SECRET.');
    } else {
      console.log('\n[e2e-prod] 3 fotos + 2 audios + texto (firmado)');
      const ts = Math.floor(Date.now() / 1000);
      const msgs = [
        imgMsg('e2e1', SENDER, ts, 'media_x1', ''),
        imgMsg('e2e2', SENDER, ts + 2, 'media_x2', ''),
        imgMsg('e2e3', SENDER, ts + 4, 'media_x3', ''),
        audioMsg('e2e4', SENDER, ts + 6, 'media_x4'),
        audioMsg('e2e5', SENDER, ts + 8, 'media_x5'),
        textMsg('e2e6', SENDER, ts + 10, 'prueba e2e multi-mensaje'),
      ];
      for (const m of msgs) {
        const body = JSON.stringify(waPayload([m]));
        const r = await fetch(`${base}/webhook`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(body, secret) },
          body,
        });
        assert.equal(r.status, 200);
      }
      console.log('  eventos aceptados; esperando el flush del lote (pausa 30s)...');
      let album = null;
      for (let i = 0; i < 24; i++) {
        await sleep(5000);
        const r = await fetch(`${base}/api/whatsapp/albums?wa_id=${SENDER}&limit=5`);
        const list = (await r.json()).albums || [];
        album = list.find((a) => a.trigger === 'multi_photo_album');
        if (album) break;
      }
      await ok('el lote produjo un álbum multi_photo_album', () => {
        assert.ok(album, 'no apareció el álbum tras 120s');
        assert.equal(album.counts.photos, 3);
        assert.equal(album.counts.audios, 2);
      });
      if (album) {
        console.log(`  álbum: ${album.album_id} — "${album.title}"`);
        console.log(`  payload de importación: ${base}/api/whatsapp/albums/${album.album_id}/import`);
        console.log('  (la importación a Momentos se hace desde el chat con Muse)');
      }
    }
  }
  console.log(`\n${passed} pasadas, ${failed} fallidas.`);
  if (failed > 0) process.exitCode = 1;
}

// ============================ main ============================

(async () => {
  try {
    if (process.env.TARGET === 'prod') await runProd();
    else await runLocal();
  } catch (e) {
    console.error('FALLO:', e);
    process.exitCode = 1;
  }
})();
