'use strict';

/**
 * Adaptador Taller (estudio creativo bilingüe).
 * Habla con el puente de Taller en {TALLER_URL}/api/bridge/* con header
 * x-bridge-key (mismo patrón que el adaptador de Legado Vivo).
 *
 * Requiere: TALLER_URL, TALLER_BRIDGE_KEY.
 * Sin ellas, las llamadas devuelven { ok:false, error:'pendiente_config' }.
 */

const crypto = require('node:crypto');

function bridgeConfig(cfg) {
  return {
    baseUrl: (cfg.tallerUrl || '').replace(/\/+$/, ''),
    apiKey: cfg.tallerKey || '',
  };
}

function bridgeEnabled(cfg) {
  const c = bridgeConfig(cfg);
  return Boolean(c.baseUrl && c.apiKey);
}

/** UUID determinista (v5-like) desde un texto: idempotencia en reintentos. */
function uuidFromString(s) {
  const h = crypto.createHash('sha1').update(String(s)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function call(cfg, path, { method = 'GET', body } = {}, hooks = {}) {
  if (!bridgeEnabled(cfg)) {
    return { ok: false, error: 'pendiente_config', detail: 'Faltan TALLER_URL o TALLER_BRIDGE_KEY' };
  }
  const c = bridgeConfig(cfg);
  const fetchFn = hooks.fetchImpl || fetch;
  let r;
  try {
    r = await fetchFn(`${c.baseUrl}/api/bridge${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-bridge-key': c.apiKey,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return { ok: false, error: 'taller_unreachable', detail: String(e && e.message || e).slice(0, 200) };
  }
  let data = null;
  try { data = await r.json(); } catch { /* cuerpo no-JSON */ }
  if (!r.ok) {
    const code = (data && data.error && data.error.code) || `taller_${r.status}`;
    return { ok: false, error: code, detail: JSON.stringify(data).slice(0, 300) };
  }
  return { ok: true, status: r.status, data };
}

const status = (cfg, hooks) => call(cfg, '/status', {}, hooks);
const listIdeas = (cfg, hooks) => call(cfg, '/ideas', {}, hooks);
const deleteIdea = (cfg, id, hooks) => call(cfg, `/ideas/${encodeURIComponent(id)}`, { method: 'DELETE' }, hooks);
const convertIdea = (cfg, id, hooks) => call(cfg, `/ideas/${encodeURIComponent(id)}/convert`, { method: 'POST', body: {} }, hooks);
const listProjects = (cfg, hooks) => call(cfg, '/projects', {}, hooks);
const getProject = (cfg, id, hooks) => call(cfg, `/projects/${encodeURIComponent(id)}`, {}, hooks);
const projectEntries = (cfg, id, hooks) => call(cfg, `/projects/${encodeURIComponent(id)}/entries`, {}, hooks);
const assistantHistory = (cfg, limit = 50, hooks) => call(cfg, `/assistant/messages?limit=${limit}`, {}, hooks);
const exportAll = (cfg, hooks) => call(cfg, '/export', {}, hooks);

async function createIdea(cfg, { title, hobby, body, requestKey }, hooks) {
  return call(cfg, '/ideas', {
    method: 'POST',
    body: {
      title: String(title || '').slice(0, 160),
      hobby: String(hobby || 'other').slice(0, 60),
      body: String(body || '').slice(0, 6000),
      ...(requestKey ? { requestKey } : {}),
    },
  }, hooks);
}

async function createProject(cfg, { title, hobby, description, status: st, steps, materials }, hooks) {
  return call(cfg, '/projects', {
    method: 'POST',
    body: {
      title: String(title || '').slice(0, 160),
      hobby: String(hobby || 'other').slice(0, 60),
      description: String(description || '').slice(0, 6000),
      ...(st ? { status: st } : {}),
      ...(steps ? { steps } : {}),
      ...(materials ? { materials } : {}),
    },
  }, hooks);
}

async function updateProject(cfg, id, data, hooks) {
  return call(cfg, `/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }, hooks);
}

async function chat(cfg, { message, mode, projectId, language }, hooks) {
  const m = String(message || '').trim();
  if (!m) return { ok: false, error: 'message_requerido' };
  return call(cfg, '/assistant', {
    method: 'POST',
    body: {
      message: m.slice(0, 4000),
      mode: ['chat', 'review', 'plan'].includes(mode) ? mode : 'chat',
      ...(projectId ? { projectId } : {}),
      ...(language ? { language } : {}),
    },
  }, hooks);
}

/**
 * Entrega un paquete del Hub a Taller como idea (la "bandeja de entrada"
 * creativa). Idempotente: requestKey determinista desde el package_id, así
 * los reintentos no duplican la idea.
 */
async function deliverIdea(pkg, cfg, hooks = {}) {
  if (!bridgeEnabled(cfg)) {
    return { ok: false, error: 'pendiente_config', detail: 'Faltan TALLER_URL o TALLER_BRIDGE_KEY' };
  }
  const summary = (pkg.metadata && pkg.metadata.summary) || '';
  const text = pkg.text || summary || '';
  const title = (summary || text.split('\n')[0] || 'Contenido de NEXO').trim().slice(0, 160) || 'Contenido de NEXO';
  const hobby = (pkg.metadata && pkg.metadata.hobby) || 'other';
  const body = text.slice(0, 5900) + (text.length > 5900 ? '\n…(recortado)' : '');
  const r = await createIdea(cfg, {
    title,
    hobby,
    body,
    requestKey: uuidFromString(`nexo-taller:${pkg.package_id}`),
  }, hooks);
  if (!r.ok) return r;
  return { ok: true, ideaId: r.data && r.data.id, deduped: !!(r.data && r.data.deduped) };
}

module.exports = {
  bridgeEnabled,
  bridgeConfig,
  uuidFromString,
  status,
  listIdeas,
  createIdea,
  deleteIdea,
  convertIdea,
  listProjects,
  createProject,
  getProject,
  updateProject,
  projectEntries,
  chat,
  assistantHistory,
  exportAll,
  deliverIdea,
};
