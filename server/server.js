import "dotenv/config";
import express from "express";
import cors from "cors";
import { AccessToken } from "livekit-server-sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  TEACHER_PIN = "",
  DATA_DIR = "./data",
  PORT = 3000,
} = process.env;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error("Isi dulu LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET");
  process.exit(1);
}

// ---------- PIN guru ----------
const PIN_FILE = path.join(DATA_DIR, "pin.json");
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString("hex");
function loadPin() { try { return JSON.parse(fs.readFileSync(PIN_FILE, "utf8")); } catch { return null; } }
function savePin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PIN_FILE, JSON.stringify({ salt, hash: hashPin(pin, salt) }));
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function pinIsSet() { return !!TEACHER_PIN || !!loadPin(); }
function pinMatches(pin) {
  if (TEACHER_PIN) return safeEq(pin, TEACHER_PIN);
  const rec = loadPin();
  return !!rec && safeEq(hashPin(pin, rec.salt), rec.hash);
}

// Batasi tebakan PIN: maksimal 10 salah per 10 menit per alamat IP
const fails = new Map();
const blocked = (ip) => { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 600000; };
const noteFail = (ip) => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 600000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.send("Server kelas online aktif"));

app.post("/token", async (req, res) => {
  try {
    const { room, name, role, pin } = req.body || {};
    if (!room || !name) return res.status(400).json({ error: "Nama dan ruang kelas wajib diisi" });

    const isTeacher = role === "guru";
    if (isTeacher) {
      if (blocked(req.ip)) return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi 10 menit lagi." });
      if (!pinIsSet()) {
        if (!req.body.setup) return res.status(409).json({ needSetup: true, error: "PIN guru belum dibuat. Buat PIN baru." });
        if (!/^\d{6,12}$/.test(String(pin || ""))) return res.status(400).json({ needSetup: true, error: "PIN harus 6-12 angka." });
        savePin(pin);
      } else if (!pinMatches(pin)) {
        noteFail(req.ip);
        return res.status(403).json({ error: "PIN guru salah" });
      }
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
