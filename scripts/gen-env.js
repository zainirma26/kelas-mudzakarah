// Membaca .env (atau environment variable) lalu menulis www/env.js untuk APK.
// Jalankan: node scripts/gen-env.js   (otomatis lewat: npm run sync)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");

const fromFile = {};
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    fromFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
// Environment variable (mis. dari GitHub Actions) menang atas file .env
const get = (k) => (process.env[k] ?? fromFile[k] ?? "").trim();

const SERVER_URL = get("SERVER_URL").replace(/\/$/, "");
const CONFIG_URL = get("CONFIG_URL");

if (!/^https:\/\//.test(SERVER_URL) && !CONFIG_URL) {
  console.error("SERVER_URL belum diisi (harus https://). Salin .env.example menjadi .env lalu isi.");
  process.exit(1);
}

const out = `/* DIBUAT OTOMATIS oleh scripts/gen-env.js dari .env. Jangan diedit. */\nwindow.KELAS_ENV = ${JSON.stringify({ SERVER_URL, CONFIG_URL }, null, 2)};\n`;
fs.writeFileSync(path.join(root, "www", "env.js"), out);
console.log("www/env.js dibuat. Server:", SERVER_URL || "(lewat CONFIG_URL)");
