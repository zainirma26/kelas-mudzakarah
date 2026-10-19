import "dotenv/config";
import express from "express";
import cors from "cors";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET,
  DATA_DIR = "./data",            // Tempat menyimpan data kelas (di Railway: pasang Volume ke /app/data)
  FIREBASE_SERVICE_ACCOUNT = "",  // Opsional: isi JSON service account Firebase agar notifikasi push aktif
  PORT = 3000,
} = process.env;

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  console.error("Isi dulu LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET");
  process.exit(1);
}

// ---------- LiveKit (untuk layar besar & cek apakah guru sudah masuk) ----------
const lkHost = LIVEKIT_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const lk = new RoomServiceClient(lkHost, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// ---------- Notifikasi push (Firebase Cloud Messaging) ----------
let fcm = null;
if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    const { initializeApp, cert } = await import("firebase-admin/app");
    const { getMessaging } = await import("firebase-admin/messaging");
    fcm = getMessaging(initializeApp({ credential: cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)) }));
    console.log("Notifikasi push aktif");
  } catch (e) {
    console.error("Notifikasi push GAGAL diaktifkan:", e.message);
  }
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
const toSubject = (v) => String(v || "").trim().toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 40);

// ---------- Pembatas percobaan per alamat IP ----------
const fails = new Map();   // tebakan PIN salah: maks 10 per 10 menit
const blocked = (ip) => { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 600000; };
const noteFail = (ip) => { const f = fails.get(ip); fails.set(ip, f && Date.now() - f.t < 600000 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };
const creates = new Map(); // pembuatan kelas baru: maks 10 per jam
const tooManyCreates = (ip) => { const c = creates.get(ip); return c && c.n >= 10 && Date.now() - c.t < 3600000; };
const noteCreate = (ip) => { const c = creates.get(ip); creates.set(ip, c && Date.now() - c.t < 3600000 ? { n: c.n + 1, t: c.t } : { n: 1, t: Date.now() }); };

// Kirim notifikasi ke murid yang sudah mengikuti kelas ini, hanya saat guru MEMULAI pelajaran
// (belum ada guru di ruangan) dan paling sering sekali per 5 menit.
async function notifyClassStart(id, c, teacherName) {
  if (!fcm || !c.tokens || !c.tokens.length) return;
  if (Date.now() - (c.lastNotify || 0) < 5 * 60 * 1000) return;
  try {
    const list = await lk.listParticipants(c.room);
    const teacherPresent = list.some((p) => { try { return JSON.parse(p.metadata || "{}").role === "guru"; } catch { return false; } });
    if (teacherPresent) return;
  } catch { /* ruangan belum ada = belum ada yang masuk */ }

  const all = readJson("classes.json", {});
  if (!all[id]) return;
  all[id].lastNotify = Date.now();
  writeJson("classes.json", all);

  const tokens = c.tokens.slice(-500);
  const label = c.label || c.subject;
  const resp = await fcm.sendEachForMulticast({
    tokens,
    notification: { title: `Kelas ${label} dimulai`, body: `${teacherName} sudah masuk. Ketuk untuk bergabung.` },
    data: { type: "class_start", subject: c.subject },
    android: { priority: "high", ttl: 10 * 60 * 1000, notification: { channelId: "kelas" } },
  });
  const dead = [];
  resp.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (!r.success && ["messaging/registration-token-not-registered", "messaging/invalid-registration-token", "messaging/invalid-argument"].includes(code)) dead.push(tokens[i]);
  });
  if (dead.length) {
    const fresh = readJson("classes.json", {});
    if (fresh[id]) { fresh[id].tokens = (fresh[id].tokens || []).filter((t) => !dead.includes(t)); writeJson("classes.json", fresh); }
  }
}

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
    const subject = toSubject(req.body?.room);
    const cleanName = String(name || "").trim().slice(0, 30);
    if (!subject || !cleanName) return res.status(400).json({ error: "Nama dan pelajaran wajib diisi" });

    const isTeacher = role === "guru";
    const classPin = String(req.body.classPin || "").trim();
    const teacherKey = String(req.body.teacherKey || "").trim();
    const roomLabel = String(req.body.roomLabel || "").trim().slice(0, 60);
    if (blocked(req.ip)) return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi 10 menit lagi." });

    const classes = readJson("classes.json", {});
    const ofSubject = Object.entries(classes).filter(([, c]) => c.subject === subject);
    const pinTaken = (pin, exceptId) => ofSubject.some(([id, c]) => id !== exceptId && checkHash(pin, c.pin));

    let liveRoom, newKey = null, notify = null;

    if (isTeacher) {
      // Kelas milik guru ini (dikenali dari kunci guru yang tersimpan di HP-nya)
      const owned = teacherKey ? ofSubject.find(([, c]) => checkHash(teacherKey, c.owner)) : null;
      if (owned) {
        const [id, c] = owned;
        if (classPin) {
          if (!pinOk(classPin)) return res.status(400).json({ needClassPin: true, error: "PIN murid harus 4-12 angka." });
          if (pinTaken(classPin, id)) { noteFail(req.ip); return res.status(409).json({ needClassPin: true, error: "PIN itu sudah dipakai kelas lain. Pilih PIN lain." }); }
          c.pin = makeHash(classPin);
        }
        if (roomLabel) c.label = roomLabel;
        if (classPin || roomLabel) writeJson("classes.json", classes);
        liveRoom = c.room;
        notify = [id, c];
      } else {
        // Kelas baru
        if (!classPin) return res.status(409).json({ needClassPin: true, staleKey: !!teacherKey, error: "Buat PIN murid untuk kelas ini (4-12 angka)." });
        if (!pinOk(classPin)) return res.status(400).json({ needClassPin: true, error: "PIN murid harus 4-12 angka." });
        if (tooManyCreates(req.ip)) return res.status(429).json({ error: "Terlalu banyak kelas baru dari perangkat ini. Coba lagi nanti." });
        if (pinTaken(classPin)) { noteFail(req.ip); return res.status(409).json({ needClassPin: true, error: "PIN itu sudah dipakai kelas lain. Pilih PIN lain." }); }
        const id = crypto.randomBytes(4).toString("hex");
        newKey = crypto.randomBytes(16).toString("hex");
        classes[id] = { subject, label: roomLabel || subject, room: `${subject}-${id}`, pin: makeHash(classPin), owner: makeHash(newKey), created: Date.now() };
        writeJson("classes.json", classes);
        noteCreate(req.ip);
        liveRoom = classes[id].room;
      }
    } else {
      const found = classPin ? ofSubject.find(([, c]) => checkHash(classPin, c.pin)) : null;
      if (!found) { noteFail(req.ip); return res.status(403).json({ error: "PIN kelas salah, atau guru belum membuka kelas ini. Pastikan nama pelajaran ditulis sama seperti yang ditulis guru." }); }
      liveRoom = found[1].room;
    }

    // Beritahu murid yang sudah mengikuti kelas ini (tidak menunda respons ke guru)
    if (notify) notifyClassStart(notify[0], notify[1], cleanName).catch((e) => console.error("notif:", e.message));

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

// Murid mendaftarkan HP-nya untuk menerima notifikasi kelas ini (harus tahu PIN kelas)
app.post("/register-push", (req, res) => {
  try {
    if (blocked(req.ip)) return res.status(429).json({ error: "Terlalu banyak percobaan." });
    const subject = toSubject(req.body?.room);
    const classPin = String(req.body?.classPin || "").trim();
    const pushToken = String(req.body?.pushToken || "").trim().slice(0, 4096);
    if (!subject || !classPin || !pushToken) return res.status(400).json({ error: "Data tidak lengkap" });
    const classes = readJson("classes.json", {});
    const found = Object.values(classes).find((c) => c.subject === subject && checkHash(classPin, c.pin));
    if (!found) { noteFail(req.ip); return res.status(403).json({ error: "PIN kelas salah" }); }
    found.tokens = [...new Set([...(found.tokens || []), pushToken])].slice(-300);
    writeJson("classes.json", classes);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mendaftar notifikasi" });
  }
});

// Guru menunjuk murid ke layar besar (atau mengakhirinya dengan identity kosong).
// Hanya guru pemilik kelas (punya kunci guru) yang boleh.
app.post("/spotlight", async (req, res) => {
  try {
    if (blocked(req.ip)) return res.status(429).json({ error: "Terlalu banyak percobaan." });
    const subject = toSubject(req.body?.room);
    const teacherKey = String(req.body?.teacherKey || "").trim();
    const identity = req.body?.identity ? String(req.body.identity).slice(0, 120) : null;
    const classes = readJson("classes.json", {});
    const owned = teacherKey ? Object.values(classes).find((c) => c.subject === subject && checkHash(teacherKey, c.owner)) : null;
    if (!owned) { noteFail(req.ip); return res.status(403).json({ error: "Hanya guru kelas ini yang boleh mengatur layar besar." }); }
    await lk.updateRoomMetadata(owned.room, JSON.stringify({ spotlight: identity }));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Gagal mengatur layar besar" });
  }
});

app.listen(PORT, () => console.log(`Token server jalan di port ${PORT}`));
