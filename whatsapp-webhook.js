'use strict';

/**
 * NEXO v1.3.0 — Webhook de WhatsApp con loteo multi-mensaje.
 *
 * A diferencia del Asistente Puente (un mensaje = un recuerdo), este webhook
 * AGRUPA los mensajes consecutivos del mismo remitente: las fotos que llegan
 * juntas forman un álbum y cada audio se convierte en una nota de voz
 * separada (con transcripción), sin mezclarse con el flujo del álbum.
 *
 * Reglas de loteo (batch):
 *   - Un mensaje se une al lote abierto si llega dentro de los 3 minutos
 *     siguientes al mensaje anterior del mismo remitente (WA_BATCH_MAX_MS).
 *   - El lote se cierra ("flush") cuando hay una pausa de 30 s sin mensajes
 *     nuevos (WA_BATCH_PAUSE_MS) o al llegar al tope de 3 min desde su inicio.
 *   - Un texto que es comando explícito ("agrégala al álbum", "estado",
 *     "ayuda", "extrae...") cierra primero el lote abierto y se atiende
 *     de inmediato (sin esperar la pausa).
 *   - Un texto solo, sin lote abierto, se atiende de inmediato.
 *
 * Triggers (clasificación del lote al cerrarse):
 *   - photo_relatos      1 foto (+ relato/caption opcional) -> álbum de 1 foto
 *   - album_caption      2 fotos con caption/texto -> álbum de 2 fotos
 *   - album_no_caption   2 fotos sin texto -> álbum de 2 fotos
 *   - multi_photo_album  3+ fotos (+ texto opcional) -> álbum con título de
 *                        rango de fechas; la respuesta indica N fotos + rango
 *   - audio_note         1 audio solo -> nota de voz (transcripción)
 *   - multi_audio_notes  2+ audios -> una nota separada por audio, con
 *                        etiquetas audio_1..N (y photo_1..M si hay fotos)
 *   - text_only          solo texto -> comando NEXO o regla del caption tardío
 *   - album_add_text     comando explícito "agrégala al álbum": anexa el
 *                        último texto al álbum más reciente del remitente
 *
 * Reglas de audio y captions (fijas):
 *   - El audio SIEMPRE va a transcripciones/notas separadas, nunca al álbum.
 *   - Un lote mixto (fotos + audios) se procesa por separado: las fotos
 *     siguen el flujo de álbum y los audios el de notas.
 *   - Un caption que llega DESPUÉS de creado el álbum NO se anexa solo:
 *     se acusa recibo y se pide el comando explícito ("agrégala al álbum").
 *
 * Sin WHATSAPP_TOKEN/PHONE_NUMBER_ID/VERIFY_TOKEN/APP_SECRET el webhook
 * existe pero rechaza los eventos; NEXO sigue operando como hub de
 * extracción sin cambios.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GRAPH_VERSION = 'v22.0';

const MESES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// ---------------------------------------------------------------------------
// Utilidades puras (testeables sin red)
// ---------------------------------------------------------------------------

function signatureValid(rawBody, header, appSecret) {
  if (!appSecret || !header) return false;
  const m = String(header).match(/^sha256=(.+)$/);
  if (!m) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const received = Buffer.from(m[1], 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/** Normaliza texto para comparar comandos (minúsculas, sin tildes). */
function norm(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ¿Es un comando explícito para anexar texto al último álbum? */
function isAlbumAddCommand(text) {
  const t = norm(text);
  return /\b(agrega|agregala|agregalo|agregalas|agregalos|anade|anadela|anadelo|suma|sumala|sumalo|incluye|incluyela|incluyelo|ponla|ponlo)\b[\s\S]*\balbum\b/.test(t)
      || /\balbum\b[\s\S]*\b(agrega|agregala|anade|anadela|suma|sumala)\b/.test(t);
}

/**
 * Separa el comando "agrégala al álbum" de un posible texto que lo acompañe
 * ("agrégala al álbum: fue un día hermoso" -> remainder "fue un día hermoso").
 * Devuelve { isCommand, remainder } (remainder en el texto ORIGINAL).
 */
function splitAlbumAddCommand(text) {
  const isCommand = isAlbumAddCommand(text);
  let remainder = '';
  if (isCommand) {
    const m = String(text || '').match(/álbum|album/i);
    if (m) {
      remainder = String(text).slice(m.index + m[0].length).replace(/^[\s:,\-–—]+/, '').trim();
    }
  }
  return { isCommand, remainder };
}

/** Día YYYY-MM-DD en America/Lima para un timestamp en ms. */
function limaDay(ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(ms));
}

function limaParts(ms) {
  const d = new Date(ms);
  const tz = 'America/Lima';
  const day = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(d), 10);
  const month = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric' }).format(d), 10);
  const year = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric' }).format(d), 10);
  return { day, month, year };
}

/**
 * Título del álbum a partir de los timestamps (ms) de sus fotos.
 * Un día:   "Fotos del 24 de septiembre de 2026"
 * Rango:    "Fotos del 20 al 24 de septiembre de 2026"
 *           (si cruza mes/año se nombran ambos extremos)
 */
function albumTitleFor(datesMs) {
  const days = [...new Set((datesMs || []).map(limaDay))].sort();
  if (days.length === 0) return 'Fotos de WhatsApp';
  const p1 = limaParts(new Date(days[0] + 'T12:00:00Z').getTime());
  const p2 = limaParts(new Date(days[days.length - 1] + 'T12:00:00Z').getTime());
  const mes = (m) => MESES_ES[m - 1];
  if (days.length === 1) return `Fotos del ${p1.day} de ${mes(p1.month)} de ${p1.year}`;
  if (p1.month === p2.month && p1.year === p2.year) {
    return `Fotos del ${p1.day} al ${p2.day} de ${mes(p1.month)} de ${p1.year}`;
  }
  if (p1.year === p2.year) {
    return `Fotos del ${p1.day} de ${mes(p1.month)} al ${p2.day} de ${mes(p2.month)} de ${p1.year}`;
  }
  return `Fotos del ${p1.day} de ${mes(p1.month)} de ${p1.year} al ${p2.day} de ${mes(p2.month)} de ${p2.year}`;
}

function photoTriggerFor(photoCount, hasCaption) {
  if (photoCount === 1) return 'photo_relatos';
  if (photoCount === 2) return hasCaption ? 'album_caption' : 'album_no_caption';
  return 'multi_photo_album';
}

/**
 * Clasifica un lote ya cerrado. items: [{id,type:'image'|'audio'|'text',at,
 * text,caption,mediaId}]. Devuelve {trigger, photoTrigger, audioTrigger,
 * photos, audios, texts, captions}.
 */
function classifyBatch(items) {
  const photos = items.filter((i) => i.type === 'image');
  const audios = items.filter((i) => i.type === 'audio');
  const texts = items.filter((i) => i.type === 'text');
  const P = photos.length;
  const A = audios.length;
  const captions = [
    ...photos.map((p) => p.caption).filter(Boolean),
    ...texts.map((t) => t.text).filter(Boolean),
  ].join('\n').trim();
  const hasCaption = captions.length > 0;
  const base = {
    photos, audios, texts, captions, hasCaption,
    counts: { photos: P, audios: A, texts: texts.length },
  };
  if (P === 0 && A === 0) return { ...base, trigger: 'text_only', photoTrigger: null, audioTrigger: null };
  if (P === 0 && A === 1) {
    return { ...base, trigger: 'audio_note', photoTrigger: null, audioTrigger: 'audio_note' };
  }
  if (P === 0) {
    return { ...base, trigger: 'multi_audio_notes', photoTrigger: null, audioTrigger: 'multi_audio_notes' };
  }
  // Con fotos, el trigger principal es el del álbum (las fotos mandan);
  // los audios, si los hay, van por su carril de notas separadas.
  const pt = photoTriggerFor(P, hasCaption);
  return {
    ...base,
    trigger: pt,
    photoTrigger: pt,
    audioTrigger: A === 1 ? 'audio_note' : A > 1 ? 'multi_audio_notes' : null,
  };
}

function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('mp4') || m.includes('m4a')) return '.m4a';
  return '';
}

// ---------------------------------------------------------------------------
// Webhook con estado (lotes, timers, envíos)
// ---------------------------------------------------------------------------

function createWebhook(deps) {
  const { cfg, store, momentos, intent, jobs, logger } = deps;
  const fetchImpl = deps.fetchImpl || fetch;

  const batches = new Map(); // waId -> batch abierto
  const pendingCaptions = new Map(); // waId -> texto suelto pendiente ("agrégala al álbum")
  let testSink = null; // en pruebas: captura los textos salientes

  function __setTestSink(fn) { testSink = fn; }
  function __resetBatches() {
    for (const b of batches.values()) {
      clearTimeout(b.pauseTimer);
      clearTimeout(b.maxTimer);
    }
    batches.clear();
    pendingCaptions.clear();
  }

  function dryRun() { return Boolean(cfg.dryRun); }

  async function sendText(to, body) {
    const text = String(body || '').slice(0, 4000);
    if (testSink) { testSink({ to, text }); }
    if (dryRun()) {
      (logger || console).info?.(`[DRY_RUN] -> ${to}: ${text.slice(0, 120)}`);
      return { dryRun: true };
    }
    const res = await fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.whatsappToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { preview_url: false, body: text },
        }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Graph API ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  }

  async function safeSend(to, body) {
    try {
      await sendText(to, body);
    } catch (err) {
      (logger || console).error?.(err, `No se pudo enviar WhatsApp a ${to}`);
    }
  }

  /** Descarga un medio de la Cloud API. En DRY_RUN no toca la red. */
  async function downloadMedia(mediaId) {
    if (dryRun()) return { dryRun: true, bytes: null, mime: null };
    const metaRes = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${cfg.whatsappToken}` },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta.url) throw new Error(`Meta medio ${metaIdShort(mediaId)}: sin URL (${metaRes.status})`);
    const r = await fetchImpl(meta.url, { headers: { Authorization: `Bearer ${cfg.whatsappToken}` } });
    if (!r.ok) throw new Error(`Descarga medio ${r.status}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    const mime = r.headers.get('content-type') || meta.mime_type || 'application/octet-stream';
    return { bytes, mime };
  }

  function mediaIdShort(id) { return String(id || '').slice(-6); }

  /** Transcribe un audio con Whisper (si hay OPENAI_API_KEY). */
  async function transcribeAudio(bytes, mime) {
    if (!cfg.openaiKey) return { transcription: null, note: 'sin_clave' };
    if (dryRun() || !bytes) {
      return { transcription: '[transcripción simulada en DRY_RUN]', note: 'dry_run' };
    }
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime || 'audio/ogg' }), 'audio.ogg');
    form.append('model', 'whisper-1');
    form.append('language', 'es');
    const r = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.openaiKey}` },
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { transcription: null, note: `openai_${r.status}` };
    return { transcription: (j.text || '').trim() || null, note: null };
  }

  // ---------------- loteo ----------------

  function newBatch(waId, now) {
    const b = {
      waId, startedAt: now, lastAt: now, items: [],
      pauseTimer: null, maxTimer: null,
    };
    b.maxTimer = setTimeout(() => { flushBatch(waId, 'maximo').catch((e) => (logger || console).error?.(e)); }, cfg.waBatchMaxMs);
    if (b.maxTimer.unref) b.maxTimer.unref();
    batches.set(waId, b);
    return b;
  }

  function touchBatch(b) {
    clearTimeout(b.pauseTimer);
    b.pauseTimer = setTimeout(() => { flushBatch(b.waId, 'pausa').catch((e) => (logger || console).error?.(e)); }, cfg.waBatchPauseMs);
    if (b.pauseTimer.unref) b.pauseTimer.unref();
  }

  async function flushBatch(waId, reason) {
    const b = batches.get(waId);
    if (!b) return null;
    clearTimeout(b.pauseTimer);
    clearTimeout(b.maxTimer);
    batches.delete(waId);
    if (b.items.length === 0) return null;
    (logger || console).info?.({ waId, items: b.items.length, reason }, 'Lote WhatsApp cerrado');
    return processBatch(b, reason);
  }

  /** Texto inmediato (sin loteo): comandos y caption tardío. */
  async function handleImmediateText(waId, text) {
    // 1) Comando explícito "agrégala al álbum": anexa el caption pendiente
    //    (el texto suelto que se acusó antes) o el que venga en el comando.
    const split = splitAlbumAddCommand(text);
    if (split.isCommand) {
      const last = await store.lastWaAlbum(waId);
      if (!last) {
        await safeSend(waId, 'No tengo ningún álbum reciente al cual agregarlo. Mándame fotos o audios primero y armo uno.');
        return { trigger: 'album_add_text', ok: false, reason: 'sin_album' };
      }
      const pending = pendingCaptions.get(waId);
      const toAdd = ((pending && pending.trim()) || split.remainder || '').trim();
      pendingCaptions.delete(waId);
      if (!toAdd) {
        await safeSend(
          waId,
          `¿Qué texto quieres agregar al álbum "${last.title}"? Escríbelo y luego dime *agrégala al álbum*.`
        );
        return { trigger: 'album_add_text', ok: false, reason: 'sin_texto' };
      }
      const label = `text_${(last.texts || []).length + 1}`;
      last.texts = [...(last.texts || []), { label, kind: 'text', text: toAdd, at: new Date().toISOString() }];
      last.updated_at = new Date().toISOString();
      await store.saveWaAlbum(last);
      await safeSend(
        waId,
        `Agregado al álbum "${last.title}":\n"${toAdd.slice(0, 280)}${toAdd.length > 280 ? '…' : ''}"`
      );
      return { trigger: 'album_add_text', ok: true, album_id: last.album_id };
    }

    // 2) Comandos NEXO en lenguaje natural
    const parsed = intent.parseCommand(text);
    if (parsed.intent === 'ayuda') {
      await safeSend(
        waId,
        'Soy NEXO por WhatsApp. Puedo:\n' +
          '• Armar un álbum en Momentos: mándame fotos (si mandas varias seguidas, las junto en un solo álbum).\n' +
          '• Transcribir notas de voz: cada audio queda como nota separada.\n' +
          '• Ver el estado: escribe "estado".\n' +
          'Si me escribes un texto después de un álbum, no lo anexo solo: dime "agrégala al álbum".'
      );
      return { trigger: 'text_only', intent: 'ayuda' };
    }
    if (parsed.intent === 'estado') {
      const trabajos = await store.listJobs(5);
      const lineas = trabajos.length
        ? trabajos.map((j) => `• ${j.id.slice(0, 12)}… ${j.type} (${j.status})`).join('\n')
        : 'Sin trabajos todavía.';
      await safeSend(waId, `Estado de NEXO:\n${lineas}`);
      return { trigger: 'text_only', intent: 'estado' };
    }
    if (parsed.intent === 'extraer' && !parsed.error) {
      try {
        const { job_id, stats } = await jobs.extraer(
          { source: parsed.source, kind: parsed.kind, from: parsed.from, to: parsed.to, target_apps: [] },
          cfg, { fetchImpl }
        );
        await safeSend(
          waId,
          `Extracción iniciada (${parsed.source}, ${parsed.from} → ${parsed.to}).\nTrabajo ${job_id}: ${stats.nuevos} nuevos, ${stats.duplicados} duplicados.`
        );
        return { trigger: 'text_only', intent: 'extraer', job_id };
      } catch (e) {
        await safeSend(waId, `No pude iniciar la extracción: ${e.message}`);
        return { trigger: 'text_only', intent: 'extraer', ok: false };
      }
    }
    if (parsed.intent === 'extraer' && parsed.error === 'whatsapp_fase_2') {
      await safeSend(
        waId,
        'El historial de chats personales aún no lo extraigo solo: expórtalo desde tu teléfono y súbelo (fase 2). Por aquí sí puedo armarte álbumes con las fotos y audios que me mandes.'
      );
      return { trigger: 'text_only', intent: 'extraer', error: 'whatsapp_fase_2' };
    }

    // 3) Caption tardío: NO se anexa solo (regla fija). Se acusa recibo,
    //    queda pendiente por si el usuario dice "agrégala al álbum", y se
    //    le enseña el comando explícito.
    const last = await store.lastWaAlbum(waId);
    pendingCaptions.set(waId, text);
    await safeSend(
      waId,
      `Anotado: "${text.slice(0, 200)}${text.length > 200 ? '…' : ''}".` +
        (last
          ? `\nSi quieres agregarlo al álbum "${last.title}", escríbeme: *agrégala al álbum*.`
          : '\nMándame fotos o audios y te armo el álbum en Momentos.')
    );
    return { trigger: 'text_only', intent: 'desconocido' };
  }

  /** Decide si un texto cierra el lote abierto para atenderse ya. */
  function textIsImmediate(text) {
    if (isAlbumAddCommand(text)) return true;
    const p = intent.parseCommand(text);
    return ['ayuda', 'estado'].includes(p.intent) || (p.intent === 'extraer');
  }

  async function ingestMessage(waId, msg) {
    const now = Date.now();
    if (!msg || !msg.id) return { ok: false, reason: 'sin_id' };
    if (await store.waMessageSeen(msg.id)) return { ok: true, duplicate: true };
    await store.waMessageMark(msg.id, waId);

    const type = msg.type;
    if (!['text', 'image', 'audio'].includes(type)) {
      await safeSend(waId, 'Por aquí entiendo texto, fotos y notas de voz. Mándame fotos seguidas y las junto en un álbum para Momentos.');
      return { ok: true, unsupported: type };
    }

    const item = {
      id: msg.id,
      type,
      at: (msg.timestamp ? msg.timestamp * 1000 : now),
      text: type === 'text' ? (msg.text || '') : '',
      caption: type === 'image' ? (msg.caption || '') : '',
      mediaId: type === 'image' ? msg.imageId : type === 'audio' ? msg.audioId : null,
    };

    // Texto inmediato: cierra el lote abierto y se atiende sin esperar.
    if (type === 'text' && textIsImmediate(item.text)) {
      await flushBatch(waId, 'comando');
      return handleImmediateText(waId, item.text);
    }
    // Texto solo sin lote abierto: atención inmediata (posible caption tardío).
    if (type === 'text' && !batches.has(waId)) {
      return handleImmediateText(waId, item.text);
    }

    let b = batches.get(waId);
    if (b && (now - b.lastAt > cfg.waBatchMaxMs || now - b.startedAt >= cfg.waBatchMaxMs)) {
      await flushBatch(waId, 'maximo');
      b = null;
    }
    if (!b) b = newBatch(waId, now);
    b.items.push(item);
    b.lastAt = now;
    touchBatch(b);
    return { ok: true, batched: true, batch_size: b.items.length };
  }

  async function ingestPayload(payload) {
    const changes = payload?.entry?.[0]?.changes || [];
    let count = 0;
    for (const change of changes) {
      const value = change?.value || {};
      for (const msg of value?.messages || []) {
        const waId = msg.from;
        const adapted = {
          id: msg.id,
          type: msg.type,
          timestamp: msg.timestamp ? parseInt(msg.timestamp, 10) : null,
          text: msg.type === 'text' ? msg.text?.body || '' : '',
          caption: msg.type === 'image' ? msg.image?.caption || '' : '',
          imageId: msg.type === 'image' ? msg.image?.id : null,
          audioId: msg.type === 'audio' ? msg.audio?.id : null,
        };
        try {
          await ingestMessage(waId, adapted);
          count += 1;
        } catch (err) {
          (logger || console).error?.(err, `Error con mensaje ${msg.id}`);
        }
      }
    }
    return { ok: true, messages: count };
  }

  // ---------------- procesamiento del lote ----------------

  function mediaDirFor(albumId) {
    const dir = path.join(__dirname, 'media', 'wa', albumId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async function processBatch(batch, reason) {
    const c = classifyBatch(batch.items);
    const waId = batch.waId;

    // Etiquetas de ítem: photo_1..M, audio_1..N, text_1..K
    let np = 0, na = 0, nt = 0;
    for (const it of batch.items) {
      if (it.type === 'image') it.label = `photo_${++np}`;
      else if (it.type === 'audio') it.label = `audio_${++na}`;
      else it.label = `text_${++nt}`;
    }

    const albumId = `wa_${crypto.randomBytes(8).toString('hex')}`;
    const datesMs = batch.items.map((i) => i.at);
    const title = albumTitleFor(datesMs);

    // Descarga de medios (fotos y audios) — en DRY_RUN se omite la red.
    for (const it of batch.items) {
      if ((it.type === 'image' || it.type === 'audio') && it.mediaId) {
        try {
          const dl = await downloadMedia(it.mediaId);
          it.media = dl.dryRun ? { dryRun: true } : { bytes: dl.bytes, mime: dl.mime, ext: extForMime(dl.mime) || (it.type === 'image' ? '.jpg' : '.ogg') };
        } catch (e) {
          it.media = { error: e.message };
          (logger || console).error?.(e, `No se pudo descargar ${it.label}`);
        }
      }
    }

    // Transcripción de audios: cada audio -> nota separada (nunca al álbum).
    const audioNotes = [];
    for (const it of c.audios) {
      const m = it.media || {};
      let transcription = null;
      let note = null;
      if (m.bytes) {
        try {
          const t = await transcribeAudio(m.bytes, m.mime);
          transcription = t.transcription;
          note = t.note;
        } catch (e) {
          note = `error_transcripcion: ${e.message}`;
        }
      } else if (m.dryRun) {
        const t = await transcribeAudio(null, null);
        transcription = t.transcription;
        note = t.note;
      } else {
        note = m.error ? `sin_audio: ${m.error}` : 'sin_audio';
      }
      audioNotes.push({
        label: it.label,
        kind: 'audio',
        transcription,
        note,
        mime: m.mime || null,
        taken_at: new Date(it.at).toISOString(),
        file: null, // se completa abajo si hay bytes
      });
    }

    // Fotos del álbum
    const photoItems = [];
    if (c.photos.length > 0) {
      const dir = dryRun() ? null : mediaDirFor(albumId);
      for (const it of c.photos) {
        const m = it.media || {};
        let file = null;
        if (m.bytes && dir) {
          file = `${it.label}${m.ext || '.jpg'}`;
          fs.writeFileSync(path.join(dir, file), m.bytes);
        }
        photoItems.push({
          label: it.label,
          kind: 'image',
          caption: it.caption || '',
          mime: m.mime || null,
          file,
          taken_at: new Date(it.at).toISOString(),
          media_error: m.error || null,
        });
      }
      // audios: guardar bytes también (para re-escucha), fuera del flujo del álbum
      if (dir) {
        for (const it of c.audios) {
          const m = it.media || {};
          if (m.bytes) {
            const f = `${it.label}${m.ext || '.ogg'}`;
            fs.writeFileSync(path.join(dir, f), m.bytes);
            const an = audioNotes.find((a) => a.label === it.label);
            if (an) an.file = f;
          }
        }
      }
    }

    const album = {
      album_id: albumId,
      wa_id: waId,
      kind: c.photos.length > 0 ? 'album' : 'audio_notes',
      trigger: c.trigger,
      photo_trigger: c.photoTrigger,
      audio_trigger: c.audioTrigger,
      title,
      author: cfg.momentosAuthor,
      theme: null, // lo resuelve adapter-momentos al preparar la importación
      language: 'es',
      date_from: limaDay(Math.min(...datesMs)),
      date_to: limaDay(Math.max(...datesMs)),
      caption: c.captions,
      items: photoItems,       // SOLO fotos -> flujo del álbum
      audio_notes: audioNotes, // audios -> transcripciones separadas
      texts: c.texts.map((t) => ({ label: t.label, kind: 'text', text: t.text, at: new Date(t.at).toISOString() })),
      counts: c.counts,
      flush_reason: reason,
      import_status: 'pendiente',
      created_at: new Date().toISOString(),
    };
    album.theme = momentos.themeFor(album.caption || album.title);

    await store.saveWaAlbum(album);

    // Respuesta al usuario (con N fotos + rango de fechas cuando hay álbum)
    await replyForBatch(waId, album, c);

    return { ok: true, album_id: albumId, trigger: c.trigger };
  }

  function fmtRange(album) {
    const f = (iso) => {
      const p = limaParts(new Date(iso + 'T12:00:00Z').getTime());
      return `${p.day} de ${MESES_ES[p.month - 1]} de ${p.year}`;
    };
    if (album.date_from === album.date_to) return f(album.date_from);
    return `${f(album.date_from)} al ${f(album.date_to)}`;
  }

  async function replyForBatch(waId, album, c) {
    const P = c.counts.photos;
    const A = c.counts.audios;
    const parts = [];

    if (P > 0) {
      const n = P === 1 ? '1 foto' : `${P} fotos`;
      const base = {
        photo_relatos: `📸 Foto recibida${album.caption ? ' con tu relato' : ''}. La dejé lista para Momentos como "${album.title}".`,
        album_caption: `📸 Álbum listo: "${album.title}" — 2 fotos con tu caption.`,
        album_no_caption: `📸 Álbum listo: "${album.title}" — 2 fotos.`,
        multi_photo_album: `📸 Álbum listo: "${album.title}" — ${n} (${fmtRange(album)}).`,
      }[c.photoTrigger] || `📸 Álbum listo: "${album.title}" — ${n}.`;
      parts.push(base);
    }
    if (A > 0) {
      const labels = c.audios.map((a) => a.label).join(', ');
      const pend = album.audio_notes.some((a) => !a.transcription);
      const n = A === 1 ? '1 nota de voz' : `${A} notas de voz`;
      parts.push(
        `🎙️ ${n} recibida${A > 1 ? 's' : ''} (${labels}): ` +
        (pend
          ? 'la transcripción queda pendiente.'
          : 'transcripción lista.') +
        ' Van como notas separadas para Momentos, no dentro del álbum.'
      );
    }
    parts.push('Te aviso por aquí cuando queden importadas a Momentos (la importación se hace desde el chat con Muse).');
    await safeSend(waId, parts.join('\n'));
  }

  // ---------------- verificación de Meta ----------------

  function handleVerify(query) {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];
    if (mode === 'subscribe' && token && cfg.verifyToken && token === cfg.verifyToken) {
      return { status: 200, body: challenge };
    }
    return { status: 403, body: 'Token de verificación inválido.' };
  }

  return {
    ingestPayload,
    ingestMessage,
    flushBatch,
    handleVerify,
    handleImmediateText,
    __setTestSink,
    __resetBatches,
    __batches: batches,
  };
}

module.exports = {
  createWebhook,
  signatureValid,
  classifyBatch,
  photoTriggerFor,
  albumTitleFor,
  isAlbumAddCommand,
  splitAlbumAddCommand,
  limaDay,
  norm,
};
