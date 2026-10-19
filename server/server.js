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
  DATA_DIR = "./data", // Tempat menyimpan data kelas (di Railway: pasang Volume ke /app/data)
  PORT = 3000,
} = process.env;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error("Isi dulu LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET");
  process.exit(1);
}

// ---------- Penyimpanan sederhana (file JSON) ----------
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v)); };

// ---------- Hash (PIN dan kunci guru tidak disimpan apa adanya) ----------
const hashOf = (v, salt) => crypto.scryptSync(String(v), salt, 32).toString("hex");
const makeHash = (v) => { const salt = crypto.randomBytes(16).toString("hex"); return { salt, hash: hashOf(v, salt) }; };
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const checkHash = (v, rec) => !!rec && safeEq(hashOf(v, rec.salt), rec.hash);
const pinOk = (v) => /^\d{4,12}$/.test(String(v || ""));

// ---------- Pembatas percobaan per alamat IP ----------
const fails = new Map();   // tebakan PIN salah: maks 10 per 10 menit
const blocked = (ip) => { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 600000; };
const noteFail = (ip) => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 600000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };
const creates = new Map(); // pembuatan kelas baru: maks 10 per jam
const tooManyCreates = (ip) => { const c = creates.get(ip); return c && c.n >= 10 && Date.now() - c.t < 3600000; };
const noteCreate = (ip) => { const c = creates.get(ip); creates.set(ip, c && Date.now() - c.t < 3600000 ? { n: c.n + 1, t: c.t } : { n: 1, t: Date.now() }); };

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => res.send("Server kelas online aktif"));

// Cara kerja:
// - Guru masuk bebas (tanpa PIN guru). Saat pertama membuka kelas, guru membuat PIN murid.
//   Server membuat "kunci guru" acak yang disimpan di HP guru, supaya hanya HP itu yang bisa
//   masuk lagi sebagai guru kelas tersebut.
// - Murid masuk dengan pelajaran + PIN dari guru. PIN dicocokkan ke kelas guru yang punya PIN itu.
app.post("/token", async (req, res) => {
  try {
    const { name, role } = req.body || {};
    const subject = String(req.body?.room || "").trim().toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 40);
    const cleanName = String(name || "").trim().slice(0, 30);
    if (!subject || !cleanName) return res.status(400).json({ error: "Nama dan pelajaran wajib diisi" });

    const isTeacher = role === "guru";
    const classPin = String(req.body.classPin || "").trim();
    const teacherKey = String(req.body.teacherKey || "").trim();
    if (blocked(req.ip)) return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi 10 menit lagi." });

    const classes = readJson("classes.json", {});
    const ofSubject = Object.entries(classes).filter(([, c]) => c.subject === subject);
    const pinTaken = (pin, exceptId) => ofSubject.some(([id, c]) => id !== exceptId && checkHash(pin, c.pin));

    let liveRoom, newKey = null;

    if (isTeacher) {
      // Kelas milik guru ini (dikenali dari kunci guru yang tersimpan di HP-nya)
      const owned = teacherKey ? ofSubject.find(([, c]) => checkHash(teacherKey, c.owner)) : null;
      if (owned) {
        const [id, c] = owned;
        if (classPin) {
          if (!pinOk(classPin)) return res.status(400).json({ needClassPin: true, error: "PIN murid harus 4-12 angka." });
          if (pinTaken(classPin, id)) { noteFail(req.ip); return res.status(409).json({ needClassPin: true, error: "PIN itu sudah dipakai kelas lain. Pilih PIN lain." }); }
          c.pin = makeHash(classPin);
          writeJson("classes.json", classes);
        }
        liveRoom = c.room;
      } else {
        // Kelas baru
        if (!classPin) return res.status(409).json({ needClassPin: true, staleKey: !!teacherKey, error: "Buat PIN murid untuk kelas ini (4-12 angka)." });
        if (!pinOk(classPin)) return res.status(400).json({ needClassPin: true, error: "PIN murid harus 4-12 angka." });
        if (tooManyCreates(req.ip)) return res.status(429).json({ error: "Terlalu banyak kelas baru dari perangkat ini. Coba lagi nanti." });
        if (pinTaken(classPin)) { noteFail(req.ip); return res.status(409).json({ needClassPin: true, error: "PIN itu sudah dipakai kelas lain. Pilih PIN lain." }); }
        const id = crypto.randomBytes(4).toString("hex");
        newKey = crypto.randomBytes(16).toString("hex");
        classes[id] = { subject, room: `${subject}-${id}`, pin: makeHash(classPin), owner: makeHash(newKey), created: Date.now() };
        writeJson("classes.json", classes);
        noteCreate(req.ip);
        liveRoom = classes[id].room;
      }
    } else {
      const found = classPin ? ofSubject.find(([, c]) => checkHash(classPin, c.pin)) : null;
      if (!found) { noteFail(req.ip); return res.status(403).json({ error: "PIN kelas salah, atau guru belum membuka kelas ini. Pastikan nama pelajaran ditulis sama seperti yang ditulis guru." }); }
      liveRoom = found[1].room;
    }

    const identity = `${isTeacher ? "guru" : "murid"}-${cleanName}-${Math.random().toString(36).slice(2, 7)}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name: cleanName,
      metadata: JSON.stringify({ role: isTeacher ? "guru" : "murid" }),
      ttl: "4h",
    });
    at.addGrant({
      room: liveRoom,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const out = { token: await at.toJwt(), url: LIVEKIT_URL };
    if (newKey) out.teacherKey = newKey;
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal membuat token" });
  }
});

app.listen(PORT, () => console.log(`Token server jalan di port ${PORT}`));
