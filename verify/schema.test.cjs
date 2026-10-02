/* Verifikasi silang db/schema.sql <-> api/sync.js.
   Risiko utama di sini bukan sintaks, tapi nama kolom/tabel yang tidak cocok
   antara schema dan query — yang hanya muncul saat runtime, bukan saat deploy.
   Parser Postgres opsional: bila terpasang, DDL ikut di-parse.
   Jalankan: node verify/schema.test.cjs                                           */
const fs = require('node:fs');
const path = require('node:path');

const SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const API = fs.readFileSync(path.join(__dirname, '..', 'api', 'sync.js'), 'utf8');

let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };

/* Komentar harus dilepas sebelum memeriksa nama terlarang: header schema menyebut
   "active_period" dengan sengaja untuk menjelaskan bahwa kolom itu TIDAK ada, dan
   pencocokan mentah akan menandai dokumentasinya sendiri sebagai pelanggaran. */
const stripSql = (s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const schemaCode = stripSql(SQL);
const apiCode = API.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ---------- 1. sintaks DDL (hanya bila parser tersedia) ---------- */
let parse = null;
try { parse = require('pgsql-ast-parser').parse; } catch { /* opsional */ }
if (parse) {
  const ddl = SQL.replace(/^\s*begin;/im, '').replace(/^\s*commit;/im, '');
  const statements = ddl.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  const errs = [];
  for (const st of statements) { try { parse(st); } catch (e) { errs.push(e.message); } }
  check(errs.length === 0, 'DDL di-parse parser Postgres (' + statements.length + ' statement)' +
    (errs.length ? ' GAGAL: ' + errs.join(' | ') : ''));
} else {
  console.log('SKIP  parser pgsql-ast-parser tidak terpasang (npm i -D pgsql-ast-parser)');
}

/* ---------- 2. kolom per tabel ---------- */
const tables = {};
for (const m of SQL.matchAll(/create table if not exists (\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const cols = new Set();
  for (const line of m[2].split('\n')) {
    const c = line.trim().match(/^(\w+)\s+(text|bigint|boolean|integer|timestamptz)/);
    if (c) cols.add(c[1]);
  }
  tables[m[1]] = cols;
}
check(Object.keys(tables).length === 3, 'schema punya 3 tabel: ' + Object.keys(tables).join(', '));

/* ---------- 3. kolom yang dipakai API harus ada ---------- */
const insRe = /insert into (\w+)\s*\(([\s\S]*?)\)\s*\n?\s*values/gi;
const selRe = /select\s+([\s\S]*?)\s+from\s+(\w+)/gi;
const used = new Set();

for (const m of API.matchAll(insRe)) {
  const table = m[1], cols = m[2].split(',').map((s) => s.trim()).filter(Boolean);
  const have = tables[table];
  if (!have) { check(false, 'tabel "' + table + '" dipakai API tapi tidak ada di schema'); continue; }
  cols.forEach((c) => used.add(c));
  const missing = cols.filter((c) => !have.has(c));
  check(missing.length === 0, cols.length + ' kolom untuk "' + table + '"' +
    (missing.length ? ' TIDAK ADA di schema: ' + missing.join(',') : ' semua cocok'));
}
for (const m of API.matchAll(selRe)) {
  const table = m[2], cols = m[1].split(',').map((s) => s.trim()).filter((c) => c && c !== '*');
  const have = tables[table];
  if (!have) { check(false, 'select from tabel tidak dikenal "' + table + '"'); continue; }
  cols.forEach((c) => used.add(c));
  const missing = cols.filter((c) => !have.has(c));
  check(missing.length === 0, 'select ' + cols.length + ' kolom dari "' + table + '"' +
    (missing.length ? ' TIDAK ADA: ' + missing.join(',') : ' semua cocok'));
}

/* ---------- 4. kolom yang di-update saat on conflict ---------- */
for (const m of apiCode.matchAll(/(\w+)\s*=\s*(?:excluded\.|coalesce\()(\w+)/g)) {
  const col = m[1];
  if (col === 'updated_at') continue;
  check(Object.values(tables).some((cols) => cols.has(col)), 'kolom on-conflict "' + col + '" ada di schema');
}

/* ---------- 5. aturan S-01 & S-06 ---------- */
check(!/active_period/i.test(schemaCode), 'S-01: tidak ada kolom active_period di schema');
check(!/activePeriod/i.test(apiCode), 'S-01: tidak ada activePeriod di jalur sync API');
check(/date\s+text\s+not null check/.test(schemaCode),
  'S-06: kolom date disimpan TEXT (driver tidak mengembalikan objek Date)');

const orphans = [];
for (const [t, cols] of Object.entries(tables)) for (const c of cols) if (!used.has(c)) orphans.push(t + '.' + c);
check(orphans.length === 0, 'tidak ada kolom yatim di schema' + (orphans.length ? ': ' + orphans.join(', ') : ''));

console.log('\n=== schema <-> api: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
