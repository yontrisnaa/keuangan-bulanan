-- Schema untuk layer sinkronisasi opsional (Neon Postgres).
-- Terapkan sekali:  psql "$DATABASE_URL" -f db/schema.sql
--
-- Semua kolom dan nama tabel di sini harus persis sama dengan yang dibaca
-- api/sync.js. Kalau satu nama berubah di sisi lain, query akan gagal saat
-- runtime, bukan saat deploy.
--
-- Perhatikan: TIDAK ADA tabel/kolom active_period di mana pun (S-01).
-- activePeriod murni state lokal per perangkat — kalau ikut disinkronkan,
-- satu perangkat bisa mengunci month view perangkat lain ke bulan yang salah.

begin;

-- Periode bulanan. Satu baris = satu bulan.
create table if not exists periods (
  period       text        primary key
                            check (period ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  label        text        not null default '',
  -- Boleh negatif: saldo bawaan bulan ini boleh lebih kecil dari carry-over
  -- bulan lalu (defisit / pengeluaran besar di awal bulan).
  saldo_awal   bigint      not null default 0,
  budget       bigint      not null default 0 check (budget >= 0),
  is_archived  boolean     not null default false,
  closed_at    timestamptz,
  updated_at   timestamptz not null default now()
);

-- Transaksi. Satu baris = satu mutasi uang.
create table if not exists transactions (
  id           text        primary key,
  period       text        not null references periods (period) on delete cascade,
  type         text        not null check (type in ('pemasukan', 'pengeluaran')),
  amount       bigint      not null check (amount > 0),
  description  text        not null default '',
  category     text        not null default '',
  owner        text        not null default '',
  -- S-06: disimpan sebagai TEXT, bukan tipe DATE. Kalau kolomnya DATE, driver
  -- Neon mengembalikan objek JavaScript Date, dan stringify-nya bisa bergeser
  -- satu hari tergantung zona waktu server. String 'YYYY-MM-DD' selalu aman.
  date         text        not null check (date ~ '^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$'),
  source       text        not null default 'manual',
  catatan      text        not null default '',
  -- Baris belonging ke periode terarsip: tampil baca-saja di UI (ikon kunci,
  -- tanpa tombol void/hapus). Diturunkan dari periods.is_archived.
  locked       boolean     not null default false,
  updated_at   timestamptz not null default now()
);

-- Daftar pemilik. Urutan = urutan tampil, disimpan sebagai position.
create table if not exists owners (
  name         text        primary key,
  position     integer     not null default 0,
  updated_at   timestamptz not null default now()
);

-- Query yang paling sering jalan: render tabel satu periode.
create index if not exists transactions_period_idx on transactions (period);
create index if not exists transactions_date_idx   on transactions (date);

commit;
