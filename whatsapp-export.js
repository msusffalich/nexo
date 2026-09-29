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
 *   iOS (12h): [9/29/26, 1:23:28 PM] Nombre: mensaje   <- iPhone en inglés
 *   Android: 12/3/24, 10:24 - Nombre: mensaje
 */

const crypto = require('node:crypto');

const IOS_RE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}), (\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\]\s?(.*)$/;
const ANDROID_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}), (\d{1,2}):(\d{2})\s?-\s?(.*)$/;
const MEDIA_PH = /multimedia omitido|media omitted|imagen omitida|image omitted|video omitido|mensaje de album/i;

function toISO(d, m, y, hh, mm, ss, ampm) {
  const yy = y.length === 2 ? 2000 + parseInt(y, 10) : parseInt(y, 10);
  let h = parseInt(hh, 10);
  if (ampm) {
    const pm = /^[Pp]/.test(ampm);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  const p = (n) => String(n).padStart(2, '0');
  return `${yy}-${p(m)}-${p(d)}T${p(h)}:${p(mm)}:${p(ss || 0)}`;
}

/**
 * WhatsApp usa el locale del teléfono: [9/29/26] (EE.UU.) es mes/día y
 * [29/9/26] (español) es día/mes. Si el segundo número > 12, solo puede
 * ser el día → el formato es M/D/Y y se intercambia. Si ambos ≤ 12 se
 * conserva día/mes (comportamiento histórico).
 */
function orderDayMonth(a, b) {
  if (parseInt(b, 10) > 12 && parseInt(a, 10) <= 12) return [b, a];
  return [a, b];
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
  // Los placeholders de medios idénticos al mismo segundo (ej. 10 fotos
  // seguidas como "<imagen omitida>") son mensajes distintos: se numeran
  // para que la deduplicación no los colapse. El conteo es determinista,
  // así que reimportar el mismo .txt no crea duplicados.
  const seen = new Map();

  function push() {
    if (current) {
      const k = `${current.created_at}|${current.author_name}|${current.text}`;
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      current.source_id = crypto
        .createHash('sha1')
        .update(`${opts.chatName || 'chat'}|${k}#${n}`)
        .digest('hex')
        .slice(0, 16);
      msgs.push(current);
    }
    current = null;
  }

  for (const line of lines) {
    let m = line.match(IOS_RE);
    let isIOS = true;
    if (!m) { m = line.match(ANDROID_RE); isIOS = false; }
    if (m) {
      push();
      const rest = m[m.length - 1]; // último grupo: el contenido tras el timestamp
      const sep = rest.indexOf(': ');
      if (sep === -1) continue; // línea de sistema (creó el grupo, etc.)
      const author = rest.slice(0, sep).trim();
      const body = rest.slice(sep + 2);
      // iOS: grupos 1..6 = fecha/hora, 7 = AM/PM (opcional). Android: 1..5, sin segundos.
      const [dd, mo] = orderDayMonth(m[1], m[2]);
      const created = isIOS
        ? toISO(dd, mo, m[3], m[4], m[5], m[6], m[7])
        : toISO(dd, mo, m[3], m[4], m[5], null);
      current = {
        source: 'whatsapp',
        author_name: author,
        author_handle: '',
        created_at: created + '-05:00',
        text: body,
        has_media: MEDIA_PH.test(body),
        media: [],
        permalink: '',
        source_id: '', // se calcula en push(), con conteo anti-colapso
      };
    } else if (current && line.trim() !== '') {
      current.text += '\n' + line; // mensaje multilínea
    }
  }
  push();
  return msgs.filter((x) => x.text && x.text.trim() !== '');
}

module.exports = { parseExport };
