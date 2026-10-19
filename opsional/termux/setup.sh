#!/data/data/com.termux/files/usr/bin/bash
# Jalankan SEKALI di Termux:  bash ~/kelas-online/opsional/termux/setup.sh
set -e
pkg update -y && pkg upgrade -y
pkg install -y nodejs git cloudflared

cd ~/kelas-online/server
npm install

if [ ! -f ~/kelas-online/opsional/termux/env.sh ]; then
  cp ~/kelas-online/opsional/termux/env.example.sh ~/kelas-online/opsional/termux/env.sh
  echo
  echo "Dibuat: ~/kelas-online/opsional/termux/env.sh"
  echo "Isi dulu data LiveKit dan PIN guru:  nano ~/kelas-online/opsional/termux/env.sh"
fi

echo
echo "Selanjutnya clone repo konfigurasi (ganti TOKEN_ANDA):"
echo "  git clone https://zainirma26:TOKEN_ANDA@github.com/zainirma26/kelas-config.git ~/kelas-config"
echo "  git config --global user.name kelas"
echo "  git config --global user.email kelas@example.com"
