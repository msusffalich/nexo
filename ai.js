'use strict';

/**
 * Capa IA de NEXO: clasificar, resumir, etiquetar.
 *
 * Funciona SIEMPRE con heurísticas locales (sin costo, sin red).
 * Si existe OPENAI_API_KEY, mejora el resumen con un modelo de lenguaje.
 * Nunca falla la extracción por un fallo de IA: ante error, usa heurística.
 */

const STOPWORDS = new Set(
  'de la el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este esta si porque cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos esto mi antes algunos que nos'.split(' ')
);

const CATEGORIAS = [
  { name: 'familia', words: ['familia', 'hijo', 'hija', 'padre', 'madre', 'abuelo', 'abuela', 'hermano', 'hermana', 'esposa', 'esposo', 'nieto', 'tio', 'tia', 'primo', 'sobrino', 'bebe', 'cumpleanos'] },
  { name: 'viaje', words: ['viaje', 'viajando', 'vacaciones', 'aeropuerto', 'avion', 'playa', 'montana', 'ciudad', 'hotel', 'turismo', 'paseo', 'excursion', 'maleta'] },
  { name: 'comida', words: ['comida', 'almuerzo', 'cena', 'desayuno', 'receta', 'restaurante', 'ceviche', 'lomo', 'pollo', 'postre', 'cocina', 'plato', 'menu'] },
  { name: 'celebracion', words: ['fiesta', 'celebracion', 'cumpleanos', 'aniversario', 'boda', 'graduacion', 'navidad', 'ano nuevo', 'brindis', 'festejo'] },
  { name: 'trabajo', words: ['trabajo', 'oficina', 'reunion', 'proyecto', 'negocio', 'empresa', 'cliente', 'equipo'] },
  { name: 'naturaleza', words: ['naturaleza', 'paisaje', 'atardecer', 'amanecer', 'mar', 'rio', 'bosque', 'jardin', 'flor', 'mascota', 'perro', 'gato'] },
  { name: 'deporte', words: ['deporte', 'futbol', 'partido', 'correr', 'gimnasio', 'entrenamiento', 'carrera', 'gol'] },
];

function norm(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Clasifica el texto en una categoría temática. */
function classify(text) {
  const t = ' ' + norm(text) + ' ';
  let best = { name: 'otro', score: 0 };
  for (const c of CATEGORIAS) {
    let score = 0;
    for (const w of c.words) {
      if (t.includes(w)) score += 1;
    }
    if (score > best.score) best = { name: c.name, score };
  }
  return best.name;
}

/** Etiquetas: palabras significativas más frecuentes (máx. 6). */
function tag(text, max = 6) {
  const freq = {};
  for (const w of norm(text).split(/[^a-z]+/)) {
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

/** Resumen heurístico: primeras 2 frases, máx. 220 caracteres. */
function heuristicSummary(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  return sentences.length > 220 ? sentences.slice(0, 217) + '...' : sentences;
}

async function openaiSummary(text, apiKey, fetchImpl) {
  const fetchFn = fetchImpl || fetch;
  const r = await fetchFn('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 120,
      messages: [
        { role: 'system', content: 'Resume en español, en una sola frase de máximo 25 palabras, el siguiente contenido de red social.' },
        { role: 'user', content: (text || '').slice(0, 1500) },
      ],
    }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  return (j.choices && j.choices[0] && j.choices[0].message.content || '').trim();
}

/** Resumen: OpenAI si hay clave, heurística si no (o si falla). */
async function summarize(text, apiKey, fetchImpl) {
  if (apiKey) {
    try {
      const s = await openaiSummary(text, apiKey, fetchImpl);
      if (s) return s;
    } catch {
      // cae a heurística
    }
  }
  return heuristicSummary(text);
}

/** Enriquece un paquete con categoría, etiquetas y resumen. */
async function enrich(pkg, apiKey, fetchImpl) {
  const text = pkg.text || '';
  pkg.metadata = pkg.metadata || {};
  pkg.metadata.category = classify(text);
  pkg.metadata.tags = tag(text);
  pkg.metadata.summary = await summarize(text, apiKey, fetchImpl);
  return pkg;
}

module.exports = { classify, tag, heuristicSummary, summarize, enrich };
