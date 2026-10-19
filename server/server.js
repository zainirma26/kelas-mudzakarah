import express from "express";
import cors from "cors";
import { AccessToken } from "livekit-server-sdk";

const {
  LIVEKIT_URL,        // contoh: wss://namaproyek.livekit.cloud
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  TEACHER_PIN = "123456", // GANTI! PIN rahasia agar hanya guru yang bisa jadi "guru"
  PORT = 3000,
} = process.env;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error("Isi dulu LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.send("Server kelas online aktif"));

app.post("/token", async (req, res) => {
  try {
    const { room, name, role, pin } = req.body || {};
    if (!room || !name) return res.status(400).json({ error: "Nama dan ruang kelas wajib diisi" });

    const isTeacher = role === "guru";
    if (isTeacher && pin !== TEACHER_PIN) {
      return res.status(403).json({ error: "PIN guru salah" });
    }

    const cleanRoom = String(room).trim().slice(0, 40);
    const cleanName = String(name).trim().slice(0, 30);
    const identity = `${isTeacher ? "guru" : "murid"}-${cleanName}-${Math.random().toString(36).slice(2, 7)}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: cleanName,
      metadata: JSON.stringify({ role: isTeacher ? "guru" : "murid" }),
      ttl: "4h",
    });
    at.addGrant({
      room: cleanRoom,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    res.json({ token: await at.toJwt(), url: LIVEKIT_URL });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal membuat token" });
  }
});

app.listen(PORT, () => console.log(`Token server jalan di port ${PORT}`));
