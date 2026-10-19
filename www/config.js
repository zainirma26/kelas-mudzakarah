/* Pengaturan yang paling sering diubah (hanya oleh pengembang, bukan pengguna). */
window.KELAS_CONFIG = {
  // Alamat server dibaca dari file .env (SERVER_URL) lewat www/env.js, yang dibuat oleh
  // scripts/gen-env.js. Jangan diisi di sini.
  defaultServer: (window.KELAS_ENV || {}).SERVER_URL || "",
  // Opsional (CONFIG_URL di .env): alamat file JSON {"server":"https://..."} untuk pindah server TANPA build ulang APK.
  configUrl: (window.KELAS_ENV || {}).CONFIG_URL || "",
  // Resolusi dan bitrate video (kecilkan jika koneksi murid lemah)
  teacher: { height: 720, maxBitrate: 1500000, fps: 30 },
  student: { height: 360, maxBitrate: 300000, fps: 24 },
};
