'use strict';

/**
 * Normalización: convierte el ítem crudo de cada fuente al paquete estándar
 * de NEXO, y calcula la clave de deduplicación.
 *
 * Paquete:
 * {
 *   package_id, source, author{name,handle}, created_at, text,
 *   media[{kind,image|video, url, filename, caption}],
 *   metadata{source_id, dedupe_key, permalink, category, tags, summary, lang},
 *   target_apps[], status, job_id
 * }
 */

const crypto = require('node:crypto');

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function fileNameFromUrl(url, fallback) {
  try {
    const p = new URL(url).pathname.split('/').pop() || '';
    const clean = p.split('?')[0];
    if (clean && /\.\w{2,5}$/.test(clean)) return clean;
  } catch { /* usa fallback */ }
  return fallback;
}

/**
 * raw: { source, source_id, author_name, author_handle, created_at (ISO),
 *         text, permalink, media: [{kind, url, caption}] }
 */
function toPackage(raw, jobId, authorDefault) {
  const source = raw.source;
  const sourceId = String(raw.source_id);
  const dedupeKey = sha1(`${source}:${sourceId}`);
  const media = (raw.media || []).map((m, i) => ({
    kind: m.kind === 'video' ? 'video' : 'image',
    url: m.url,
    filename: fileNameFromUrl(m.url, `${source}_${sourceId}_${i}.jpg`),
    caption: m.caption || '',
  }));
  return {
    package_id: `pkg_${dedupeKey.slice(0, 16)}`,
    source,
    author: {
      name: raw.author_name || (authorDefault && authorDefault.name) || '',
      handle: raw.author_handle || (authorDefault && authorDefault.handle) || '',
    },
    created_at: raw.created_at,
    text: raw.text || '',
    media,
    metadata: {
      source_id: sourceId,
      dedupe_key: dedupeKey,
      permalink: raw.permalink || '',
      category: '',
      tags: [],
      summary: '',
      lang: 'es',
    },
    target_apps: [],
    status: 'listo',
    job_id: jobId || null,
  };
}

module.exports = { toPackage, sha1 };
