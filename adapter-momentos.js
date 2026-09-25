'use strict';

/**
 * Adaptador Momentos (NEXO v1.3.0).
 *
 * Momentos es un artefacto privado sin API HTTP pública, así que este
 * adaptador NO puede crear el álbum solo: prepara el payload de importación
 * y lo deja disponible para que el asistente (Muse, en el chat) lo importe
 * con las acciones publicadas de Momentos:
 *   createalbum {title, author, albumDate, theme, language} -> albumId
 *   uploadmedia {albumId, kind:'image', originalName, mimeType, dataBase64,
 *                thumbnailBase64, takenAt, caption?, sourceRef} (por foto)
 *   addtextitem {albumId, text, takenAt} (por nota de audio / texto)
 *
 * Si algún día Momentos expone un puente HTTP, se configura
 * MOMENTOS_BRIDGE_URL y deliver() lo usará (mismo patrón que Legado Vivo).
 */

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Tema de Momentos según el contenido.
 * celebrations | festivities | memories | travel | entertainment
 */
function themeFor(text) {
  const t = ' ' + norm(text) + ' ';
  const has = (...ws) => ws.some((w) => t.includes(w));
  if (has('navidad', 'ano nuevo', 'fiestas patrias', 'carnaval', 'semana santa', 'halloween', 'fiesta patronal')) return 'festivities';
  if (has('cumpleanos', 'boda', 'matrimonio', 'aniversario', 'graduacion', 'bautizo', 'brindis', 'fiesta', 'celebracion', 'quinceanos')) return 'celebrations';
  if (has('viaje', 'vacaciones', 'playa', 'hotel', 'aeropuerto', 'avion', 'turismo', 'paseo', 'excursion', 'maleta')) return 'travel';
  if (has('concierto', 'partido', 'futbol', 'cine', 'teatro', 'show', 'estadio', 'recital')) return 'entertainment';
  return 'memories';
}

/**
 * Construye el payload de importación asistida para un álbum de NEXO.
 * baseUrl: URL pública del servicio NEXO (para descargar los medios).
 */
function importPayload(album, baseUrl) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  return {
    pasos: [
      '1) createalbum con los datos de "album"',
      '2) uploadmedia por cada entrada de "media" (dataBase64 desde fileUrl)',
      '3) addtextitem por cada entrada de "textos" (notas de audio y textos)',
    ],
    album: {
      title: album.title,
      author: album.author,
      albumDate: album.date_from, // YYYY-MM-DD
      theme: album.theme || 'memories',
      language: album.language || 'es',
    },
    media: (album.items || []).map((it, i) => ({
      label: it.label,
      kind: 'image',
      caption: it.caption || '',
      takenAt: it.taken_at,
      sortOrder: i,
      originalName: `${it.label}${(it.file || '').slice((it.file || '').lastIndexOf('.')) || '.jpg'}`,
      mimeType: it.mime || 'image/jpeg',
      fileUrl: it.file && base ? `${base}/api/whatsapp/media/${album.album_id}/${it.file}` : null,
      sourceRef: `nexo:${album.album_id}:${it.label}`,
    })),
    textos: [
      ...(album.audio_notes || []).map((a) => ({
        label: a.label,
        kind: 'audio_transcripcion',
        takenAt: a.taken_at,
        text: `🎙️ ${a.label}${a.transcription ? ' — ' + a.transcription : ' (transcripción pendiente)'}`,
      })),
      ...(album.texts || []).map((t) => ({
        label: t.label,
        kind: 'texto',
        takenAt: t.at,
        text: t.text,
      })),
      ...(album.caption && album.items.length === 0
        ? [{ label: 'text_caption', kind: 'texto', takenAt: album.created_at, text: album.caption }]
        : []),
    ],
    nexo_album_id: album.album_id,
    trigger: album.trigger,
  };
}

function bridgeEnabled(cfg) {
  return Boolean(cfg.momentosBridgeUrl);
}

/**
 * Intenta la entrega. Sin MOMENTOS_BRIDGE_URL devuelve pendiente_importacion
 * con el payload listo para importar desde el chat con Muse.
 */
async function deliver(album, cfg, hooks = {}) {
  const fetchFn = hooks.fetchImpl || fetch;
  const baseUrl = hooks.baseUrl || '';
  if (!bridgeEnabled(cfg)) {
    return {
      ok: false,
      error: 'pendiente_importacion',
      detail: 'Momentos no expone API HTTP pública: importa el álbum desde el chat con Muse usando el payload adjunto.',
      import: importPayload(album, baseUrl),
    };
  }
  const body = {
    albumId: album.album_id,
    title: album.title,
    author: album.author,
    theme: album.theme,
    language: album.language,
    dateFrom: album.date_from,
    dateTo: album.date_to,
    caption: album.caption,
    items: album.items,
    audioNotes: album.audio_notes,
    texts: album.texts,
  };
  const r = await fetchFn(`${cfg.momentosBridgeUrl}/api/bridge/albums`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text().catch(() => '');
  if (!r.ok) return { ok: false, error: `momentos_${r.status}`, detail: t.slice(0, 200) };
  return { ok: true, detail: t.slice(0, 200) };
}

module.exports = { themeFor, importPayload, deliver, bridgeEnabled };
