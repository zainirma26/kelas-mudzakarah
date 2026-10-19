/* Pengaturan yang paling sering diubah (hanya oleh pengembang, bukan pengguna). */
window.KELAS_CONFIG = {
  // ALAMAT SERVER TETAP: isi sekali dengan alamat server dari Render (lihat README, Langkah 2),
  // lalu build APK. Pengguna (guru/murid) tidak perlu mengisi apa pun.
  defaultServer: "https://kelas-online-server.onrender.com",
  // Opsional, kosongkan jika tidak dipakai. Isi alamat file JSON {"server":"https://..."} bila suatu saat
  // ingin memindahkan server TANPA build ulang APK.
  configUrl: "",
  // Resolusi dan bitrate video (kecilkan jika koneksi murid lemah)
  teacher: { height: 720, maxBitrate: 1500000, fps: 30 },
  student: { height: 360, maxBitrate: 300000, fps: 24 },
};
