'use strict';

/**
 * Renovación automática del token de usuario de Facebook (v1.4.0).
 *
 * El token de larga duración de Facebook vive 60 días. Este módulo:
 *  1. Resuelve el token vigente: el guardado en la BD (hub_service_tokens)
 *     tiene prioridad; si no hay, usa FACEBOOK_USER_TOKEN del entorno.
 *  2. Verifica su vigencia real con /debug_token (requiere FACEBOOK_APP_ID
 *     y FACEBOOK_APP_SECRET).
 *  3. Si vence dentro del margen (FB_TOKEN_REFRESH_MARGIN_DAYS, 7 por
 *     defecto), lo intercambia por uno nuevo de 60 días con
 *     grant_type=fb_exchange_token y lo guarda en la BD.
 *
 * El token NUNCA se expone en logs ni en respuestas HTTP: las rutas solo
 * informan estado (válido, días restantes, fuente).
 *
 * Sin FACEBOOK_APP_ID/SECRET la renovación automática queda desactivada y
 * el estado se reporta como "manual".
 */

const GRAPH = 'https://graph.facebook.com/v21.0';
const PROVIDER = 'facebook';

/** Llama a /debug_token y devuelve { valid, expires_at: Date|null, scopes }. */
async function debugToken({ token, appId, appSecret, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const qs = new URLSearchParams({
    input_token: token,
    access_token: `${appId}|${appSecret}`,
  }).toString();
  const r = await f(`${GRAPH}/debug_token?${qs}`);
  const j = await r.json().catch(() => ({}));
  const d = (j && j.data) || {};
  // expires_at = 0 significa que no expira (no es el caso de tokens de usuario).
  return {
    valid: d.is_valid === true,
    expires_at: d.expires_at ? new Date(d.expires_at * 1000) : null,
    scopes: Array.isArray(d.scopes) ? d.scopes : [],
    raw_error: d.error || null,
  };
}

/** Intercambia un token vigente por uno nuevo de ~60 días. */
async function exchangeToken({ token, appId, appSecret, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const qs = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: token,
  }).toString();
  const r = await f(`${GRAPH}/oauth/access_token?${qs}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    throw new Error(`exchange de token falló: ${msg}`);
  }
  return { access_token: j.access_token, expires_in: j.expires_in || 0 };
}

/** Token vigente para extracciones: BD primero, entorno como respaldo. */
async function getFacebookToken({ store, cfg } = {}) {
  try {
    const saved = await store.getServiceToken(PROVIDER);
    if (saved && saved.access_token) return saved.access_token;
  } catch { /* respaldo al entorno */ }
  return cfg.facebookToken || '';
}

/**
 * Asegura un token fresco. Devuelve un resumen SIN el valor del token:
 * { ok, refreshed, valid, expires_at (ISO|null), dias_restantes (n|null),
 *   fuente: 'db'|'env'|'ninguna', auto: bool, reason? }
 */
async function ensureFreshToken({ store, cfg, fetchImpl, logger, nowMs, marginDays } = {}) {
  const log = (logger && logger.info ? logger.info.bind(logger) : () => {});
  const now = nowMs || Date.now();
  const marginMs = (marginDays !== undefined ? marginDays : (cfg.fbTokenRefreshMarginDays || 7)) * 24 * 3600 * 1000;

  const saved = await store.getServiceToken(PROVIDER).catch(() => null);
  const token = (saved && saved.access_token) || cfg.facebookToken || '';
  const fuente = saved && saved.access_token ? 'db' : (cfg.facebookToken ? 'env' : 'ninguna');
  if (!token) {
    return { ok: false, refreshed: false, valid: false, expires_at: null, dias_restantes: null, fuente, auto: false, reason: 'sin_token' };
  }
  const auto = Boolean(cfg.facebookAppId && cfg.facebookAppSecret);
  if (!auto) {
    return { ok: true, refreshed: false, valid: null, expires_at: null, dias_restantes: null, fuente, auto: false, reason: 'manual_sin_credenciales_app' };
  }

  let dbg;
  try {
    dbg = await debugToken({ token, appId: cfg.facebookAppId, appSecret: cfg.facebookAppSecret, fetchImpl });
  } catch (e) {
    return { ok: false, refreshed: false, valid: false, expires_at: null, dias_restantes: null, fuente, auto: true, reason: 'debug_fallido', detail: e.message };
  }
  if (!dbg.valid) {
    return { ok: false, refreshed: false, valid: false, expires_at: null, dias_restantes: null, fuente, auto: true, reason: 'token_invalido' };
  }
  const expiresAt = dbg.expires_at;
  const dias = expiresAt ? Math.floor((expiresAt.getTime() - now) / (24 * 3600 * 1000)) : null;
  if (!expiresAt || (expiresAt.getTime() - now) > marginMs) {
    // Si el token vigente no estaba en BD, lo registramos con su vigencia real.
    if (fuente === 'env' && expiresAt) {
      await store.saveServiceToken(PROVIDER, token, expiresAt).catch(() => {});
    }
    return { ok: true, refreshed: false, valid: true, expires_at: expiresAt ? expiresAt.toISOString() : null, dias_restantes: dias, fuente, auto: true };
  }

  // Dentro del margen: renovar.
  try {
    const fresh = await exchangeToken({ token, appId: cfg.facebookAppId, appSecret: cfg.facebookAppSecret, fetchImpl });
    const newExpires = new Date(now + (fresh.expires_in || 5184000) * 1000);
    await store.saveServiceToken(PROVIDER, fresh.access_token, newExpires);
    log(`Token de Facebook renovado; expira ${newExpires.toISOString()}`);
    return { ok: true, refreshed: true, valid: true, expires_at: newExpires.toISOString(), dias_restantes: Math.floor((fresh.expires_in || 5184000) / 86400), fuente: 'db', auto: true };
  } catch (e) {
    return { ok: false, refreshed: false, valid: true, expires_at: expiresAt.toISOString(), dias_restantes: dias, fuente, auto: true, reason: 'exchange_fallido', detail: e.message };
  }
}

module.exports = { debugToken, exchangeToken, getFacebookToken, ensureFreshToken, PROVIDER };
