'use strict';

/**
 * Adaptador Legado Vivo (mismo contrato del Asistente Puente v5).
 * Envía un paquete del Hub como borrador a POST {LEGADO_VIVO_URL}/api/bridge/drafts
 * con header x-bridge-key.
 *
 * Requiere: LEGADO_VIVO_URL, BRIDGE_API_KEY, LEGADO_FAMILY_ID.
 * Sin ellas, la entrega queda marcada como 'pendiente_config'.
 */

function bridgeConfig(cfg) {
  return {
    baseUrl: cfg.legadoUrl || '',
    apiKey: cfg.legadoKey || '',
    familyId: cfg.legadoFamilyId || 0,
  };
}

function bridgeEnabled(cfg) {
  const c = bridgeConfig(cfg);
  return Boolean(c.baseUrl && c.apiKey && c.familyId);
}

async function downloadAsBase64(url, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`Descarga ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const filename = (url.split('/').pop() || 'archivo').split('?')[0];
  return { base64: buf.toString('base64'), filename };
}

/**
 * Entrega un paquete a Legado Vivo. Devuelve { ok, draftId } o { ok:false, error }.
 */
async function deliver(pkg, cfg, hooks = {}) {
  if (!bridgeEnabled(cfg)) {
    return { ok: false, error: 'pendiente_config', detail: 'Faltan LEGADO_VIVO_URL, BRIDGE_API_KEY o LEGADO_FAMILY_ID' };
  }
  const c = bridgeConfig(cfg);
  const fetchFn = hooks.fetchImpl || fetch;

  let photoBase64;
  let photoFilename;
  const firstImage = (pkg.media || []).find((m) => m.kind === 'image' && m.url);
  if (firstImage && !cfg.dryRun) {
    try {
      const dl = await downloadAsBase64(firstImage.url, fetchFn);
      photoBase64 = dl.base64;
      photoFilename = dl.filename;
    } catch {
      // sin foto: el borrador igual viaja con el texto
    }
  }

  const summary = (pkg.metadata && pkg.metadata.summary) || '';
  const title = (summary || (pkg.text || '').split('\n')[0] || 'Contenido de NEXO').slice(0, 80);
  const body = {
    draftId: `nexo-${pkg.package_id}`,
    familyId: c.familyId,
    title,
    text: pkg.text || summary,
    transcription: '',
    people: [],
    photoBase64,
    photoFilename,
  };

  const r = await fetchFn(`${c.baseUrl}/api/bridge/drafts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-key': c.apiKey },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { ok: false, error: `legado_${r.status}`, detail: t.slice(0, 200) };
  }
  return { ok: true, draftId: body.draftId };
}

module.exports = { deliver, bridgeEnabled };
