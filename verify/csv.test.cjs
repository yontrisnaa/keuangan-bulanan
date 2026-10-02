/* Uji exportCSV() dari index.html.
   Fungsi aslinya diekstrak dari index.html lalu dijalankan dengan dependensi
   yang di-stub, jadi yang diuji adalah kode yang benar-benar terkirim — bukan
   salinannya.-parser CSV RFC4180 dipakai untuk mem-parse balik hasilnya.
   Jalankan: node verify/csv.test.cjs                                              */
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const check = (c, m) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m); } };

/* ---------- parser CSV RFC4180 (delimiter ';', apa adanya) ---------- */
function parseCsv(text, delim) {
  delim = delim || ';';
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------- ekstrak exportCSV + jalankan dengan stub ---------- */
const src = HTML.match(/function exportCSV\(\)\{[\s\S]*?\n\}/);
if (!src) {
  console.log('FAIL tidak menemukan function exportCSV() di index.html');
  process.exit(1);
}
const mk = new Function('viewedTransactions', 'isAllArchive', 'viewedPeriod', 'download', 'toast',
  src[0] + '\nreturn exportCSV;');

const FORMULA = ["=cmd|'/c calc'!A1", '+1+1', '-1000', '@SUM(A1)'];
const BENIGN = ['Belanja <b>"diskon"</b> & kopi @warung', '<img src=x onerror=alert(1)>', 'Makan siang'];
const rows = [];
FORMULA.forEach((d, i) => rows.push({ date: '2026-10-02', period: '2026-10', type: 'pengeluaran',
  amount: 1000 * (i + 1), description: d, category: 'Makanan & Minuman', owner: 'Kucing', source: 'manual', catatan: '' }));
BENIGN.forEach((d, i) => rows.push({ date: '2026-10-02', period: '2026-10', type: 'pengeluaran',
  amount: 5000 * (i + 1), description: d, category: 'Makanan & Minuman', owner: 'Mamak', source: 'manual', catatan: '' }));

let cap = null;
const exportCSV = mk(() => rows, () => false, () => '2026-10',
  (name, content, type) => { cap = { name, content, type }; }, () => {});

exportCSV();
if (!cap) { console.log('FAIL exportCSV() tidak memanggil download()'); process.exit(1); }

check(cap.name === 'transaksi-2026-10.csv', 'nama berkas = ' + cap.name);
check(cap.type === 'text/csv;charset=utf-8', 'MIME = ' + cap.type);
check(cap.content.charCodeAt(0) === 0xFEFF, 'BOM UTF-8 ada (wajib agar Excel Indonesia tidak salah baca)');

const parsed = parseCsv(cap.content.replace(/^\uFEFF/, ''));
check(parsed.length === rows.length + 1, 'baris = 1 header + ' + rows.length + ' data');
check(parsed.every((r) => r.length === 9), 'semua baris 9 kolom');

/* ---------- proteksi formula injection ---------- */
FORMULA.forEach((p, i) => {
  check(parsed[i + 1][3] === "'" + p,
    'formula dicegah: ' + JSON.stringify(p) + ' -> ' + JSON.stringify(parsed[i + 1][3]));
});
BENIGN.forEach((p, i) => {
  check(parsed[FORMULA.length + 1 + i][3] === p,
    'teks biasa utuh: ' + JSON.stringify(p));
});

/* kolom nominal harus tetap angka, bukan teks yang diawali ' */
const nominals = parsed.slice(1).map((r) => r[6]);
check(nominals.every((v) => /^\d+$/.test(v)), 'kolom nominal tetap numerik: ' + nominals.join(','));

/* tidak boleh ada sel yang masih bisa dieksekusi Excel/Sheets */
const danger = parsed.slice(1).flat().filter((c) => /^[=+\-@\t\r]/.test(c));
check(danger.length === 0, 'tidak ada sel mentah berawalan formula' + (danger.length ? ': ' + JSON.stringify(danger) : ''));

/* pemasukan tidak boleh punya pemilik */
const inc = { date: '2026-10-02', period: '2026-10', type: 'pemasukan', amount: 9000000,
  description: 'Gaji', category: 'Gaji & Utama', owner: 'Kucing', source: 'manual', catatan: '' };
let cap2 = null;
mk(() => [inc], () => false, () => '2026-10', (n, c, t) => { cap2 = c; }, () => {})();
check(parseCsv(cap2.replace(/^\uFEFF/, ''))[1][5] === '', 'pemasukan punya kolom pemilik kosong');

console.log('\n=== exportCSV: ' + pass + ' pass, ' + fail + ' fail ===');
process.exit(fail ? 1 : 0);
