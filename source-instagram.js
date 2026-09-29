'use strict';

/**
 * Fuente Instagram: lee el contenido propio vía Instagram Graph API.
 *
 * Requiere:
 *   FACEBOOK_USER_TOKEN  (token con permisos instagram_basic)
 *   INSTAGRAM_USER_ID    (id numérico de la cuenta de IG)
 *
 * LÍMITE HONESTO: la API oficial solo funciona si la cuenta de Instagram es
 * de empresa o de creador y está vinculada a una página de Facebook.
 * Si @msusffalich es cuenta personal, hay que convertirla primero
 * (paso documentado en el README). Sin eso, esta fuente queda inactiva.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graphGet(path, params, token, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const r = await fetchFn(`${GRAPH}${path}?${qs}`);
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Instagram Graph API ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchChildren(mediaId, token, fetchImpl) {
  const j = await graphGet(`/${mediaId}/children`, { fields: 'id,media_type,media_url,thumbnail_url' }, token, fetchImpl);
  return j.data || [];
}

/**
 * Trae el contenido propio en el rango [since, until] (YYYY-MM-DD).
 * kind: 'fotos' | 'videos' | 'todo'
 */
async function fetchMedia({ token, igUserId, since, until, kind = 'todo', maxPages = 5, fetchImpl } = {}) {
  if (!token) throw new Error('FACEBOOK_USER_TOKEN no configurado');
  if (!igUserId) throw new Error('INSTAGRAM_USER_ID no configurado');
  const items = [];
  let url = null;
  let page = 0;
  while (page < maxPages) {
    const j = url
      ? await (await (fetchImpl || fetch)(url)).json()
      : await graphGet(`/${igUserId}/media`, {
          fields: 'id,caption,media_type,media_url,thumbnail_url,timestamp,permalink',
          since, until, limit: 50,
        }, token, fetchImpl);
    for (const m of j.data || []) {
      const isVideo = m.media_type === 'VIDEO';
      const isCarousel = m.media_type === 'CAROUSEL_ALBUM';
      if (kind === 'fotos' && isVideo) continue;
      if (kind === 'videos' && !isVideo && !isCarousel) continue;
      const media = [];
      if (isCarousel) {
        const children = await fetchChildren(m.id, token, fetchImpl).catch(() => []);
        for (const c of children) {
          media.push({
            kind: c.media_type === 'VIDEO' ? 'video' : 'image',
            url: c.media_url || c.thumbnail_url,
            caption: '',
          });
        }
      } else {
        media.push({ kind: isVideo ? 'video' : 'image', url: m.media_url || m.thumbnail_url, caption: '' });
      }
      items.push({
        source: 'instagram',
        source_id: m.id,
        created_at: m.timestamp,
        text: m.caption || '',
        permalink: m.permalink || '',
        media: media.filter((x) => x.url),
      });
    }
    const next = j.paging && j.paging.next;
    if (!next) break;
    url = next;
    page += 1;
  }
  return items;
}

module.exports = { fetchMedia };
