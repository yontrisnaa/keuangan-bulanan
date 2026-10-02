# Keuangan Bulanan

Pelacak keuangan keluarga dalam **satu file HTML**. Tidak ada database, tidak ada
build step, tidak ada dependensi. Data disimpan di `localStorage` browser.

## Mulai cepat

Buka `index.html` — cukup klik dua kali. Aplikasi berjalan dari `file://` tanpa
server, dan berjalan identik saat di-host di mana pun.

## Privasi

Data transaksi **tidak pernah meninggalkan perangkat**. Tidak ada server, tidak
ada analitik, tidak ada telemetri. Konsekuensinya perlu dipahami:

- Menghapus data situs / cache browser = transaksi hilang permanen.
- Berpindah perangkat = data tidak ikut. Tidak ada sinkronisasi otomatis.

Karena itu rutin **Ekspor CSV** dari menu Arsip adalah cadanganmu. Lakukan
secara berkala.

Membuat repository ini publik **tidak** membuat datamu publik — kode terbuka,
tapi data setiap orang ada di browser masing-masing dan nol saat halaman dibuka.

## Fitur

Periode bulanan dengan carry-over otomatis, arsip periode tertutup (read-only),
pembagian antar pemilik, anggaran per kategori, void transaksi, filter, tooltip,
impor/ekspor CSV, pemindaian struk via Gemini (opsional).

Owner bawaan: `Kamek`, `Mamak`, `Kucing` — dapat diganti di Pengaturan.

### Aturan saldo

```
saldoAkhir(P) = saldoAwal(P) + Σpemasukan(P) − Σpengeluaran(P)
saldoAwal(P+1) = saldoAkhir(P)
```

Periode pertama menjadi jangkar: `saldoAwal`-nya tidak pernah ditimpa.
Periode berikutnya dihitung ulang dari jangkar itu. Berkas impor yang memuat
angka pada periode turunan tidak akan merusak carry-over.

## Tes

Tiga berkas, dijalankan langsung dengan Node (tanpa dependensi):

```bash
node verify/csv.test.cjs        # 15 pass — formula injection, RFC4180, escaping
node verify/api-sync.test.cjs   # 21 pass — auth, GET/POST, upsert idempoten
node verify/schema.test.cjs     # 26 pass — konsistensi kolom schema <-> API
```

Ketiganya keluar dengan exit code non-nol bila ada kegagalan, jadi aman
dipasang sebagai pre-commit hook.

`schema.test.cjs` juga mem-parse DDL dengan parser Postgres **bila** terpasang:

```bash
npm i -D pgsql-ast-parser   # opsional; tanpa itu bagian ini di-SKIP
```

## Backend Neon (opsional, belum terhubung)

`db/schema.sql` dan `api/sync.js` tersedia untuk server-less hosting yang mendukung
Node. Namun jalur itu **belum selesai** dari sisi front-end:

- `syncNow()` hanya melakukan `GET` — menarik `periods`, `transactions`, dan
  `archived`, lalu menimpa state lokal. Tidak pernah mengirim data ke server.
- Header `x-sync-secret` tidak dikirim, sedangkan `api/sync.js` menolak request
  tanpa secret yang cocok (401, dibandingkan dengan `timingSafeEqual`).

Artinya: mengisi "URL Database" di Pengaturan saat ini akan berakhir dengan
`Gagal sinkron: HTTP 401 — data aman di lokal`. Jalur dua arah belum selesai;
gunakan Ekspor CSV sampai itu dikerjakan.

Menjalankan backend butuh dua variabel lingkungan, **jangan** di-commit:

```bash
DATABASE_URL=postgres://...   # hanya dibaca dari process.env, tidak pernah masuk respons
SYNC_SECRET=<rahasia panjang>
```

## Hosting

Sudah aktif di **GitHub Pages**: https://yontrisnaa.github.io/keuangan-bulanan

Deploy otomatis dari branch `main` setiap ada push — tanpa action, tanpa build
step. File `.nojekyll` mencegah Jekyll ikut memproses berkas saat deploy.

Repository ini **public**, bukan lagi private. Itu syarat GitHub Pages pada
paket Free, dan konsekuensinya: seluruh kode di sini — termasuk `api/sync.js`
dan `db/schema.sql` — sekarang bisa dibaca siapa saja. Yang tetap tidak publik
adalah datamu, karena semuanya hanya ada di `localStorage`.

Halaman Pages bersifat statis, jadi `api/sync.js` tidak berjalan di sana. Berkas
itu tetap berguna sebagai referensi bagi yang ingin men-deploy backend sendiri.

## Scan struk (opsional)

Butuh Google Gemini API key, diisi di Pengaturan dan disimpan di `localStorage`.
Berkas struk dikirim langsung dari browser ke `generativelanguage.googleapis.com`;
tidak pernah lewat server mana pun yang dimiliki repo ini. Kosongkan kunci bila
tidak dipakai — kunci di `localStorage` tetap terbaca oleh skrip di halaman yang
sama.
