/**
 * Layer sinkronisasi opsional (Neon / Vercel Function).
 *
 * Kontrak dengan front-end (lihat syncNow() di ../index.html):
 *   GET  /api/sync  ->  { ok:true, periods:[], transactions:[], archived:[] }
 *   POST /api/sync  ->  body { periods, transactions, owners }
 *                       ->  { ok:true, applied:{...} }
 *
 * Aturan yang tidak boleh dilanggar (SPESIFIKASI §8.3 / §8.4):
 *   1. DATABASE_URL hanya dibaca dari process.env, TIDAK PERNAH ditulis ke
 *      respons atau kode front-end. Kalau bocor ke browser, siapa pun yang
 *      membuka DevTools bisa membaca dan menulis seluruh database.
 *   2. Autentikasi wajib walau hanya satu pengguna: shared secret di header
 *      dibandingkan dengan timingSafeEqual. Tanpa auth, URL *.vercel.app
 *      adalah database publik — URL domain sendiri sangat mudah ditebak.
 *   3. Kolom date selalu string 'YYYY-MM-DD' (S-06). Kalau dikirim sebagai
 *      objek Date, timezone server/browser bisa menggesernya satu hari.
 *   4. activePeriod TIDAK PERNAH disimpan/diambil (S-01) — murni lokal per
 *      perangkat, jadi sinkron tidak boleh memaksa month view perangkat lain.
 *   5. Tidak ada console.log yang mencetak payload transaksi.
 */

const crypto = require('node:crypto');

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

/** Perbandingan constant-time; panjang beda harus ditolak tanpa throw. */
function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Tetap lakukan perbandingan dummy agar waktu proses tidak membocorkan
    // panjang secret lewat timing side-channel.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function unauthorized(res) {
  res.status(401).json({ ok: false, error: 'Unauthorized' });
}

/* ------------------------------------------------------------------ *
 * DB
 * ------------------------------------------------------------------ */

/**
 * Neon serverless driver: spoke HTTP, tidak butuh connection pooler,
 * dan aman dijalankan di serverless (scale-to-zero).
 */
async function getSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    const err = new Error('DATABASE_URL belum di-set di environment');
    err.statusCode = 500;
    throw err;
  }
  // require dinamis supaya modul ini tetap bisa di-import (mis. untuk tes)
  // di lingkungan yang belum memasang dependency.
  const { neon } = require('@neondatabase/serverless');
  return neon(connectionString);
}

/* ------------------------------------------------------------------ *
 * Normalisasi input
 * ------------------------------------------------------------------ */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const TYPE_RE = /^(pemasukan|pengeluaran)$/;

/** Buang apa pun yang bukan string, dan potong sesuai panjang kolom. */
function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max);
}

function int(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizePeriods(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const period = str(r && r.period, 7);
    if (!PERIOD_RE.test(period)) continue;
    out.push({
      period,
      label: str(r.label, 32),
      // saldo_awal boleh negatif: saldo bawaan bulan ini dikurangi carry-over.
      saldo_awal: int(r.saldoAwal),
      budget: Math.max(0, int(r.budget)),
      is_archived: Boolean(r.isArchived),
      closed_at: str(r.closedAt, 40) || null,
    });
  }
  return out;
}

function normalizeTxs(rows, allowedPeriods) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const period = str(r && r.period, 7);
    // Periodenya harus benar-benar ada; FK akan menolaknya kalau tidak,
    // tapi filter di sini membuat error-nya jelas dan idempoten.
    if (!PERIOD_RE.test(period) || !allowedPeriods.has(period)) continue;
    const type = str(r.type, 12);
    if (!TYPE_RE.test(type)) continue;
    const amount = int(r.amount);
    if (amount <= 0) continue;
    const date = str(r.date, 10);
    out.push({
      id: str(r.id, 64) || crypto.randomUUID(),
      period,
      type,
      amount,
      description: str(r.description, 200),
      category: str(r.category, 64),
      owner: type === 'pemasukan' ? '' : str(r.owner, 24),
      // S-06: string, bukan Date. Kalau tidak valid, pakai tanggal 1 periode.
      date: DATE_RE.test(date) ? date : period + '-01',
      source: str(r.source, 24) || 'manual',
      catatan: str(r.catatan, 200),
      locked: Boolean(r.locked),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function handleGet(req, res) {
  const sql = await getSql();
  const [periods, txs] = await Promise.all([
    sql`select period, label, saldo_awal, budget, is_archived, closed_at
          from periods order by period asc`,
    sql`select id, period, type, amount, description, category, owner,
                date, source, catatan, locked
          from transactions`,
  ]);

  const archivedSet = new Set(
    periods.filter((p) => p.is_archived).map((p) => p.period)
  );

  const mapTx = (t) => ({
    id: t.id,
    period: t.period,
    type: t.type,
    amount: Number(t.amount),
    description: t.description,
    category: t.category,
    owner: t.owner || '',
    // Postgres date/text sudah string; kirim apa adanya.
    date: typeof t.date === 'string' ? t.date : String(t.date).slice(0, 10),
    source: t.source,
    catatan: t.catatan || '',
    locked: Boolean(t.locked),
  });

  res.status(200).json({
    ok: true,
    periods: periods.map((p) => ({
      period: p.period,
      label: p.label,
      saldoAwal: Number(p.saldo_awal),
      budget: Number(p.budget),
      isArchived: Boolean(p.is_archived),
      closedAt: p.closed_at ? new Date(p.closed_at).toISOString() : null,
    })),
    // Dipisah sesuai bentuk yang Consumption front-end: transaksi periode
    // aktif vs arsip. Ditentukan dari is_archived, bukan disimpan terpisah.
    transactions: txs.filter((t) => !archivedSet.has(t.period)).map(mapTx),
    archived: txs.filter((t) => archivedSet.has(t.period)).map(mapTx),
  });
}

async function handlePost(req, res) {
  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Body harus JSON object' });
  }

  const periods = normalizePeriods(body.periods);
  if (!periods.length) {
    return res.status(400).json({ ok: false, error: 'Tidak ada periode valid untuk disimpan' });
  }
  const periodSet = new Set(periods.map((p) => p.period));
  const txs = normalizeTxs(body.transactions, periodSet);

  const owners = (Array.isArray(body.owners) ? body.owners : [])
    .map((o) => str(o, 24).trim())
    .filter(Boolean)
    .slice(0, 50);

  const sql = await getSql();

  /* S-03: upsert, bukan insert-then-check, supaya dua perangkat yang menutup
     periode bersamaan menghasilkan hasil yang sama dan tidak duplikat. */
  // S-02: klien mengirim saldo_awal hasil recomputeChainFrom(), bukan angka
  // yang diketik pengguna, jadi rantai carry-over antar periode konsisten.
  for (const p of periods) {
    await sql`
      insert into periods (period, label, saldo_awal, budget, is_archived, closed_at, updated_at)
      values (${p.period}, ${p.label}, ${p.saldo_awal}, ${p.budget},
              ${p.is_archived}, ${p.closed_at ? new Date(p.closed_at) : null}, now())
      on conflict (period) do update set
        label       = excluded.label,
        saldo_awal  = excluded.saldo_awal,
        budget      = excluded.budget,
        is_archived = excluded.is_archived,
        closed_at   = coalesce(excluded.closed_at, periods.closed_at),
        updated_at  = now()`;
  }

  for (const t of txs) {
    await sql`
      insert into transactions
        (id, period, type, amount, description, category, owner, date, source, catatan, locked, updated_at)
      values (${t.id}, ${t.period}, ${t.type}, ${t.amount}, ${t.description},
              ${t.category}, ${t.owner}, ${t.date}, ${t.source}, ${t.catatan}, ${t.locked}, now())
      on conflict (id) do update set
        period      = excluded.period,
        type        = excluded.type,
        amount      = excluded.amount,
        description = excluded.description,
        category    = excluded.category,
        owner       = excluded.owner,
        date        = excluded.date,
        source      = excluded.source,
        catatan     = excluded.catatan,
        locked      = excluded.locked,
        updated_at  = now()`;
  }

  for (let i = 0; i < owners.length; i++) {
    await sql`
      insert into owners (name, position, updated_at)
      values (${owners[i]}, ${i}, now())
      on conflict (name) do update set position = excluded.position, updated_at = now()`;
  }

  // Sengaja hanya jumlah, bukan isi payload (aturan §8.4 butir 5).
  res.status(200).json({
    ok: true,
    applied: { periods: periods.length, transactions: txs.length, owners: owners.length },
  });
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  // Shared secret wajib ada. Kalau env-nya lupa di-set, gagal keras — lebih
  // baik 500than diam-diam membuka database publik.
  const expected = process.env.SYNC_SECRET;
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'SYNC_SECRET belum di-set di environment' });
  }
  if (!secretMatches(req.headers['x-sync-secret'], expected)) {
    return unauthorized(res);
  }

  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ ok: false, error: 'Method tidak diizinkan' });
};
