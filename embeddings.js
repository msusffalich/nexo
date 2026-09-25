'use strict';

/**
 * Búsqueda semántica y Q&A de NEXO (v1.5.0).
 *
 * - Embeddings con OpenAI text-embedding-3-small (1536 dims).
 * - Q&A con gpt-4o-mini: responde SOLO con los fragmentos recuperados y
 *   devuelve citas numeradas.
 * - Sin OPENAI_API_KEY, las funciones reportan { ok:false, reason:'sin_api_key' }
 *   y las rutas responden 503: nada se rompe, la extracción sigue igual.
 * - El valor de ningún token/secret sale en logs ni en respuestas.
 */

const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

let fetchForTests = null;
function __setFetchForTests(fn) { fetchForTests = fn; }
function http() { return fetchForTests || fetch; }

/** Texto que se vectoriza para un paquete. */
function packageText(pkg) {
  const parts = [
    pkg.text || '',
    `Fuente: ${pkg.source || ''}`,
    `Fecha: ${pkg.created_at || ''}`,
  ];
  const media = (pkg.media || []).map((m) => m.caption).filter(Boolean);
  if (media.length) parts.push(`Fotos: ${media.join(' | ')}`);
  return parts.join('\n').slice(0, 6000);
}

/**
 * Vectoriza una lista de textos. Devuelve { ok, vectors } o
 * { ok:false, reason }.
 */
async function embedTexts({ texts, apiKey, model } = {}) {
  if (!apiKey) return { ok: false, reason: 'sin_api_key' };
  const clean = (texts || []).map((t) => String(t || '').slice(0, 6000));
  if (!clean.length) return { ok: true, vectors: [] };
  const r = await http()(EMBED_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: model || 'text-embedding-3-small', input: clean }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j.data)) {
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    return { ok: false, reason: 'embed_fallido', detail: msg };
  }
  const vectors = j.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
  return { ok: true, vectors };
}

/**
 * Vectoriza un paquete y guarda su embedding. Nunca lanza: si no hay key
 * o falla la API, devuelve { ok:false, reason } y la extracción continúa.
 */
async function embedPackage(pkg, { store, apiKey, model } = {}) {
  try {
    const text = packageText(pkg);
    if (!text.trim()) return { ok: false, reason: 'sin_texto' };
    const r = await embedTexts({ texts: [text], apiKey, model });
    if (!r.ok) return r;
    await store.savePackageEmbedding(pkg.package_id, r.vectors[0]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'excepcion', detail: e.message };
  }
}

/** Similitud coseno en JS (backend JSON / pruebas). */
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const QA_SYSTEM = `Eres el asistente de memoria familiar de Miguel. Respondes en español.
Reglas estrictas:
- Responde SOLO con la información de los fragmentos numerados que recibes.
- Si la respuesta no está en los fragmentos, dilo claramente ("No encontré eso en tus recuerdos").
- Cita cada dato con el número del fragmento entre corchetes: [1], [2], etc.
- Sé breve y cálido. No inventes fechas, nombres ni lugares.`;

/**
 * Responde una pregunta con los fragmentos recuperados.
 * Devuelve { ok, answer } o { ok:false, reason }.
 */
async function answerQuestion({ question, hits, apiKey, model } = {}) {
  if (!apiKey) return { ok: false, reason: 'sin_api_key' };
  const frags = (hits || []).map((h, i) => {
    const p = h.package || h;
    const texto = String(p.text || '').slice(0, 1200);
    return `[${i + 1}] (${p.source || ''}, ${p.created_at || 'sin fecha'}) ${texto}`;
  });
  const user = `Pregunta: ${question}\n\nFragmentos:\n${frags.join('\n\n')}`;
  const r = await http()(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: 'system', content: QA_SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  const j = await r.json().catch(() => ({}));
  const answer = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!r.ok || !answer) {
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    return { ok: false, reason: 'qa_fallido', detail: msg };
  }
  return { ok: true, answer: answer.trim() };
}

/** Cita lista para el cliente: sin texto completo, solo referencia. */
function toCitation(hit, n) {
  const p = hit.package || hit;
  return {
    n,
    package_id: p.package_id,
    source: p.source,
    created_at: p.created_at,
    permalink: (p.metadata && p.metadata.permalink) || p.permalink || '',
    score: hit.score !== undefined ? Number(hit.score.toFixed(4)) : null,
    extracto: String(p.text || '').slice(0, 300),
  };
}

module.exports = {
  embedTexts,
  embedPackage,
  packageText,
  answerQuestion,
  toCitation,
  cosine,
  __setFetchForTests,
};
