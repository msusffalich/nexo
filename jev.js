'use strict';

/**
 * Cliente JEV (TypeSafe AI) — modelo de DECISIONES, no genera texto.
 *
 * NEXO lo usa como cerebro de decisiones rápidas sobre cada paquete:
 *   - choice -> clasifica la categoría temática con confianza
 *   - score  -> puntúa relevancia/calidad del contenido (0-100)
 *   - noul   -> puertas binarias: ¿duplicado probable? ¿entrega segura?
 *
 * Endpoint: POST {JEV_BASE_URL}/v1/systemone
 *   header: Authorization: Bearer <key>
 *   body:   { model, state, questions }  (state: texto o JSON; NO imágenes/audio/video)
 *
 * Env vars:
 *   TYPESAFE_API_KEY (canónica; alias JEV_API_KEY) — sin esto, decide() devuelve {ok:false,error:'sin_key'}
 *   JEV_MODEL      (default 'jev-latest')
 *   JEV_BASE_URL   (default 'https://api.typesafe.ai')
 *
 * JEV nunca bloquea la extracción: errores 401/422 se reportan sin reintentar,
 * 429/529 se reintentan con backoff, y cualquier fallo deja el paquete con sus
 * heurísticas locales intactas.
 */

const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_BASE_URL = 'https://api.typesafe.ai';

const CATEGORIAS = ['familia', 'viaje', 'comida', 'celebracion', 'trabajo', 'naturaleza', 'deporte', 'otro'];

/** Lee la configuración JEV (env o un objeto con las mismas claves). */
function cfgFromEnv(env) {
  env = env || process.env;
  return {
    key: env.TYPESAFE_API_KEY || env.JEV_API_KEY || '',
    model: env.JEV_MODEL || DEFAULT_MODEL,
    baseUrl: (env.JEV_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

/** Mapea la config general de NEXO (config.js) a la config JEV. */
function cfgFromAppConfig(c) {
  if (!c) return { key: '', model: DEFAULT_MODEL, baseUrl: DEFAULT_BASE_URL };
  const j = c.jev || {};
  return {
    key: j.key || '',
    model: j.model || DEFAULT_MODEL,
    baseUrl: (j.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  };
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Llama al endpoint systemone.
 * @param {string|object} state  contexto del paquete (texto o JSON)
 * @param {object} questions     mapa nombrado de primitivas choice/score/noul
 * @param {object} jevCfg        {key, model, baseUrl}
 * @param {function} fetchImpl   fetch inyectable (pruebas)
 * @returns {ok, answers?, usage?, elapsedMs?, error?, detail?}
 */
async function ask(state, questions, jevCfg, fetchImpl, opts) {
  const c = jevCfg || cfgFromEnv();
  if (!c.key) return { ok: false, error: 'sin_key' };
  const fetchFn = fetchImpl || fetch;
  const url = `${c.baseUrl}/v1/systemone`;
  const body = { model: c.model, state, questions };
  const maxAttempts = (opts && opts.retries) || 3;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const r = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${c.key}`,
        },
        body: JSON.stringify(body),
      });
      if ((r.status === 429 || r.status === 529) && attempt < maxAttempts) {
        await sleep(600 * attempt);
        continue;
      }
      if (r.status === 401) return { ok: false, error: 'no_autorizado' };
      if (r.status === 422) return { ok: false, error: 'pregunta_invalida' };
      if (!r.ok) return { ok: false, error: `http_${r.status}` };
      const j = await r.json();
      return { ok: true, answers: (j && j.answers) || {}, usage: j && j.usage, elapsedMs: j && j.elapsedMs };
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) await sleep(600 * attempt);
    }
  }
  return { ok: false, error: 'fallo_red', detail: String((lastErr && lastErr.message) || lastErr) };
}

// ---------- parseo defensivo de answers ----------

function numOf(a, keys, fallback) {
  if (a === null || a === undefined) return fallback;
  if (typeof a === 'number') return a;
  if (typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a))) return Number(a);
  if (typeof a === 'object') {
    for (const k of keys) {
      if (typeof a[k] === 'number') return a[k];
      if (typeof a[k] === 'string' && a[k].trim() !== '' && !Number.isNaN(Number(a[k]))) return Number(a[k]);
    }
  }
  return fallback;
}

function strOf(a, keys, fallback) {
  if (typeof a === 'string' && a) return a;
  if (a && typeof a === 'object') {
    for (const k of keys) {
      if (typeof a[k] === 'string' && a[k]) return a[k];
    }
  }
  return fallback;
}

function confOf(a, fallback) {
  return numOf(a, ['confidence', 'certainty', 'conf'], fallback);
}

/**
 * Decide sobre un paquete NEXO con las tres primitivas.
 * @param {object} pkg      paquete normalizado
 * @param {object} jevCfg   {key, model, baseUrl}
 * @param {function} fetchImpl
 * @returns {ok, decisions?|error?} decisions: {
 *   proveedor:'jev', modelo, categoria, categoria_confianza, relevancia,
 *   posible_duplicado_prob, entrega_segura_prob, confianzas }
 */
async function decide(pkg, jevCfg, fetchImpl, opts) {
  const c = jevCfg || cfgFromEnv();
  if (!c.key) return { ok: false, error: 'sin_key' };

  const state = JSON.stringify({
    fuente: pkg.source || '',
    autor: pkg.author_name || pkg.author_handle || '',
    fecha: pkg.created_at || '',
    texto: (pkg.text || '').slice(0, 4000),
    medios: (pkg.media || []).map((m) => m.kind).join(','),
  });

  const questions = {
    categoria: {
      type: 'choice',
      options: CATEGORIAS,
      instructions: '¿A qué categoría temática pertenece este contenido de red social?',
    },
    relevancia: {
      type: 'score',
      min: 0,
      max: 100,
      instructions: '¿Qué tan relevante o valioso es este contenido para conservarlo como recuerdo? 0 = nada, 100 = muy relevante.',
    },
    posible_duplicado: {
      type: 'noul',
      instructions: '¿Es probable que este contenido ya exista en la colección del usuario (duplicado)?',
    },
    entrega_segura: {
      type: 'noul',
      instructions: '¿Es seguro entregar este contenido automáticamente a la app de destino sin revisión humana?',
    },
  };

  const r = await ask(state, questions, c, fetchImpl, opts);
  if (!r.ok) return r;

  const a = r.answers || {};
  const categoria = strOf(a.categoria, ['value', 'choice', 'label'], 'otro');
  const categoriaValida = CATEGORIAS.includes(categoria) ? categoria : 'otro';
  const relevancia = Math.max(0, Math.min(100, Math.round(numOf(a.relevancia, ['value', 'score'], 50))));
  const posibleDup = numOf(a.posible_duplicado, ['value', 'probability', 'prob'], 0);
  const entregaSegura = numOf(a.entrega_segura, ['value', 'probability', 'prob'], 0.5);

  return {
    ok: true,
    decisions: {
      proveedor: 'jev',
      modelo: c.model,
      categoria: categoriaValida,
      categoria_confianza: confOf(a.categoria, 0),
      relevancia,
      relevancia_confianza: confOf(a.relevancia, 0),
      posible_duplicado_prob: posibleDup,
      entrega_segura_prob: entregaSegura,
      elapsed_ms: r.elapsedMs || null,
    },
  };
}

module.exports = { cfgFromEnv, cfgFromAppConfig, ask, decide, CATEGORIAS, DEFAULT_MODEL, DEFAULT_BASE_URL };
