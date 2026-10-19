# Kelas Online (guru besar, murid kecil, tanpa delay)

Aplikasi kelas online berbasis **WebRTC (LiveKit)**. Latensi sekitar 100-300 ms, jauh lebih rendah daripada RTMP/HLS.

- Guru tampil di layar besar, murid tampil sebagai kotak kecil dengan wajah (kamera) masing-masing.
- Murid masuk dengan mikrofon mati. Guru masuk dengan PIN rahasia.
- Video murid dikirim resolusi kecil (360p) dan hanya diterima sesuai ukuran kotaknya, sehingga hemat kuota dan tidak lag.
- Dibangun menjadi APK lewat GitHub Actions, jadi tidak perlu Android Studio.

## Cara kerja untuk pengguna

Guru dan murid **cukup memasang APK, isi nama, pilih pelajaran, lalu Masuk Kelas**. Tidak ada alamat server yang perlu diisi
dan tidak ada yang perlu dinyalakan. Semua server disiapkan sekali oleh pengembang (Anda) dengan langkah di bawah.

## Arsitektur

```
HP guru/murid (APK)  --token-->  Server token (server/, di Render)  --> LiveKit (video/audio WebRTC)
```

1. **LiveKit Cloud** menangani video/audio.
2. **Server token** (folder `server/`, kecil) memberi izin masuk kelas dan mengecek PIN guru.
3. **APK** (folder `www/` dibungkus Capacitor) adalah aplikasinya. Alamat server tertanam di `www/config.js`.

## Langkah pengembang (dilakukan sekali)

### 1. Akun LiveKit
Daftar di https://cloud.livekit.io, buat project (region Singapore). Catat **URL** (`wss://....livekit.cloud`), **API Key**, dan **API Secret**.

### 2. Pasang server di Render
1. Daftar di https://render.com dengan akun GitHub.
2. Klik **New -> Blueprint**, pilih repo ini. Render membaca `render.yaml` dan membuat layanan `kelas-online-server`.
3. Isi empat nilai rahasia saat diminta: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `TEACHER_PIN` (ganti PIN!).
   Nilai ini hanya tersimpan di Render, tidak di GitHub.
4. Setelah deploy selesai, salin alamatnya (contoh `https://kelas-online-server.onrender.com`).
   Buka di browser: harus tampil "Server kelas online aktif".

### 3. Isi alamat server di aplikasi
Alamat server disimpan di file `.env` (bukan di kode).
- **Build lewat GitHub Actions:** di repo buka **Settings -> Secrets and variables -> Actions -> Variables**, buat variable `SERVER_URL` berisi alamat dari Render.
- **Build/uji di komputer sendiri:** salin `.env.example` menjadi `.env`, isi `SERVER_URL`, lalu jalankan `npm run sync`.
- **Server lokal:** salin `server/.env.example` menjadi `server/.env` dan isi nilainya (di Render tetap diisi lewat Dashboard).

### 4. Bangun APK
Build berjalan otomatis setelah commit (tab **Actions** -> **Build APK**, bisa juga **Run workflow**). Tunggu sekitar 5-8 menit,
unduh artifact **kelas-online-apk**, ekstrak, lalu bagikan `app-debug.apk` ke guru dan murid.
Aktifkan "Install dari sumber tidak dikenal" jika diminta.

Selesai. Build ulang hanya diperlukan jika `www/` diubah.

## Server gratis vs selalu aktif

Layanan **Free** Render tidur setelah sekitar 15 menit tanpa permintaan. Permintaan pertama sesudahnya bisa tertunda
30 detik sampai 1,5 menit; aplikasi menampilkan "Menyiapkan kelas…" selama itu. Untuk pengalaman seperti Zoom (langsung masuk),
ubah `plan: free` menjadi `plan: starter` di `render.yaml` (berbayar), atau minta guru masuk beberapa menit sebelum kelas.

## Cara pakai

1. Buka aplikasi, isi nama, pilih pelajaran. Guru pilih "Guru" dan isi PIN. Murid pilih "Murid".
2. Semua yang memilih **pelajaran yang sama** masuk ke ruang yang sama.

## Tips agar benar-benar tanpa delay

- Pakai Wi-Fi atau 4G yang stabil, terutama untuk HP guru.
- Pilih region LiveKit yang dekat (Singapore).
- Untuk kelas besar (lebih dari 30 murid), minta murid tetap menutup mikrofon, dan batasi kamera murid jika perlu.

## Catatan

- APK yang dihasilkan adalah **debug APK**: bisa langsung diinstall, tapi untuk Play Store perlu rilis yang ditandatangani.
- Library video dimuat dari CDN saat aplikasi dibuka, jadi perlu internet.
- Folder `opsional/termux/` hanya untuk yang ingin menjalankan server di HP sendiri; tidak diperlukan untuk pemakaian normal.
