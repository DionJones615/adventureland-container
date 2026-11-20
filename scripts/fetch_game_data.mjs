#!/usr/bin/env node
// Fetch the live Adventure Land game data (https://adventure.land/data.js) and split it
// into per-section JSON files, so the snapshot is diffable and addressable without a 2.8 MB
// one-line blob. Writes reference/game-data/{raw/data.js,sections/*.json,index.json}.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'reference', 'game-data');
const DATA_URL = process.env.AL_DATA_URL || 'https://adventure.land/data.js';
const UA = 'adventureland-research/1.0 (+https://adventure.land; reference corpus build)';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

console.log('[fetch_game_data] GET ' + DATA_URL);
const res = await fetch(DATA_URL, { headers: { 'user-agent': UA, accept: '*/*' } });
if (!res.ok) {
  throw new Error('data.js fetch failed: HTTP ' + res.status + ' ' + res.statusText);
}
const raw = Buffer.from(await res.arrayBuffer());
const text = raw.toString('utf8');

// The live file is a single line: var G={...};
const marker = text.indexOf('=');
if (marker < 0 || !text.trimStart().startsWith('var G')) {
  throw new Error('unexpected data.js shape: expected it to start with "var G=". ' +
    'Format drift upstream - raw bytes kept at reference/game-data/raw/data.js for inspection.');
}
let parsed;
const body = text.slice(marker + 1).trim().replace(/;\s*$/, '');
try {
  parsed = JSON.parse(body);
} catch (err) {
  const at = /position (\d+)/.exec(err.message || '');
  const offset = at ? Number(at[1]) : -1;
  const around = offset >= 0 ? body.slice(Math.max(0, offset - 120), offset + 120) : '';
  throw new Error('data.js is not valid JSON at offset ' + offset + ': ' + err.message +
    '\n...context...\n' + around);
}

const generatedAt = new Date().toISOString();
const sectionsDir = path.join(OUT, 'sections');
const rawDir = path.join(OUT, 'raw');
await mkdir(sectionsDir, { recursive: true });
await mkdir(rawDir, { recursive: true });
await writeFile(path.join(rawDir, 'data.js'), raw);

const index = {
  gameVersion: parsed.version,
  fetchedAt: generatedAt,
  source: { url: DATA_URL, bytes: raw.length, sha256: sha256(raw) },
  sections: {},
};

const names = Object.keys(parsed).sort();
for (const name of names) {
  const value = parsed[name];
  const isObject = value && typeof value === 'object' && !Array.isArray(value);
  const count = Array.isArray(value) ? value.length : isObject ? Object.keys(value).length : 1;
  const serialized = JSON.stringify(value, null, 1) + '\n';
  const fileName = name.endsWith('.json') ? name : name + '.json';
  await writeFile(path.join(sectionsDir, fileName), serialized);
  index.sections[name] = {
    count,
    bytes: Buffer.byteLength(serialized),
    sha256: sha256(serialized),
  };
}

// Convenience derived views used by scripts/lookup.mjs and by humans reading the corpus.
const items = parsed.items || {};
const itemIndex = {};
for (const [key, item] of Object.entries(items)) {
  itemIndex[key] = { name: item.name, type: item.type || null, level: item.level ?? null, grade: item.grade ?? null };
}
await writeFile(path.join(sectionsDir, 'item-index.json'), JSON.stringify(itemIndex, null, 1) + '\n');

// Drop tables are WEIGHTED ARRAYS: [weight, itemKey, quantity?]. The top-level keys mix monsters
// (drops.monsters.*) with chest, exchange and event tables, so flatten one level and add the
// approximate probability inside each table (weight / sum of weights).
const drops = parsed.drops || {};
const rawTables = {};
for (const [key, value] of Object.entries(drops)) {
  if (key === 'monsters' && value && typeof value === 'object') {
    for (const [monster, table] of Object.entries(value)) rawTables['monster:' + monster] = table;
  } else {
    rawTables['table:' + key] = value;
  }
}
const flatDrops = {};
for (const [name, table] of Object.entries(rawTables)) {
  if (!Array.isArray(table)) { flatDrops[name] = table; continue; }
  const total = table.reduce((sum, row) => sum + (Number(row[0]) || 0), 0);
  flatDrops[name] = table
    .map((row) => ({
      weight: row[0],
      item: row[1],
      quantity: row.length > 2 ? row[2] : 1,
      chance: total > 0 ? Number((row[0] / total).toPrecision(6)) : null,
    }))
    .sort((a, b) => b.weight - a.weight);
}
await writeFile(path.join(sectionsDir, 'drops-by-monster.json'), JSON.stringify(flatDrops, null, 1) + '\n');

await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');

console.log('[fetch_game_data] game version ' + index.gameVersion + ', ' + names.length + ' sections, ' + raw.length + ' bytes');
for (const name of names) {
  console.log('  ' + name.padEnd(16) + String(index.sections[name].count).padStart(6) + '  ' + index.sections[name].bytes + ' B');
}
