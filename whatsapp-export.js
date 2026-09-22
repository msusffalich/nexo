'use strict';

/**
 * FASE 2 — Importador de exportaciones de WhatsApp.
 *
 * WhatsApp no ofrece API oficial para leer chats personales, así que la vía
 * es manual: desde el chat (iOS/Android) → Exportar chat → "sin archivos" o
 * "con archivos" → se obtiene un .txt (+ carpeta de medios si se incluyen).
 *
 * Este módulo convierte ese .txt en ítems crudos del Hub (uno por mensaje
 * con texto; los mensajes que son solo foto/video se marcan con has_media).
 *
 * Formatos soportados:
 *   iOS:     [12/3/2024, 10:24:35] Nombre: mensaje
 *   Android: 12/3/24, 10:24 - Nombre: mensaje
 */

const crypto = require('node:crypto');

const IOS_RE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}), (\d{1,2}):(\d{2})(?::(\d{2}))?\]\s?(.*)$/;
const ANDROID_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}), (\d{1,2}):(\d{2})\s?-\s?(.*)$/;
const MEDIA_PH = /multimedia omitido|media omitted|imagen omitida|image omitted|video omitido/i;

function toISO(d, m, y, hh, mm, ss) {
  const yy = y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${yy}-${p(m)}-${p(d)}T${p(hh)}:${p(mm)}:${p(ss || 0)}`;
}

/**
 * Parsea el texto de una exportación. Devuelve ítems crudos listos para
 * normalizar con normalize.toPackage (source 'whatsapp').
 * opts: { chatName } para la clave de deduplicación.
 */
function parseExport(text, opts = {}) {
  const lines = (text || '').split(/\r?\n/);
  const msgs = [];
  let current = null;

  function push() {
    if (current) msgs.push(current);
    current = null;
  }

  for (const line of lines) {
    let m = line.match(IOS_RE) || line.match(ANDROID_RE);
    if (m) {
      push();
      const rest = m[m.length - 1]; // último grupo: el contenido tras el timestamp
      const sep = rest.indexOf(': ');
      if (sep === -1) continue; // línea de sistema (creó el grupo, etc.)
      const author = rest.slice(0, sep).trim();
      const body = rest.slice(sep + 2);
      current = {
        source: 'whatsapp',
        author_name: author,
        author_handle: '',
        created_at: toISO(m[1], m[2], m[3], m[4], m[5], m[6]) + '-05:00',
        text: body,
        has_media: MEDIA_PH.test(body),
        media: [],
        permalink: '',
      };
      current.source_id = crypto
        .createHash('sha1')
        .update(`${opts.chatName || 'chat'}|${current.created_at}|${author}|${body}`)
        .digest('hex')
        .slice(0, 16);
    } else if (current && line.trim() !== '') {
      current.text += '\n' + line; // mensaje multilínea
    }
  }
  push();
  return msgs.filter((x) => x.text && x.text.trim() !== '');
}

module.exports = { parseExport };
