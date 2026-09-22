'use strict';

/**
 * Fuente Facebook: lee posts y fotos de la cuenta propia vía Graph API.
 *
 * Requiere FACEBOOK_USER_TOKEN (token de usuario de larga duración generado
 * en Graph API Explorer con permisos user_posts y user_photos).
 * Solo accede a la cuenta propia de Miguel: es lo que la API oficial permite.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graphGet(path, params, token, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const r = await fetchFn(`${GRAPH}${path}?${qs}`);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Graph API ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * Trae posts propios en el rango [since, until] (YYYY-MM-DD).
 * Devuelve ítems crudos { source, source_id, created_at, text, permalink, media[] }.
 */
async function fetchPosts({ token, since, until, maxPages = 5, fetchImpl } = {}) {
  if (!token) throw new Error('FACEBOOK_USER_TOKEN no configurado');
  const items = [];
  let url = null;
  let page = 0;
  let params = {
    fields: 'id,message,created_time,permalink_url,full_picture,attachments{media_type,media,url}',
    since, until, limit: 50,
  };
  while (page < maxPages) {
    const j = url
      ? await (await (fetchImpl || fetch)(url)).json()
      : await graphGet('/me/posts', params, token, fetchImpl);
    for (const p of j.data || []) {
      const media = [];
      const atts = (p.attachments && p.attachments.data) || [];
      for (const a of atts) {
        const m = a.media && a.media.image;
        if (m && m.src) media.push({ kind: 'image', url: m.src, caption: '' });
      }
      if (p.full_picture && !media.length) {
        media.push({ kind: 'image', url: p.full_picture, caption: '' });
      }
      items.push({
        source: 'facebook',
        source_id: p.id,
        created_at: p.created_time,
        text: p.message || '',
        permalink: p.permalink_url || '',
        media,
      });
    }
    const next = j.paging && j.paging.next;
    if (!next) break;
    url = next;
    page += 1;
  }
  return items;
}

/** Trae fotos propias publicadas en el rango. */
async function fetchPhotos({ token, since, until, maxPages = 5, fetchImpl } = {}) {
  if (!token) throw new Error('FACEBOOK_USER_TOKEN no configurado');
  const items = [];
  let url = null;
  let page = 0;
  while (page < maxPages) {
    const j = url
      ? await (await (fetchImpl || fetch)(url)).json()
      : await graphGet('/me/photos', {
          fields: 'id,created_time,link,name,images', since, until, limit: 50,
        }, token, fetchImpl);
    for (const p of j.data || []) {
      const best = (p.images || [])[0];
      items.push({
        source: 'facebook',
        source_id: p.id,
        created_at: p.created_time,
        text: p.name || '',
        permalink: p.link || '',
        media: best ? [{ kind: 'image', url: best.source, caption: p.name || '' }] : [],
      });
    }
    const next = j.paging && j.paging.next;
    if (!next) break;
    url = next;
    page += 1;
  }
  return items;
}

module.exports = { fetchPosts, fetchPhotos };
