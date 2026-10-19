/* Logika aplikasi: masuk kelas, video, mikrofon, kamera. Memakai LiveKit (dimuat dari index.html). */
const $ = (id) => document.getElementById(id);
const { Room, RoomEvent, Track, VideoPresets, ConnectionState } = LivekitClient;

let room = null;
let facing = "user";
let speakerOn = true;   // suara dari peserta lain
let dataSaver = false;  // sembunyikan video murid lain (video guru tetap tampil)
let myRole = "murid";   // peran di kelas yang sedang berjalan
let session = null;     // { server, room, key } untuk guru mengatur layar besar
let lastSpot = null;    // murid yang sebelumnya tampil di layar besar
const tiles = new Map();

// ---------- Pemberitahuan di dalam aplikasi (banner + getar + bunyi) ----------
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = new AC(); const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(c.destination); o.start();
    setTimeout(() => { try { o.stop(); c.close(); } catch (e) {} }, 350);
  } catch (e) {}
}
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 6000);
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
  beep();
}

// ---------- Suara mikrofon: diperkeras dan diratakan, sama untuk guru dan murid ----------
// Ubah angka di sini (atau lewat KELAS_CONFIG.mic di config.js) jika suara masih kurang/terlalu keras.
// enabled:false = matikan penguatan mikrofon.
const MIC = Object.assign({ enabled: true, gain: 3.0, makeup: 1.6 }, (window.KELAS_CONFIG || {}).mic || {});
function micBooster() {
  let src = null, nodes = [];
  const teardown = () => { try { src && src.disconnect(); nodes.forEach((n) => n.disconnect()); } catch (e) {} src = null; nodes = []; };
  const build = (self, opts) => {
    const ac = opts.audioContext;
    src = ac.createMediaStreamSource(new MediaStream([opts.track]));
    const pre = ac.createGain(); pre.gain.value = MIC.gain;
    const comp = ac.createDynamicsCompressor();   // meratakan: suara pelan dikeraskan, suara keras ditahan
    comp.threshold.value = -35; comp.knee.value = 20; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.25;
    const post = ac.createGain(); post.gain.value = MIC.makeup;
    const lim = ac.createDynamicsCompressor();    // pembatas supaya tidak pecah
    lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = 0.1;
    const dest = ac.createMediaStreamDestination();
    src.connect(pre); pre.connect(comp); comp.connect(post); post.connect(lim); lim.connect(dest);
    nodes = [pre, comp, post, lim];
    self.processedTrack = dest.stream.getAudioTracks()[0];
  };
  return {
    name: "kelas-mic-booster",
    processedTrack: undefined,
    async init(opts) { try { if (opts.audioContext.state === "suspended") await opts.audioContext.resume(); } catch (e) {} build(this, opts); },
    async restart(opts) { teardown(); try { if (opts.audioContext.state === "suspended") await opts.audioContext.resume(); } catch (e) {} build(this, opts); },
    async destroy() { teardown(); },
  };
}

// ---------- Notifikasi push (aplikasi tertutup) ----------
// Aktif jika APK dibangun dengan konfigurasi Firebase (lihat README). Murid perlu masuk kelas sekali
// agar HP-nya terdaftar; setelah itu menerima notifikasi setiap guru memulai pelajaran.
const push = { fcm: "", ready: false };
const pushPlugin = () => (window.KELAS_ENV || {}).PUSH && window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
async function sendPushToken() {
  try {
    const rm = localStorage.getItem("kelas_regRoom"), pin = localStorage.getItem("kelas_regPin");
    if (!push.fcm || !rm || !pin) return;
    const server = await resolveServer(); if (!server) return;
    await fetch(server + "/register-push", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: rm, classPin: pin, pushToken: push.fcm }),
    });
  } catch (e) {}
}
async function initPush(ask) {
  const PN = pushPlugin(); if (!PN) return;
  try {
    let perm = await PN.checkPermissions();
    if (perm.receive !== "granted") {
      if (!ask) return;
      perm = await PN.requestPermissions();
      if (perm.receive !== "granted") return;
    }
    if (!push.ready) {
      push.ready = true;
      try { await PN.createChannel({ id: "kelas", name: "Kelas dimulai", description: "Pemberitahuan saat guru memulai pelajaran", importance: 5, visibility: 1, vibration: true }); } catch (e) {}
      await PN.addListener("registration", (t) => { push.fcm = t.value; sendPushToken(); });
      await PN.addListener("registrationError", (e) => console.warn("push:", e));
      await PN.addListener("pushNotificationReceived", (n) => toast((n.title || "Kelas dimulai") + (n.body ? " — " + n.body : "")));
      await PN.addListener("pushNotificationActionPerformed", (a) => {
        const d = (a.notification && a.notification.data) || {};
        if (d.type !== "class_start") return;
        setTimeout(() => {
          if (room) return;
          if ($("role").value === "murid" && currentRoomName() === d.subject && $("userName").value.trim()) $("joinBtn").click();
        }, 600);
      });
    }
    await PN.register();
  } catch (e) { console.warn("push:", e); }
}

// ---------- Cari alamat server otomatis ----------
// Alamat server dibaca dari file kecil di internet (configUrl), jadi saat server
// berganti alamat, APK TIDAK perlu dibuild ulang dan murid tidak perlu mengetik apa pun.
async function resolveServer() {
  const C = window.KELAS_CONFIG || {};
  const clean = (u) => String(u || "").trim().replace(/\/$/, "");
  const ok = (u) => /^https:\/\//.test(u);
  if (C.configUrl) {
    try {
      const r = await fetch(C.configUrl + "?t=" + Date.now(), { cache: "no-store" });
      const j = await r.json();
      const u = clean(j && j.server);
      if (ok(u)) { try { localStorage.setItem("kelas_lastServer", u); } catch (e) {} return u; }
      return "";   // file terbaca tapi kosong = guru belum membuka kelas
    } catch (e) { /* file tidak terbaca (offline/gangguan): pakai cadangan di bawah */ }
  }
  if (ok(clean(C.defaultServer))) return clean(C.defaultServer);
  try { const l = clean(localStorage.getItem("kelas_lastServer")); return ok(l) ? l : ""; } catch (e) { return ""; }
}

// ---------- Simpan isian terakhir ----------
const subj = $("subject");
// Nama pelajaran ditulis bebas; huruf besar/kecil dan spasi/tanda baca tidak membedakan ("Matematika 7" = "matematika-7")
const currentRoomName = () =>
  subj.value.trim().toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
// Kunci guru: disimpan di HP guru, per pelajaran, supaya hanya HP itu yang bisa masuk lagi sebagai guru kelas tersebut
const keyName = () => "kelas_tk_" + currentRoomName();
const getKey = () => { try { return localStorage.getItem(keyName()) || ""; } catch (e) { return ""; } };
const setKey = (k) => { try { localStorage.setItem(keyName(), k); } catch (e) {} };
const delKey = () => { try { localStorage.removeItem(keyName()); } catch (e) {} };

const updateUi = () => {
  const g = $("role").value === "guru";
  $("classPinTWrap").style.display = g ? "block" : "none";
  $("classPinWrap").style.display = g ? "none" : "block";
  $("classPinTHint").textContent = getKey()
    ? "Kelas ini sudah dibuat di HP ini. Kosongkan untuk memakai PIN yang sama, atau isi untuk mengganti PIN."
    : "Bagikan PIN ini ke murid agar bisa masuk kelasmu.";
};
subj.addEventListener("input", updateUi);
for (const k of ["userName", "role", "subject", "classPin"]) {
  let v = null;
  try { v = localStorage.getItem("kelas_" + k); } catch (e) {}
  if (v) $(k).value = v;
}
$("role").addEventListener("change", updateUi); updateUi();

// ---------- Masuk ----------
$("joinBtn").addEventListener("click", async () => {
  const userName = $("userName").value.trim();
  const role = $("role").value;
  const roomName = currentRoomName();
  $("err").textContent = "";

  if (!userName) { $("err").textContent = "Isi nama kamu."; return; }
  if (!roomName) { $("err").textContent = "Tulis nama mata pelajaran."; return; }
  const classPin = (role === "guru" ? $("classPinT").value : $("classPin").value).trim();
  if (role === "murid" && !classPin) { $("err").textContent = "Masukkan PIN kelas dari guru."; return; }
  if (role === "guru" && classPin && !/^\d{4,12}$/.test(classPin)) { $("err").textContent = "PIN murid harus 4-12 angka."; return; }
  const teacherKey = role === "guru" ? getKey() : "";
  if (role === "guru" && !teacherKey && !classPin) { $("err").textContent = "Buat PIN murid untuk kelas ini (4-12 angka)."; $("classPinT").focus(); return; }

  $("joinBtn").disabled = true; $("joinBtn").textContent = "Mencari kelas…";
  const server = await resolveServer();
  $("joinBtn").disabled = false; $("joinBtn").textContent = "Masuk Kelas";
  if (!server) { $("err").textContent = "Tidak dapat terhubung. Periksa internet kamu lalu coba lagi."; return; }

  try {
    for (const [k, v] of Object.entries({ userName, role, subject: subj.value })) localStorage.setItem("kelas_" + k, v);
    if (role === "murid") localStorage.setItem("kelas_classPin", classPin);
  } catch (e) {}

  $("joinBtn").disabled = true; $("joinBtn").textContent = "Menyambung…";
  const slowHint = setTimeout(() => { $("joinBtn").textContent = "Menyiapkan kelas… (bisa sampai 1 menit)"; }, 6000);
  const ctrl = new AbortController();
  const giveUp = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch(server + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({ room: roomName, roomLabel: subj.value.trim(), name: userName, role, classPin, teacherKey }),
    });
    const data = await r.json();
    if (data.needClassPin) {
      if (data.staleKey) { delKey(); updateUi(); }   // kunci lama tidak dikenali server lagi
      $("classPinT").focus();
      throw new Error(data.staleKey ? "Kelas lama tidak ditemukan di server. Buat PIN murid baru (4-12 angka)." : data.error);
    }
    if (!r.ok) throw new Error(data.error || "Gagal mengambil token");
    if (data.teacherKey) { setKey(data.teacherKey); updateUi(); }
    session = { server, room: roomName, key: data.teacherKey || teacherKey };
    if (role === "murid") {
      // Daftarkan HP ini untuk menerima notifikasi saat guru memulai kelas
      try { localStorage.setItem("kelas_regRoom", roomName); localStorage.setItem("kelas_regPin", classPin); } catch (e) {}
      initPush(true); sendPushToken();
    }
    $("classPinT").value = "";
    await startRoom(data.url, data.token, role);
  } catch (e) {
    $("err").textContent = (e instanceof TypeError || e.name === "AbortError")
      ? "Belum bisa terhubung. Periksa internet kamu, lalu coba lagi sebentar."
      : (e.message || String(e));
  } finally {
    clearTimeout(slowHint); clearTimeout(giveUp);
    $("joinBtn").disabled = false; $("joinBtn").textContent = "Masuk Kelas";
  }
});

async function startRoom(url, token, role) {
  const isTeacher = role === "guru";
  myRole = role; lastSpot = null;
  const CFG = window.KELAS_CONFIG || {};
  const cfg = (isTeacher ? CFG.teacher : CFG.student) || (isTeacher
    ? { height: 720, maxBitrate: 1500000, fps: 30 }
    : { height: 360, maxBitrate: 300000, fps: 24 });

  room = new Room({
    adaptiveStream: true,   // murid hanya menerima resolusi sesuai ukuran tile -> hemat bandwidth, minim delay
    dynacast: true,         // berhenti kirim layer yang tidak ditonton
    videoCaptureDefaults: {
      resolution: { width: Math.round(cfg.height * 16 / 9), height: cfg.height, frameRate: cfg.fps },
      facingMode: "user",
    },
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    publishDefaults: {
      simulcast: true,
      videoCodec: "vp8",
      videoEncoding: { maxBitrate: cfg.maxBitrate, maxFramerate: cfg.fps },
      dtx: true,
      red: true,
    },
  });

  const refreshEvents = [
    RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
    RoomEvent.TrackSubscribed, RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted, RoomEvent.TrackUnmuted,
    RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished,
    RoomEvent.ParticipantMetadataChanged,
  ];
  refreshEvents.forEach((ev) => room.on(ev, refresh));

  // Murid yang sedang menunggu diberi tahu saat guru masuk
  room.on(RoomEvent.ParticipantConnected, (p) => {
    if (myRole !== "guru" && isTeacher_(p)) toast("👨‍🏫 " + (p.name || "Guru") + " sudah masuk. Pelajaran dimulai!");
  });
  // Penunjukan murid ke layar besar (disimpan di metadata ruangan oleh server)
  room.on(RoomEvent.RoomMetadataChanged, () => { handleSpotlight(); refresh(); });

  // Suara mikrofon diperkeras & diratakan (guru dan murid sama)
  room.on(RoomEvent.LocalTrackPublished, (pub) => {
    if (!MIC.enabled || pub.source !== Track.Source.Microphone || !pub.track || pub.track.__boosted) return;
    pub.track.__boosted = true;
    pub.track.setProcessor(micBooster()).catch((e) => console.warn("mic booster:", e));
  });

  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) {
      const el = track.attach();
      el.muted = !speakerOn;
      el.dataset.sid = track.sid;
      document.body.appendChild(el);
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Audio) track.detach().forEach((e) => e.remove());
  });
  room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    const ids = new Set(speakers.map((s) => s.identity));
    tiles.forEach((el, id) => el.classList.toggle("speaking", ids.has(id)));
  });
  room.on(RoomEvent.ConnectionStateChanged, (st) => {
    const map = {
      [ConnectionState.Connected]: "🟢 Terhubung",
      [ConnectionState.Connecting]: "Menyambung…",
      [ConnectionState.Reconnecting]: "🟠 Menyambung ulang…",
      [ConnectionState.Disconnected]: "🔴 Terputus",
    };
    $("status").textContent = map[st] || st;
  });
  room.on(RoomEvent.Disconnected, () => backToJoin());

  await room.connect(url, token);
  // Penting di Android WebView: aktifkan audio playback setelah gesture pengguna
  await room.startAudio().catch(() => {});

  $("join").classList.remove("active");
  $("room").classList.add("active");

  try {
    await room.localParticipant.setCameraEnabled(true);
    await room.localParticipant.setMicrophoneEnabled(isTeacher); // murid mulai dengan mic mati
  } catch (e) {
    alert("Izin kamera/mikrofon ditolak atau tidak tersedia: " + e.message);
  }
  updateButtons();
  refresh();
  handleSpotlight();
  if (isTeacher) toast("Ketuk kotak murid untuk menampilkannya di layar besar.");
}

// ---------- Tampilan ----------
function isTeacher_(p) {
  try { return JSON.parse(p.metadata || "{}").role === "guru"; } catch { return false; }
}

function spotlightId() {
  try { return (JSON.parse((room && room.metadata) || "{}")).spotlight || null; } catch (e) { return null; }
}

// Murid yang ditunjuk: mikrofon & kamera dinyalakan otomatis; setelah selesai, mikrofon dimatikan lagi
async function handleSpotlight() {
  if (!room || myRole === "guru") { lastSpot = spotlightId(); return; }
  const sid = spotlightId(), me = room.localParticipant.identity, lp = room.localParticipant;
  if (sid === me && lastSpot !== me) {
    toast("🎤 Kamu tampil di layar besar. Mikrofon & kamera dinyalakan.");
    try { await lp.setMicrophoneEnabled(true); await lp.setCameraEnabled(true); } catch (e) {}
    updateButtons(); refresh();
  } else if (lastSpot === me && sid !== me) {
    try { await lp.setMicrophoneEnabled(false); } catch (e) {}
    updateButtons(); refresh();
  }
  lastSpot = sid;
}

async function sendSpotlight(identity) {
  if (!session) return;
  try {
    const r = await fetch(session.server + "/spotlight", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: session.room, teacherKey: session.key, identity }),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); toast(d.error || "Gagal mengatur layar besar."); }
  } catch (e) { toast("Tidak terhubung ke server."); }
}

function onTileClick(id) {
  if (!room || myRole !== "guru" || !session) return;
  if (id === room.localParticipant.identity || id === spotlightId()) return;
  const p = [...room.remoteParticipants.values()].find((x) => x.identity === id);
  if (!p || isTeacher_(p)) return;
  if (confirm("Tampilkan " + (p.name || "murid ini") + " di layar besar untuk presentasi?")) sendSpotlight(id);
}
$("endSpot").addEventListener("click", () => sendSpotlight(null));

function getTile(p) {
  let el = tiles.get(p.identity);
  if (!el) {
    el = document.createElement("div");
    el.className = "tile novideo";
    el.dataset.id = p.identity;
    el.innerHTML = '<video autoplay playsinline muted></video><div class="avatar"></div><span class="muted">🔇</span><span class="name"></span>';
    el.addEventListener("click", () => onTileClick(el.dataset.id));
    tiles.set(p.identity, el);
  }
  return el;
}

function refresh() {
  if (!room) return;
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  const teacher = all.find(isTeacher_);
  const sid = spotlightId();
  const spotP = sid ? all.find((p) => p.identity === sid && p !== teacher) : null;
  const featured = spotP || teacher;   // yang tampil di layar besar: murid yang ditunjuk, atau guru
  const stage = $("stage"), strip = $("strip");
  const alive = new Set();

  for (const p of all) {
    alive.add(p.identity);
    const el = getTile(p);
    const target = p === featured ? stage : strip;
    if (el.parentElement !== target) target.appendChild(el);

    const label = (p.name || p.identity) + (p === room.localParticipant ? " (kamu)" : "") + (p === teacher ? " 👨‍🏫" : "");
    el.querySelector(".name").textContent = label;
    el.querySelector(".avatar").textContent = (p.name || "?").trim().charAt(0).toUpperCase();

    const pubCam = p.getTrackPublication(Track.Source.Camera);
    const pubMic = p.getTrackPublication(Track.Source.Microphone);
    const v = el.querySelector("video");
    const hidden = dataSaver && p !== room.localParticipant && p !== teacher && p !== featured;
    if (pubCam && p !== room.localParticipant && p !== teacher && typeof pubCam.setEnabled === "function") {
      pubCam.setEnabled(!hidden);
    }
    const hasVideo = pubCam && pubCam.track && !pubCam.isMuted && !hidden;
    if (hasVideo) pubCam.track.attach(v);
    el.classList.toggle("novideo", !hasVideo);
    el.classList.toggle("micoff", !pubMic || pubMic.isMuted);
    v.muted = true; // audio ditangani lewat elemen <audio> terpisah
  }

  tiles.forEach((el, id) => { if (!alive.has(id)) { el.remove(); tiles.delete(id); } });

  $("stageEmpty").style.display = featured ? "none" : "flex";
  $("endSpot").style.display = myRole === "guru" && spotP ? "block" : "none";
  $("count").textContent = "👥 " + all.length;
}

function updateButtons() {
  const lp = room.localParticipant;
  $("micBtn").classList.toggle("off", !lp.isMicrophoneEnabled);
  $("micBtn").textContent = lp.isMicrophoneEnabled ? "🎤" : "🔇";
  $("camBtn").classList.toggle("off", !lp.isCameraEnabled);
  $("camBtn").textContent = lp.isCameraEnabled ? "📷" : "🚫";
  $("spkBtn").classList.toggle("off", !speakerOn);
  $("spkBtn").textContent = speakerOn ? "🔊" : "🔈";
  $("saveBtn").classList.toggle("off", dataSaver);
}

$("micBtn").addEventListener("click", async () => {
  try {
    await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled);
  } catch (e) { alert("Tidak bisa mengakses mikrofon. Cek izin aplikasi di Pengaturan HP.\n" + e.message); }
  updateButtons(); refresh();
});
$("camBtn").addEventListener("click", async () => {
  try {
    await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
  } catch (e) { alert("Tidak bisa mengakses kamera. Cek izin aplikasi di Pengaturan HP.\n" + e.message); }
  updateButtons(); refresh();
});
$("spkBtn").addEventListener("click", () => {
  speakerOn = !speakerOn;
  document.querySelectorAll("audio").forEach((a) => { a.muted = !speakerOn; });
  updateButtons();
});
$("saveBtn").addEventListener("click", () => {
  dataSaver = !dataSaver;
  updateButtons(); refresh();
});
$("flipBtn").addEventListener("click", async () => {
  facing = facing === "user" ? "environment" : "user";
  const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
  try { await pub?.videoTrack?.restartTrack({ facingMode: facing }); } catch (e) { console.warn(e); }
  refresh();
});
$("leaveBtn").addEventListener("click", () => room && room.disconnect());

function backToJoin() {
  document.querySelectorAll("audio").forEach((a) => a.remove());
  tiles.forEach((el) => el.remove()); tiles.clear();
  room = null; session = null; lastSpot = null;
  $("endSpot").style.display = "none";
  $("room").classList.remove("active");
  $("join").classList.add("active");
}

// Saat aplikasi dibuka: perbarui pendaftaran notifikasi jika izin sudah diberikan sebelumnya
initPush(false);
