'use strict';

/**
 * Ejecutor de trabajos de extracción de NEXO.
 *
 * Un trabajo: { source: 'facebook'|'instagram', kind: 'fotos'|'videos'|'posts'|'todo',
 *               from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', target_apps: [] }
 *
 * Flujo: extraer crudo -> normalizar -> deduplicar -> enriquecer con IA -> guardar.
 * Los duplicados (misma fuente + mismo id) se omiten sin error.
 */

const store = require('./store');
const { toPackage } = require('./normalize');
const ai = require('./ai');
const facebook = require('./source-facebook');
const instagram = require('./source-instagram');
const { getFacebookToken } = require('./token-refresh');
const { embedPackage } = require('./embeddings');

async function extractRaw({ source, kind, from, until, token, igUserId, fetchImpl }) {
  if (source === 'facebook') {
    const posts = kind === 'fotos' || kind === 'videos' ? [] : await facebook.fetchPosts({ token, since: from, until, fetchImpl });
    const photos = kind === 'posts' ? [] : await facebook.fetchPhotos({ token, since: from, until, fetchImpl });
    return [...posts, ...photos];
  }
  if (source === 'instagram') {
    return instagram.fetchMedia({ token, igUserId, since: from, until, kind, fetchImpl });
  }
  throw new Error(`Fuente no soportada: ${source}`);
}

/**
 * Ejecuta un trabajo ya creado (por id) o un spec directo.
 * hooks: { fetchImpl, openaiKey, onProgress } — solo para pruebas.
 */
async function runJob(jobId, cfg, hooks = {}) {
  const job = await store.getJob(jobId);
  if (!job) throw new Error(`Trabajo no existe: ${jobId}`);
  const params = job.params || {};
  await store.updateJob(jobId, { status: 'en_proceso' });

  const stats = { extraidos: 0, nuevos: 0, duplicados: 0, errores: 0 };
  try {
    const rawItems = await extractRaw({
      source: params.source,
      kind: params.kind || 'todo',
      from: params.from,
      until: params.to,
      // El token vigente vive en la BD si la auto-renovación lo actualizó;
      // si no, se usa el del entorno.
      token: params.source === 'facebook' ? await getFacebookToken({ store, cfg }) : cfg.facebookToken,
      igUserId: cfg.instagramUserId,
      fetchImpl: hooks.fetchImpl,
    });
    stats.extraidos = rawItems.length;

    for (const raw of rawItems) {
      try {
        const pkg = toPackage(raw, jobId, params.author);
        const seen = await store.seenDedupeKey(pkg.metadata.dedupe_key);
        if (seen) { stats.duplicados += 1; continue; }
        await ai.enrich(pkg, hooks.openaiKey !== undefined ? hooks.openaiKey : cfg.openaiKey, hooks.fetchImpl,
          { jev: hooks.jev !== undefined ? hooks.jev : cfg.jev });
        pkg.target_apps = params.target_apps || [];
        await store.savePackage(pkg);
        // v1.5.0: vectorizar para búsqueda semántica (nunca rompe la extracción)
        const emb = await embedPackage(pkg, { store, apiKey: cfg.openaiKey, model: cfg.embeddingModel });
        if (!emb.ok && emb.reason !== 'sin_api_key' && emb.reason !== 'sin_texto') {
          console.warn(`[nexo] embedding omitido para ${pkg.package_id}: ${emb.reason}`);
        }
        stats.nuevos += 1;
        if (hooks.onProgress) hooks.onProgress(pkg);
      } catch (e) {
        stats.errores += 1;
      }
    }
    await store.updateJob(jobId, { status: 'completado', result: stats });
  } catch (e) {
    await store.updateJob(jobId, { status: 'fallido', result: { ...stats, error: e.message } });
    throw e;
  }
  return stats;
}

/** Crea y ejecuta un trabajo de extracción. */
async function extraer(spec, cfg, hooks = {}) {
  const job = await store.createJob('extraccion', spec);
  const stats = await runJob(job.id, cfg, hooks);
  return { job_id: job.id, stats };
}

module.exports = { runJob, extraer, extractRaw };
