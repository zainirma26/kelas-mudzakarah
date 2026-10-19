/* Logika aplikasi: masuk kelas, video, mikrofon, kamera. Memakai LiveKit (dimuat dari index.html). */
const $ = (id) => document.getElementById(id);
const { Room, RoomEvent, Track, VideoPresets, ConnectionState } = LivekitClient;

let room = null;
let facing = "user";
let speakerOn = true;   // suara dari peserta lain
let dataSaver = false;  // sembunyikan video murid lain (video guru tetap tampil)
const tiles = new Map();

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
const subj = $("subject"), subjOther = $("subjectOther");
const toggleSubj = () => { subjOther.style.display = subj.value === "__lain" ? "block" : "none"; };
subj.addEventListener("change", toggleSubj);
for (const k of ["userName", "role", "subject", "subjectOther", "pin", "classPin"]) {
  let v = null;
  try { v = localStorage.getItem("kelas_" + k); } catch (e) {}
  if (v) $(k).value = v;
}
toggleSubj();
const togglePin = () => {
  const g = $("role").value === "guru";
  $("pinWrap").style.display = g ? "block" : "none";
  $("classPinTWrap").style.display = g ? "block" : "none";
  $("classPinWrap").style.display = g ? "none" : "block";
  if (!g) { $("pin2Wrap").style.display = "none"; $("pin2").value = ""; }
};
$("role").addEventListener("change", togglePin); togglePin();

// ---------- Masuk ----------
$("joinBtn").addEventListener("click", async () => {
  const userName = $("userName").value.trim();
  const role = $("role").value;
  const pin = $("pin").value;
  const subjectLabel = subj.value === "__lain" ? subjOther.value.trim() : subj.value;
  const roomName = subjectLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  $("err").textContent = "";

  if (!userName) { $("err").textContent = "Isi nama kamu."; return; }
  if (!roomName) { $("err").textContent = "Pilih atau tulis nama pelajaran."; return; }
  if (role === "guru" && !pin) { $("err").textContent = "Masukkan PIN guru."; return; }
  const classPin = (role === "guru" ? $("classPinT").value : $("classPin").value).trim();
  if (role === "murid" && !classPin) { $("err").textContent = "Masukkan PIN kelas dari guru."; return; }
  if (role === "guru" && classPin && !/^\d{4,12}$/.test(classPin)) { $("err").textContent = "PIN murid harus 4-12 angka."; return; }
  const setup = role === "guru" && $("pin2Wrap").style.display === "block";
  if (setup) {
    if (!/^\d{6,12}$/.test(pin)) { $("err").textContent = "PIN baru harus 6-12 angka."; return; }
    if (pin !== $("pin2").value) { $("err").textContent = "Kedua PIN tidak sama."; return; }
  }

  $("joinBtn").disabled = true; $("joinBtn").textContent = "Mencari kelas…";
  const server = await resolveServer();
  $("joinBtn").disabled = false; $("joinBtn").textContent = "Masuk Kelas";
  if (!server) { $("err").textContent = "Tidak dapat terhubung. Periksa internet kamu lalu coba lagi."; return; }

  try {
    for (const [k, v] of Object.entries({ userName, role, subject: subj.value, subjectOther: subjOther.value })) localStorage.setItem("kelas_" + k, v);
    if (role === "guru") localStorage.setItem("kelas_pin", pin);
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
      body: JSON.stringify({ room: roomName, name: userName, role, pin, setup, classPin }),
    });
    const data = await r.json();
    if (r.status === 409 && data.needClassPin) {
      $("classPinT").focus();
      throw new Error(data.error);
    }
    if (r.status === 409 && data.needSetup) {
      $("pin2Wrap").style.display = "block";
      $("pin").value = ""; $("pin").focus();
      throw new Error("PIN guru belum dibuat. Buat PIN baru (6-12 angka): isi PIN, ulangi di kolom bawah, lalu tekan Masuk Kelas.");
    }
    if (!r.ok) throw new Error(data.error || "Gagal mengambil token");
    $("pin2Wrap").style.display = "none"; $("pin2").value = ""; $("classPinT").value = "";
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
}

// ---------- Tampilan ----------
function isTeacher(p) {
  try { return JSON.parse(p.metadata || "{}").role === "guru"; } catch { return false; }
}

function getTile(p) {
  let el = tiles.get(p.identity);
  if (!el) {
    el = document.createElement("div");
    el.className = "tile novideo";
    el.innerHTML = '<video autoplay playsinline muted></video><div class="avatar"></div><span class="muted">🔇</span><span class="name"></span>';
    tiles.set(p.identity, el);
  }
  return el;
}

function refresh() {
  if (!room) return;
  const all = [room.localParticipant, ...room.remoteParticipants.values()];
  const teacher = all.find(isTeacher);
  const stage = $("stage"), strip = $("strip");
  const alive = new Set();

  for (const p of all) {
    alive.add(p.identity);
    const el = getTile(p);
    const target = p === teacher ? stage : strip;
    if (el.parentElement !== target) target.appendChild(el);

    const label = (p.name || p.identity) + (p === room.localParticipant ? " (kamu)" : "") + (p === teacher ? " 👨‍🏫" : "");
    el.querySelector(".name").textContent = label;
    el.querySelector(".avatar").textContent = (p.name || "?").trim().charAt(0).toUpperCase();

    const pubCam = p.getTrackPublication(Track.Source.Camera);
    const pubMic = p.getTrackPublication(Track.Source.Microphone);
    const v = el.querySelector("video");
    if (pubCam && p !== room.localParticipant && p !== teacher && typeof pubCam.setEnabled === "function") {
      pubCam.setEnabled(!dataSaver);
    }
    const hasVideo = pubCam && pubCam.track && !pubCam.isMuted && !(dataSaver && p !== room.localParticipant && p !== teacher);
    if (hasVideo) pubCam.track.attach(v);
    el.classList.toggle("novideo", !hasVideo);
    el.classList.toggle("micoff", !pubMic || pubMic.isMuted);
    v.muted = true; // audio ditangani lewat elemen <audio> terpisah
  }

  tiles.forEach((el, id) => { if (!alive.has(id)) { el.remove(); tiles.delete(id); } });

  $("stageEmpty").style.display = teacher ? "none" : "flex";
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
  room = null;
  $("room").classList.remove("active");
  $("join").classList.add("active");
}
