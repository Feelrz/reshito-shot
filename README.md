# Reshito Shot

*Reshito* (レシート) = struk dalam bahasa Jepang. Made by [NAV](https://www.instagram.com/not.a.vision/).

Photobooth berbentuk printer struk thermal. Foto dicetak (dithering ala thermal) **menimpa struk acak**, lalu kertasnya disobek dari mesin dengan ujung bergerigi.

## Fitur
- **Live preview thermal**: kamera langsung dirender jadi titik tinta.
- **FOCUS / FULL** (switch di printer):
  - **FOCUS**: hanya orang yang dideteksi. Di bawahnya ada switch **BACKGROUND**: *OFF* = background hilang, *ON* = background tetap ada tapi dicetak samar supaya orangnya menonjol.
  - **FULL** (default): foto utuh apa adanya, tanpa deteksi orang sama sekali.
  - Pilihan terakhir diingat di browser. Jalan untuk kamera **dan** foto upload. Model cut-out (MediaPipe Selfie Segmentation) sudah ikut di folder `vendor/`, tidak butuh CDN, bisa offline.
- **Print realistis**: dot gain tinta, garis elemen head mati yang menembus teks + foto, banding feed kertas, tinta tidak rata, grain kertas, lalu sedikit soft seperti hasil scan.
- **Print → feed → tear**: kertas keluar dari slot. Tarik ke atas atau tap untuk menyobek; kalau didiamkan, sobek otomatis.
- **275 struk** bawaan (v3 + JP). Setiap struk punya *zona foto* otomatis: di area daftar item, di antara header toko dan barcode.
- **Board**: struk yang disobek ditempel di meja, tidak pernah menutupi live preview. Tap untuk **Save PNG**.
- **Admin panel** untuk menambah struk sendiri (lihat di bawah).
- **Made by NAV** di tengah bawah (di HP di bawah tombol) → Instagram @not.a.vision.
- Keyboard: `Space` = print / sobek, `F` = FOCUS/FULL, `B` = background on/off (di FOCUS), `Shift+A` = admin (hanya di device yang sudah login admin).

## Ko-fi
Tombol **Support on Ko-fi** ada di kanan atas (di HP tulisannya *Ko-fi*), memakai logo cup resmi dari server Ko-fi. Setelah print pertama muncul ajakan kecil sekali per sesi, dan setelah orang menyimpan PNG ada link Ko-fi di bawah tombol Save.
Ganti link: ubah `https://ko-fi.com/notavision` di `index.html` (ada 2: `#kofi` dan `#kofiTip`).

## Flap display: jumlah print global (real-time)
Angka split-flap di kanan atas menghitung **semua print dari semua pengunjung** dan update langsung.
- Default pakai **Abacus** (gratis, tanpa daftar, update real-time via stream). Pengaturannya di `js/config.js` → `COUNTER`.
- **Upstash**: token Upstash tidak boleh ditaruh di situs statis (bisa dipakai orang untuk menghapus database). Pakai proxy kecil `counter-worker/worker.js` di Cloudflare Workers (gratis), lalu set `COUNTER = { provider: 'upstash-proxy', url: 'https://<worker>.workers.dev' }`. Langkahnya ada di komentar file worker. Untuk Upstash paket berbayar bisa juga langsung pakai token ACL yang dibatasi ke `INCR`/`GET` (`provider: 'upstash'`).
- Kalau layanan counter tidak bisa dihubungi, flap tetap jalan dan menghitung print lokal.

## Dark mode
Tombol ◐ di kanan atas (di HP ada di bawah, sebelah tombol suara). Default **light**; dark hanya kalau dipilih, dan pilihan terakhir diingat. Di dark mode, preview kamera diberi alas kertas supaya tetap terlihat seperti hasil print.

## Jalankan lokal
Kamera hanya jalan di HTTPS atau `localhost`.
```bash
cd receipt-booth
python3 -m http.server 8000
# buka http://localhost:8000
```

## Deploy (GitHub Pages)
1. Push isi folder ini ke repo GitHub (`index.html` di root repo).
2. Repo → **Settings → Pages** → *Deploy from a branch* → `main` / `(root)`.
3. Buka `https://<username>.github.io/<repo>/`.

Netlify / Vercel juga bisa (tanpa build step). Kalau di-link ke repo GitHub, publish dari admin otomatis ikut ter-deploy.

## Admin panel — tambah struk sendiri (terkunci, hanya kamu)
Buka `https://<situs-kamu>/#admin`. Admin **terkunci**: hanya terbuka dengan token GitHub yang bisa *push* ke repo situs ini.

**Cara masuk pertama kali**
1. Buat token: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → *Generate new token*.
   - Repository access: **Only select repositories** → pilih repo situs ini saja.
   - Permissions → Repository → **Contents: Read and write**.
2. Buka `…/#admin`, paste token, klik **Unlock**. GitHub yang mengecek apakah akun kamu boleh menulis ke repo itu.
3. Setelah itu device ini diingat: `Shift+A` di booth langsung membuka admin. Klik **Lock** (kanan atas admin) untuk keluar dan menghapus token dari browser itu.

**Kenapa aman**
- Repo diambil dari alamat situs (`<username>.github.io/<repo>`), bukan diketik pengunjung. Jadi orang lain tidak bisa masuk pakai repo milik mereka sendiri.
- Pengunjung biasa tidak melihat tombol atau shortcut admin. Membuka `#admin` hanya menampilkan layar terkunci.
- Kalau token dicabut di GitHub, admin otomatis terkunci lagi saat dibuka berikutnya. Kalau sedang offline (laptop event), login terakhir tetap berlaku 30 hari.
- Situs ini statis, jadi kodenya publik. Yang benar-benar menjaga situs adalah GitHub: tanpa token yang punya izin tulis ke repo, **tidak ada yang bisa mengubah struk** untuk pengunjung lain.

**Domain sendiri / Netlify / Vercel**: isi `SITE_REPO` di `js/config.js`, misalnya `'nafil/receipt-booth'`. Tanpa itu, admin tertutup total di alamat tersebut.
**Lokal** (`localhost`): layar kunci menanyakan owner/repo + token.

**Pakai admin**
1. **Upload**: drop gambar struk (PNG/JPG/WebP, boleh banyak sekaligus). Otomatis:
   - mencari kertas, meluruskan yang miring, crop;
   - menentukan **zona foto** (kotak oranye) di area daftar item, menghindari header & barcode;
   - menyesuaikan ukuran kalau resolusinya jauh beda;
   - struk yang punya **gambar berwarna** otomatis dimatikan (bisa dinyalakan manual).
2. **Cek / ubah** (opsional): klik struk → geser kotak foto, tarik sudutnya untuk resize, `Auto-place` untuk mengulang deteksi, `Test print` untuk lihat hasil cetak.
3. Struk yang di-upload **langsung aktif di browser itu**.
4. **Publish to GitHub** → satu commit ke repo, situs ter-deploy ulang sekitar 1 menit. Atau **Export ZIP** untuk upload manual.

## Struktur
```
index.html
css/booth.css, css/admin.css
js/booth.js      booth: kamera, preview, print flow, board
js/print.js      mesin cetak thermal (dither, dot gain, artefak head, sobekan)
js/seg.js        cut-out orang (FOCUS)
js/process.js    otomatis: luruskan, crop, zona foto, deteksi gambar berwarna
js/admin.js      admin panel · js/github.js publish · js/zip.js export
js/auth.js       kunci admin (token GitHub) · js/config.js repo situs
js/library.js    daftar struk (manifest + upload lokal)
receipts/        manifest.json + gambar struk
vendor/selfie_segmentation/   model MediaPipe (Apache-2.0)
```
Parameter look ada di atas `js/print.js` (`DOT_REF` ukuran titik, `TOOTH_W_REF`/`TOOTH_D_REF` gerigi, `INK` warna tinta).
