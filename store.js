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
  return { jobs: {}, packages: {}, seen: {}, seq: 0 };
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
`;

async function init() {
  if (!usePostgres) return { backend };
  await getPool().query(SCHEMA_SQL);
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
  __setPoolForTests,
};
