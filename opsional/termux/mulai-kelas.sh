#!/data/data/com.termux/files/usr/bin/bash
# Menyalakan server token + tunnel HTTPS, lalu menulis alamatnya ke repo kelas-config
# supaya aplikasi menemukannya otomatis. Jalankan:  bash ~/kelas-online/opsional/termux/mulai-kelas.sh

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_REPO="$HOME/kelas-config"

[ -f "$DIR/env.sh" ] || { echo "Belum ada $DIR/env.sh (salin dari env.example.sh lalu isi)"; exit 1; }
[ -d "$CONFIG_REPO/.git" ] || { echo "Repo $CONFIG_REPO belum di-clone. Lihat setup.sh"; exit 1; }
. "$DIR/env.sh"
[ "$TEACHER_PIN" = "GANTI_PIN_RAHASIA" ] && { echo "Ganti TEACHER_PIN di env.sh dulu."; exit 1; }

command -v termux-wake-lock >/dev/null && termux-wake-lock

pkill -f "node server.js" 2>/dev/null
pkill cloudflared 2>/dev/null
sleep 1

cd "$DIR/../server" || exit 1
node server.js > "$HOME/server.log" 2>&1 &
sleep 2
curl -s "http://localhost:${PORT:-3000}/" >/dev/null || { echo "Server gagal jalan. Lihat: cat ~/server.log"; exit 1; }

cloudflared tunnel --url "http://localhost:${PORT:-3000}" > "$HOME/cf.log" 2>&1 &

URL=""
for i in $(seq 1 45); do
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$HOME/cf.log" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done
[ -z "$URL" ] && { echo "Gagal mendapat alamat tunnel. Lihat: cat ~/cf.log"; exit 1; }

cd "$CONFIG_REPO" || exit 1
git pull -q --rebase 2>/dev/null
printf '{"server":"%s"}\n' "$URL" > server.json
git add server.json
git commit -qm "server: $URL" 2>/dev/null
if git push -q; then
  echo
  echo "=============================================="
  echo " KELAS SIAP.  Server: $URL"
  echo " Biarkan Termux tetap terbuka. Tekan Ctrl+C untuk menutup kelas."
  echo "=============================================="
else
  echo "Gagal mengirim alamat ke GitHub (cek token kelas-config)."
  exit 1
fi

# Saat ditutup, kosongkan alamat agar murid tahu kelas belum dibuka.
cleanup() {
  cd "$CONFIG_REPO" && printf '{"server":""}\n' > server.json && git add server.json \
    && git commit -qm "kelas ditutup" && git push -q
  pkill -f "node server.js"; pkill cloudflared
  command -v termux-wake-unlock >/dev/null && termux-wake-unlock
  exit 0
}
trap cleanup INT TERM
wait
