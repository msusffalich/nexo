'use strict';

/**
 * Almacén dual de NEXO (mismo patrón del Asistente Puente).
 * - Con DATABASE_URL: PostgreSQL (tablas hub_jobs, hub_packages, hub_seen).
 * - Sin DATABASE_URL: data.json local (prototipo / DRY_RUN).
 *
 * Entidades:
 *   job:     { id, type:'extraccion'|'importacion', params, status, result, created_at, updated_at }
 *   package: { package_id, source, author, created_at, text, media[], metadata{}, target_apps[], status, job_id }
 *   seen:    clave de deduplicación (source:source_id) -> package_id
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_FILE = path.join(__dirname, 'data.json');
const usePostgres = Boolean(process.env.DATABASE_URL);
const backend = usePostgres ? 'postgres' : 'json';

// ---------------- JSON local ----------------

function emptyDb() {
  return { jobs: {}, packages: {}, seen: {}, wa_albums: {}, wa_seen: {}, service_tokens: {}, seq: 0 };
}
let jsonDb = null;
function jdb() {
  if (!jsonDb) {
    try {
      jsonDb = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      jsonDb = emptyDb();
    }
    jsonDb.jobs = jsonDb.jobs || {};
    jsonDb.packages = jsonDb.packages || {};
    jsonDb.seen = jsonDb.seen || {};
    jsonDb.wa_albums = jsonDb.wa_albums || {};
    jsonDb.wa_seen = jsonDb.wa_seen || {};
    jsonDb.service_tokens = jsonDb.service_tokens || {};
  }
  return jsonDb;
}
function jsave() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(jdb(), null, 2));
}

// ---------------- PostgreSQL ----------------

let pool = null;
function __setPoolForTests(p) { pool = p; }

function getPool() {
  if (pool) return pool;
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS hub_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pendiente',
  result JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hub_packages (
  package_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  data JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'listo',
  job_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_packages_source_idx ON hub_packages (source);
CREATE TABLE IF NOT EXISTS hub_seen (
  dedupe_key TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- v1.3.0: álbumes/notas preparados desde el webhook de WhatsApp multi-mensaje
CREATE TABLE IF NOT EXISTS hub_wa_albums (
  album_id TEXT PRIMARY KEY,
  wa_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hub_wa_albums_wa_id_idx ON hub_wa_albums (wa_id);
-- v1.3.0: idempotencia de eventos del webhook (Meta puede reintentar)
CREATE TABLE IF NOT EXISTS hub_wa_seen (
  message_id TEXT PRIMARY KEY,
  wa_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- v1.4.0: tokens de servicio auto-renovables (p. ej. token de usuario de Facebook)
CREATE TABLE IF NOT EXISTS hub_service_tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

// v1.5.0: búsqueda semántica con pgvector (best-effort: si la extensión no
// está disponible, el servicio arranca igual y /api/search reporta el motivo).
const SEMANTIC_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE hub_packages ADD COLUMN IF NOT EXISTS embedding vector(1536);
`;

let semanticReady = false;
function isSemanticReady() { return semanticReady; }

async function init() {
  if (!usePostgres) { semanticReady = true; return { backend }; }
  await getPool().query(SCHEMA_SQL);
  try {
    await getPool().query(SEMANTIC_SQL);
    semanticReady = true;
  } catch (e) {
    semanticReady = false;
    console.warn('[nexo] pgvector no disponible; búsqueda semántica desactivada:', e.message);
  }
  return { backend };
}

// ---------------- API ----------------

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

async function createJob(type, params) {
  const id = newId('job');
  const row = { id, type, params, status: 'pendiente', result: {} };
  if (usePostgres) {
    await getPool().query(
      'INSERT INTO hub_jobs (id, type, params, status, result) VALUES ($1,$2,$3,$4,$5)',
      [id, type, params, 'pendiente', {}]
    );
  } else {
    jdb().jobs[id] = { ...row, created_at: new Date().toISOString() };
    jsave();
  }
  return row;
}

async function updateJob(id, patch) {
  if (usePostgres) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = $${i++}`);
      vals.push(k === 'params' || k === 'result' ? JSON.stringify(v) : v);
    }
    sets.push('updated_at = now()');
    vals.push(id);
    await getPool().query(`UPDATE hub_jobs SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  } else {
    const j = jdb().jobs[id];
    if (j) { Object.assign(j, patch); jsave(); }
  }
}

async function getJob(id) {
  if (usePostgres) {
    const r = await getPool().query('SELECT * FROM hub_jobs WHERE id = $1', [id]);
    return r.rows[0] || null;
  }
  return jdb().jobs[id] || null;
}

async function listJobs(limit = 20) {
  if (usePostgres) {
    const r = await getPool().query('SELECT * FROM hub_jobs ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows;
  }
  return Object.values(jdb().jobs)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
}

async function seenDedupeKey(key) {
  if (usePostgres) {
    const r = await getPool().query('SELECT package_id FROM hub_seen WHERE dedupe_key = $1', [key]);
    return r.rows[0] ? r.rows[0].package_id : null;
  }
  return jdb().seen[key] || null;
}

async function savePackage(pkg) {
  if (usePostgres) {
    await getPool().query(
      `INSERT INTO hub_packages (package_id, source, data, status, job_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (package_id) DO UPDATE SET data = EXCLUDED.data, status = EXCLUDED.status`,
      [pkg.package_id, pkg.source, JSON.stringify(pkg), pkg.status || 'listo', pkg.job_id || null]
    );
    await getPool().query(
      'INSERT INTO hub_seen (dedupe_key, package_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [pkg.metadata.dedupe_key, pkg.package_id]
    );
  } else {
    jdb().packages[pkg.package_id] = pkg;
    jdb().seen[pkg.metadata.dedupe_key] = pkg.package_id;
    jsave();
  }
  return pkg;
}

async function getPackage(packageId) {
  if (usePostgres) {
    const r = await getPool().query('SELECT data FROM hub_packages WHERE package_id = $1', [packageId]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  return jdb().packages[packageId] || null;
}

async function listPackages({ source, status, limit = 50 } = {}) {
  if (usePostgres) {
    const conds = [];
    const vals = [];
    if (source) { vals.push(source); conds.push(`source = $${vals.length}`); }
    if (status) { vals.push(status); conds.push(`status = $${vals.length}`); }
    vals.push(limit);
    const r = await getPool().query(
      `SELECT data FROM hub_packages ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT $${vals.length}`,
      vals
    );
    return r.rows.map((x) => x.data);
  }
  let all = Object.values(jdb().packages);
  if (source) all = all.filter((p) => p.source === source);
  if (status) all = all.filter((p) => p.status === status);
  return all
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
}

async function setPackageStatus(packageId, status) {
  if (usePostgres) {
    await getPool().query('UPDATE hub_packages SET status = $1 WHERE package_id = $2', [status, packageId]);
  } else {
    const p = jdb().packages[packageId];
    if (p) { p.status = status; jsave(); }
  }
}

// ---------------- v1.3.0: álbumes de WhatsApp ----------------

/** Guarda el álbum/nota preparado por el webhook. data es el payload completo. */
async function saveWaAlbum(album) {
  const row = { ...album, created_at: album.created_at || new Date().toISOString() };
  if (usePostgres) {
    await getPool().query(
      `INSERT INTO hub_wa_albums (album_id, wa_id, data)
       VALUES ($1,$2,$3)
       ON CONFLICT (album_id) DO UPDATE SET data = EXCLUDED.data`,
      [row.album_id, row.wa_id, JSON.stringify(row)]
    );
  } else {
    jdb().wa_albums[row.album_id] = row;
    jsave();
  }
  return row;
}

async function getWaAlbum(albumId) {
  if (usePostgres) {
    const r = await getPool().query('SELECT data FROM hub_wa_albums WHERE album_id = $1', [albumId]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  return jdb().wa_albums[albumId] || null;
}

async function listWaAlbums({ waId, limit = 20 } = {}) {
  if (usePostgres) {
    const vals = [];
    const cond = waId ? 'WHERE wa_id = $1' : '';
    if (waId) vals.push(waId);
    vals.push(limit);
    const r = await getPool().query(
      `SELECT data FROM hub_wa_albums ${cond} ORDER BY created_at DESC LIMIT $${vals.length}`, vals
    );
    return r.rows.map((x) => x.data);
  }
  let all = Object.values(jdb().wa_albums);
  if (waId) all = all.filter((a) => a.wa_id === waId);
  return all.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).slice(0, limit);
}

/** Último álbum del remitente (para el comando "agrégala al álbum"). */
async function lastWaAlbum(waId) {
  const list = await listWaAlbums({ waId, limit: 1 });
  return list[0] || null;
}

/** Idempotencia: ¿ya se procesó este message_id de Meta? */
async function waMessageSeen(messageId) {
  if (usePostgres) {
    const r = await getPool().query('SELECT message_id FROM hub_wa_seen WHERE message_id = $1', [messageId]);
    return Boolean(r.rows[0]);
  }
  return Boolean(jdb().wa_seen[messageId]);
}

async function waMessageMark(messageId, waId) {
  if (usePostgres) {
    await getPool().query(
      'INSERT INTO hub_wa_seen (message_id, wa_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [messageId, waId]
    );
  } else {
    jdb().wa_seen[messageId] = { wa_id: waId, at: new Date().toISOString() };
    jsave();
  }
}

// ---------------- v1.4.0: tokens de servicio ----------------

/**
 * Lee el token guardado para un proveedor.
 * Devuelve { access_token, expires_at: Date|null } o null.
 */
async function getServiceToken(provider) {
  if (usePostgres) {
    const r = await getPool().query('SELECT access_token, expires_at FROM hub_service_tokens WHERE provider = $1', [provider]);
    const row = r.rows[0];
    if (!row) return null;
    return { access_token: row.access_token, expires_at: row.expires_at ? new Date(row.expires_at) : null };
  }
  const t = jdb().service_tokens[provider];
  if (!t) return null;
  return { access_token: t.access_token, expires_at: t.expires_at ? new Date(t.expires_at) : null };
}

/** Guarda (o reemplaza) el token de un proveedor. expiresAt: Date|null. */
async function saveServiceToken(provider, accessToken, expiresAt) {
  const iso = expiresAt ? new Date(expiresAt).toISOString() : null;
  if (usePostgres) {
    await getPool().query(
      `INSERT INTO hub_service_tokens (provider, access_token, expires_at, updated_at)
       VALUES ($1,$2,$3,now())
       ON CONFLICT (provider) DO UPDATE SET access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [provider, accessToken, iso]
    );
  } else {
    jdb().service_tokens[provider] = { access_token: accessToken, expires_at: iso };
    jsave();
  }
}

// ---------------- v1.5.0: búsqueda semántica ----------------

function __setSemanticReadyForTests(v) { semanticReady = v; }

/** Guarda el embedding (vector de 1536) de un paquete. */
async function savePackageEmbedding(packageId, embedding) {
  if (usePostgres) {
    const vec = `[${embedding.join(',')}]`;
    await getPool().query('UPDATE hub_packages SET embedding = $1::vector WHERE package_id = $2', [vec, packageId]);
  } else {
    const p = jdb().packages[packageId];
    if (p) { p.embedding = embedding; jsave(); }
  }
}

/**
 * Paquetes más parecidos a un embedding.
 * Devuelve [{ package, score }] ordenados por score desc (coseno 0..1).
 */
async function searchSimilar({ embedding, limit = 8, source } = {}) {
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 8, 50));
  if (usePostgres) {
    if (!semanticReady) throw new Error('pgvector no disponible en la base de datos');
    const vec = `[${embedding.join(',')}]`;
    const vals = [vec];
    let cond = 'embedding IS NOT NULL';
    if (source) { vals.push(source); cond += ` AND source = $${vals.length}`; }
    vals.push(lim);
    const r = await getPool().query(
      `SELECT data, 1 - (embedding <=> $1::vector) AS score FROM hub_packages
       WHERE ${cond} ORDER BY embedding <=> $1::vector LIMIT $${vals.length}`,
      vals
    );
    return r.rows.map((x) => ({ package: x.data, score: Number(x.score) }));
  }
  // Backend JSON: coseno en JS (prototipo / pruebas).
  const { cosine } = require('./embeddings');
  let all = Object.values(jdb().packages).filter((p) => Array.isArray(p.embedding));
  if (source) all = all.filter((p) => p.source === source);
  return all
    .map((p) => ({ package: p, score: cosine(embedding, p.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, lim);
}

/** Paquetes sin embedding (para backfill). Devuelve [{ package_id, data }]. */
async function packagesMissingEmbeddings(limit = 50) {
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  if (usePostgres) {
    if (!semanticReady) throw new Error('pgvector no disponible en la base de datos');
    const r = await getPool().query(
      'SELECT package_id, data FROM hub_packages WHERE embedding IS NULL ORDER BY created_at DESC LIMIT $1',
      [lim]
    );
    return r.rows;
  }
  return Object.values(jdb().packages)
    .filter((p) => !Array.isArray(p.embedding))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, lim)
    .map((p) => ({ package_id: p.package_id, data: p }));
}

/** Total de paquetes con embedding (para estado). */
async function countEmbeddings() {
  if (usePostgres) {
    if (!semanticReady) return { total: 0, con_embedding: 0, listo: false };
    const r = await getPool().query('SELECT COUNT(*)::int AS total, COUNT(embedding)::int AS con FROM hub_packages');
    return { total: r.rows[0].total, con_embedding: r.rows[0].con, listo: true };
  }
  const all = Object.values(jdb().packages);
  return { total: all.length, con_embedding: all.filter((p) => Array.isArray(p.embedding)).length, listo: true };
}

module.exports = {
  backend: () => backend,
  init,
  newId,
  createJob,
  updateJob,
  getJob,
  listJobs,
  seenDedupeKey,
  savePackage,
  getPackage,
  listPackages,
  setPackageStatus,
  saveWaAlbum,
  getWaAlbum,
  listWaAlbums,
  lastWaAlbum,
  waMessageSeen,
  waMessageMark,
  getServiceToken,
  saveServiceToken,
  isSemanticReady,
  savePackageEmbedding,
  searchSimilar,
  packagesMissingEmbeddings,
  countEmbeddings,
  __setSemanticReadyForTests,
  __setPoolForTests,
};
