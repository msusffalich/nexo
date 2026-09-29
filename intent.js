'use strict';

/**
 * Intérprete de comandos en lenguaje natural de NEXO.
 * Estilo del Asistente Puente: normaliza (minúsculas, sin tildes) y puntúa.
 *
 * Comandos soportados:
 *   - extracción: "tráeme mis fotos de instagram de marzo", "extrae mis posts
 *     de facebook del 1 al 15 de enero", "jala mis videos de ig de esta semana"
 *   - estado: "cómo van mis extracciones", "estado"
 *   - ayuda: "ayuda", "qué puedes hacer"
 *
 * Devuelve { intent, source, kind, from, to, score }.
 * Fechas en ISO (YYYY-MM-DD). Rango por defecto: últimos 30 días.
 */

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, setiembre: 9, septiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

function limaToday() {
  // Fecha actual en America/Lima como YYYY-MM-DD
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' });
  return fmt.format(new Date());
}

function iso(y, m, d) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function addDays(isoDate, n) {
  const d = new Date(isoDate + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Extrae { from, to } de un texto normalizado. */
function parseRange(t) {
  const today = limaToday();
  const [ty, tm] = today.split('-').map(Number);

  // "del 3 al 10 de marzo [de 2026]"
  let m = t.match(/del (\d{1,2}) al (\d{1,2}) de ([a-z]+)(?: de (\d{4}))?/);
  if (m && MESES[m[3]]) {
    const y = m[4] ? parseInt(m[4], 10) : ty;
    return { from: iso(y, MESES[m[3]], parseInt(m[1], 10)), to: iso(y, MESES[m[3]], parseInt(m[2], 10)) };
  }
  // "entre el 1 y el 15 de enero [de 2026]"
  m = t.match(/entre el (\d{1,2}) y el (\d{1,2}) de ([a-z]+)(?: de (\d{4}))?/);
  if (m && MESES[m[3]]) {
    const y = m[4] ? parseInt(m[4], 10) : ty;
    return { from: iso(y, MESES[m[3]], parseInt(m[1], 10)), to: iso(y, MESES[m[3]], parseInt(m[2], 10)) };
  }
  // "marzo [de 2026]" / "de marzo": buscar la ÚLTIMA palabra que sea un mes
  // (el primer match ingenuo cae en palabras como "traeme")
  let monthMatch = null;
  for (const mm of t.matchAll(/(?:^| )(de |del mes de )?([a-z]+)( de (\d{4}))?(?= |$)/g)) {
    if (MESES[mm[2]]) monthMatch = mm;
  }
  if (monthMatch) {
    const mo = MESES[monthMatch[2]];
    const y = monthMatch[4] ? parseInt(monthMatch[4], 10) : ty;
    // Si el mes mencionado es futuro respecto a hoy y no se dio año, usar el año pasado
    const yy = (!monthMatch[4] && mo > tm) ? ty - 1 : y;
    return { from: iso(yy, mo, 1), to: iso(yy, mo, lastDayOfMonth(yy, mo)) };
  }
  if (/\besta semana\b/.test(t)) return { from: addDays(today, -7), to: today };
  if (/\beste mes\b/.test(t)) return { from: iso(ty, tm, 1), to: today };
  if (/\beste ano\b/.test(t)) return { from: iso(ty, 1, 1), to: today };
  if (/\bhoy\b/.test(t)) return { from: today, to: today };
  if (/\bayer\b/.test(t)) { const y = addDays(today, -1); return { from: y, to: y }; }
  m = t.match(/ultimos (\d{1,3}) dias/);
  if (m) return { from: addDays(today, -parseInt(m[1], 10)), to: today };
  // Por defecto: últimos 30 días
  return { from: addDays(today, -30), to: today };
}

function detectSource(t) {
  if (/\binstagram\b|\big\b/.test(t)) return 'instagram';
  if (/\bfacebook\b|\bface\b|\bfb\b/.test(t)) return 'facebook';
  if (/\bwhatsapp\b/.test(t)) return 'whatsapp';
  return null;
}

function detectKind(t) {
  if (/\bfotos?\b|\bimagenes\b|\bfotitos\b/.test(t)) return 'fotos';
  if (/\bvideos?\b/.test(t)) return 'videos';
  if (/\bposts?\b|\bpublicaciones\b/.test(t)) return 'posts';
  return 'todo'; // fotos + posts
}

const EXTRACT_PHRASES = [
  'extrae', 'extraeme', 'trae', 'traeme', 'busca', 'buscame', 'jala', 'jalame',
  'dame', 'consigueme', 'recopila', 'reune', 'reuneme', 'descarga', 'descargame',
  'saca', 'sacame', 'quiero ver', 'muestrame',
];

function scoreExtract(t) {
  let s = 0;
  for (const p of EXTRACT_PHRASES) {
    if (new RegExp(`\\b${p}\\b`).test(t)) s += 4;
  }
  if (detectSource(t)) s += 4;
  if (/\bfotos?\b|\bposts?\b|\bvideos?\b|\bpublicaciones\b|\bimagenes\b/.test(t)) s += 2;
  return s;
}

function parseCommand(text) {
  const t = normalize(text);
  const out = { intent: 'desconocido', score: 0 };

  if (/\bayuda\b|\bque puedes hacer\b|\bque sabes hacer\b|\bcomo funciona/.test(t)) {
    return { ...out, intent: 'ayuda', score: 8 };
  }
  if (/\bestado\b|\bcomo van\b|\bmis extracciones\b|\bmis trabajos\b|\bque tienes\b/.test(t)) {
    return { ...out, intent: 'estado', score: 8 };
  }

  const s = scoreExtract(t);
  if (s >= 6) {
    const source = detectSource(t);
    if (!source) return { ...out, intent: 'extraer', score: s, error: 'fuente_no_detectada' };
    if (source === 'whatsapp') {
      return { ...out, intent: 'extraer', score: s, source, error: 'whatsapp_fase_2' };
    }
    const { from, to } = parseRange(t);
    return { ...out, intent: 'extraer', score: s, source, kind: detectKind(t), from, to };
  }
  return out;
}

module.exports = { parseCommand, normalize, parseRange, limaToday, MESES };
