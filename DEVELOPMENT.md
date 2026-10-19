# Panduan update dan pengembangan sendiri

Ini kode mentah (source code). Semua bisa diubah sendiri tanpa tool khusus. Cukup editor teks.

## Peta file

```
kelas-online/
├── www/                      <- ISI APLIKASI (yang tampil di HP)
│   ├── index.html            struktur layar: halaman masuk + halaman kelas + tombol
│   ├── style.css             warna, ukuran, tata letak (warna ada di :root paling atas)
│   ├── app.js                logika: masuk kelas, video, mic, kamera, tombol
│   └── config.js             pengaturan cepat: alamat file konfigurasi, resolusi, bitrate
├── render.yaml               resep deploy server token ke Render (sekali klik)
├── opsional/termux/          <- (opsional) menjalankan server di HP sendiri lewat Termux
│   ├── setup.sh              pasang kebutuhan (sekali saja)
│   ├── mulai-kelas.sh        nyalakan server + tunnel + tulis alamat ke kelas-config
│   ├── env.example.sh        contoh isi kunci LiveKit dan PIN (salin jadi env.sh, tidak di-upload)
├── server/                   <- SERVER TOKEN (jalan di Termux, atau Render/Railway)
│   ├── server.js             cek PIN guru + buat izin masuk kelas
│   └── package.json
├── capacitor.config.json     nama aplikasi dan ID paket Android
├── package.json              versi Capacitor
├── .github/workflows/
│   └── build-apk.yml         resep otomatis membuat APK di GitHub
├── README.md                 panduan pertama kali memasang
└── DEVELOPMENT.md            file ini
```

## Alur update (setiap kali mengubah sesuatu)

1. Edit file di `www/` (atau `server/`).
2. Uji cepat di Termux (lihat bagian bawah).
3. Upload perubahan ke GitHub. Build APK berjalan otomatis jika yang berubah `www/`, `package.json`, `capacitor.config.json`, atau workflow.
4. Unduh APK baru dari tab **Actions**, lalu install di atas aplikasi lama (data tidak hilang).

Perubahan di `server/` TIDAK butuh APK baru (cukup commit, Render deploy ulang otomatis). Mengganti alamat server butuh APK baru, kecuali memakai `configUrl`.

## Perubahan yang sering diminta

| Mau apa | Ubah di mana |
|---|---|
| Ganti alamat server | `www/config.js` -> `defaultServer` (perlu build APK ulang) |
| Pindah server tanpa build ulang | Isi `configUrl` dengan alamat file JSON `{"server":"https://..."}`, lalu cukup ubah file itu |
| Server tidak pernah tidur | `render.yaml` -> `plan: starter` (berbayar) |
| Video lebih ringan/jernih | `www/config.js` -> `teacher` / `student` (`height`, `maxBitrate`, `fps`) |
| Ganti warna tema | `www/style.css` -> blok `:root` paling atas |
| Ganti tulisan/judul | `www/index.html` |
| Ganti PIN guru | variable `TEACHER_PIN` di hosting server (tanpa build ulang) |
| Ganti nama aplikasi | `capacitor.config.json` -> `appName` |
| Ganti ID paket | `capacitor.config.json` -> `appId` (aplikasi dianggap baru jika diganti) |
| Murid mulai mic hidup | `www/app.js` -> cari `setMicrophoneEnabled(isTeacher)`, ubah jadi `true` |
| Maks ukuran kotak murid | `www/style.css` -> `#strip` (`minmax(84px,1fr)`) |

## Menambah fitur (arah pengembangan)

- **Guru mematikan mic murid / mute semua:** tambahkan endpoint di `server/server.js` memakai `RoomServiceClient` dari `livekit-server-sdk` (`mutePublishedTrack`), lalu panggil dari tombol baru di `app.js`.
- **Chat kelas:** LiveKit punya data channel. Pakai `room.localParticipant.publishData(...)` dan event `RoomEvent.DataReceived`.
- **Berbagi layar guru:** `room.localParticipant.setScreenShareEnabled(true)` (di Android lewat WebView belum selalu didukung, perlu plugin native).
- **Rekaman kelas:** fitur Egress di LiveKit (diatur di sisi server/LiveKit Cloud).
- **Angkat tangan:** kirim pesan data kecil ke guru, tampilkan ikon di kotak murid.

## Uji cepat di Termux (tanpa membuat APK)

```bash
pkg install nodejs python
cd kelas-online/www
python -m http.server 8080
```

Buka `http://localhost:8080` di Chrome HP. `localhost` dianggap aman, jadi kamera dan mikrofon bisa dipakai.
Server token juga harus HTTPS. Untuk uji lokal bisa memakai `opsional/termux/mulai-kelas.sh`.

## Menaikkan versi

Ubah `version` di `package.json` setiap rilis agar mudah dilacak. Untuk update yang bisa menimpa APK lama,
APK harus ditandatangani dengan kunci yang sama. Debug APK dari GitHub memakai kunci debug yang berbeda tiap runner,
jadi jika Android menolak update, uninstall dulu aplikasi lama baru install yang baru.
Untuk pemakaian serius, buat keystore sendiri dan simpan di GitHub Secrets.

## Library video (LiveKit)

`www/index.html` memuat library dari CDN:
`https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js`
Ingin versi tertentu atau tanpa CDN? Unduh file itu, taruh di `www/`, lalu ganti `src` di `index.html`.
