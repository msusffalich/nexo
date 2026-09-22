'use strict';

/**
 * CLI de NEXO: permite operarlo desde el chat con Muse sin HTTP.
 * Usa el mismo store y los mismos trabajos que el servidor.
 *
 *   node cli.js extraer "tráeme mis fotos de instagram de marzo"
 *   node cli.js estado
 *   node cli.js paquetes [--source=instagram] [--limit=10]
 *   node cli.js ver <package_id>
 *   node cli.js entregar <package_id> legado-vivo
 *   node cli.js importar-whatsapp <archivo.txt> [--chat=Nombre del chat]
 */

const fs = require('node:fs');
const store = require('./store');
const { cfg } = require('./config');
const { parseCommand } = require('./intent');
const jobs = require('./jobs');
const { toPackage } = require('./normalize');
const ai = require('./ai');
const legado = require('./adapters/legado');
const { parseExport } = require('./whatsapp-export');

function arg(name) {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : null;
}

function brief(p) {
  const md = p.metadata || {};
  return `${p.package_id} | ${p.source} | ${(p.created_at || '').slice(0, 10)} | ${(md.category || '')} | ${(md.summary || p.text || '').slice(0, 70)}`;
}

async function main() {
  const c = cfg();
  await store.init();
  const cmd = process.argv[2];

  if (cmd === 'extraer') {
    const text = process.argv.slice(3).join(' ');
    const parsed = parseCommand(text);
    if (parsed.intent !== 'extraer' || parsed.error) {
      console.log(JSON.stringify({ ok: false, interpretacion: parsed }, null, 2));
      process.exit(2);
    }
    console.log(`Interpretado: ${parsed.source} / ${parsed.kind} / ${parsed.from} → ${parsed.to}`);
    const { job_id, stats } = await jobs.extraer(
      { source: parsed.source, kind: parsed.kind, from: parsed.from, to: parsed.to, target_apps: [] },
      c
    );
    console.log(JSON.stringify({ ok: true, job_id, stats }, null, 2));
    return;
  }

  if (cmd === 'estado') {
    const list = await store.listJobs(10);
    for (const j of list) {
      console.log(`${j.id} | ${j.type} | ${j.status} | ${JSON.stringify(j.params)} | ${JSON.stringify(j.result)}`);
    }
    return;
  }

  if (cmd === 'paquetes') {
    const list = await store.listPackages({
      source: arg('source') || undefined,
      limit: parseInt(arg('limit') || '20', 10),
    });
    for (const p of list) console.log(brief(p));
    console.log(`Total: ${list.length}`);
    return;
  }

  if (cmd === 'ver') {
    const p = await store.getPackage(process.argv[3]);
    console.log(JSON.stringify(p, null, 2));
    return;
  }

  if (cmd === 'entregar') {
    const p = await store.getPackage(process.argv[3]);
    if (!p) { console.log(JSON.stringify({ ok: false, error: 'paquete no existe' })); process.exit(2); }
    const app = process.argv[4] || 'legado-vivo';
    if (app !== 'legado-vivo') { console.log(JSON.stringify({ ok: false, error: `adaptador no soportado: ${app}` })); process.exit(2); }
    const r = await legado.deliver(p, c);
    console.log(JSON.stringify(r, null, 2));
    if (r.ok) await store.setPackageStatus(p.package_id, 'entregado_legado');
    return;
  }

  if (cmd === 'importar-whatsapp') {
    const file = process.argv[3];
    const text = fs.readFileSync(file, 'utf8');
    const items = parseExport(text, { chatName: arg('chat') || 'chat' });
    let nuevos = 0;
    for (const raw of items) {
      const pkg = toPackage(raw, null, null);
      if (await store.seenDedupeKey(pkg.metadata.dedupe_key)) continue;
      await ai.enrich(pkg, c.openaiKey, undefined, { jev: c.jev });
      pkg.target_apps = ['legado-vivo', 'momentos'];
      await store.savePackage(pkg);
      nuevos += 1;
    }
    console.log(JSON.stringify({ ok: true, mensajes: items.length, nuevos }, null, 2));
    return;
  }

  console.log('NEXO — Uso: node cli.js extraer "..." | estado | paquetes | ver <id> | entregar <id> legado-vivo | importar-whatsapp <archivo.txt>');
  process.exit(2);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
