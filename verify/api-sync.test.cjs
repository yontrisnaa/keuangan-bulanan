/* Uji regresi api/sync.js tanpa dependency terpasang: driver Neon di-stub dan
   setiap query SQL yang dikirim ditangkap untuk diperiksa.
  -Harness ini yang menangkap regresi `saldo_awal = excluded.saldo_awal` yang
   hilang dari upsert — bug itu lolos syntax check tapi mematikan carry-over.
   Jalankan: node verify/api-sync.test.cjs                                        */
const Module = require('node:module');
const path = require('node:path');

const captured = [];
const PERIOD_ROWS = [
  { period: '2026-08', label: 'Agustus 2026', saldo_awal: 5000000, budget: 0,
    is_archived: true, closed_at: new Date('2026-09-01T00:00:00Z') },
  { period: '2026-09', label: 'September 2026', saldo_awal: 7000000, budget: 5000000,
    is_archived: false, closed_at: null },
];
const TX_ROWS = [
  { id: 'a', period: '2026-08', type: 'pemasukan', amount: 2000000, description: 'Gaji Agu',
    category: 'Gaji', owner: '', date: '2026-08-01', source: 'manual', catatan: '', locked: false },
  { id: 'b', period: '2026-09', type: 'pengeluaran', amount: 300000, description: 'Belanja',
    category: 'Makanan', owner: 'Kucing', date: '2026-09-05', source: 'manual', catatan: '', locked: true },
];

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@neondatabase/serverless') {
    return {
      neon: () => (strings, ...values) => {
        const q = strings.join(' ? ');
        captured.push({ q, values });
        if (/from periods order/.test(q)) return Promise.resolve(PERIOD_ROWS);
        if (/from transactions/.test(q)) return Promise.resolve(TX_ROWS);
        return Promise.resolve([]);
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const handler = require(path.join(__dirname, '..', 'api', 'sync.js'));

function mockRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };
const call = async (req) => { const res = mockRes(); await handler(req, res); return res; };

(async () => {
  delete process.env.SYNC_SECRET;
  let r = await call({ method: 'GET', headers: {} });
  check(r.statusCode === 500, 'SYNC_SECRET belum di-set -> 500 (jangan diam-diam buka DB publik)');

  process.env.SYNC_SECRET = 'rahasia-123';
  process.env.DATABASE_URL = 'postgres://x';

  r = await call({ method: 'GET', headers: {} });
  check(r.statusCode === 401, 'tanpa header x-sync-secret -> 401');
  r = await call({ method: 'GET', headers: { 'x-sync-secret': 'salah' } });
  check(r.statusCode === 401, 'secret salah -> 401');
  r = await call({ method: 'GET', headers: { 'x-sync-secret': 'rahasia-1234' } });
  check(r.statusCode === 401, 'secret panjang beda -> 401 tanpa throw');
  r = await call({ method: 'DELETE', headers: { 'x-sync-secret': 'rahasia-123' } });
  check(r.statusCode === 405 && r.headers.Allow === 'GET, POST', 'method lain -> 405 + header Allow');

  const g = await call({ method: 'GET', headers: { 'x-sync-secret': 'rahasia-123' } });
  check(g.statusCode === 200 && g.body.ok === true, 'GET ok:true');
  check(g.body.transactions.length === 1 && g.body.archived.length === 1,
    'GET memisahkan arsip vs aktif berdasarkan is_archived');
  check(g.body.archived[0].id === 'a' && g.body.transactions[0].id === 'b',
    'pemisahan benar: archived=[a], transactions=[b]');
  check(!('activePeriod' in g.body), 'S-01: activePeriod tidak pernah ada di respons');
  check(typeof g.body.transactions[0].date === 'string', 'S-06: date dikirim sebagai string');
  check(!JSON.stringify(g.body).includes('postgres://'), 'DATABASE_URL tidak bocor ke respons');

  captured.length = 0;
  const p = await call({
    method: 'POST',
    headers: { 'x-sync-secret': 'rahasia-123' },
    body: JSON.stringify({
      periods: [
        { period: '2026-09', saldoAwal: 7000000, budget: 5000000, isArchived: false },
        { period: '2026-10', saldoAwal: 6550000, budget: 0, isArchived: false },
      ],
      transactions: [
        { id: 'b', period: '2026-09', type: 'pengeluaran', amount: 300000, date: '2026-09-05', owner: 'Kucing' },
        { id: 'z', period: '2026-11', type: 'pengeluaran', amount: 1000, date: '2026-11-01' },
      ],
      owners: ['Kamek', 'Mamak', 'Kucing'],
    }),
  });
  check(p.statusCode === 200 && p.body.applied.transactions === 1,
    'transaksi periode tak dikenal dibuang -> applied 1');

  const q = captured.find((c) => /insert into periods/.test(c.q));
  check(/saldo_awal\s*=\s*excluded\.saldo_awal/.test(q.q),
    'REGRESI: upsert periods menyalin saldo_awal (carry-over tidak hilang)');
  check(/is_archived\s*=\s*excluded\.is_archived/.test(q.q), 'upsert menyalin is_archived (S-03 idempoten)');
  check(/coalesce\(excluded\.closed_at, periods\.closed_at\)/.test(q.q), 'closed_at tak ditimpa null');
  check(!/\/\//.test(q.q), 'tidak ada komentar JS "//" di dalam SQL (syntax error Postgres)');
  check(!/active_period/.test(q.q), 'S-01: tidak ada kolom active_period di SQL');

  const txQ = captured.find((c) => /insert into transactions/.test(c.q));
  check(/locked\s*=\s*excluded\.locked/.test(txQ.q), 'upsert transactions menyalin locked');
  check(captured.filter((c) => /insert into owners/.test(c.q)).length === 3, '3 owner di-upsert');

  const bad = await call({ method: 'POST', headers: { 'x-sync-secret': 'rahasia-123' }, body: '{rusak' });
  check(bad.statusCode === 400, 'body JSON rusak -> 400');
  const badP = await call({ method: 'POST', headers: { 'x-sync-secret': 'rahasia-123' },
    body: JSON.stringify({ periods: [{ period: '2026-13', saldoAwal: 1 }] }) });
  check(badP.statusCode === 400, 'periode "2026-13" (bulan invalid) ditolak');

  console.log('\n=== api/sync.js: ' + pass + ' pass, ' + fail + ' fail ===');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
