#!/usr/bin/env bash
# Neue Version auf den Raspberry Pi bringen (vom PC aus, in Git Bash):  npm run deploy:pi
# Überträgt den letzten Commit (ohne .env, ohne GitHub), sichert vorher die Datenbank,
# installiert Pakete, spielt Migrationen ein und startet den Bot neu.
set -euo pipefail
cd "$(dirname "$0")/.."
# Zugang zum Pi steht in der lokalen .env (nicht im Repository): PI_SSH=benutzer@adresse, optional PI_KEY=Pfad
env_value() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '' || true; }
PI="${PI_SSH:-$(env_value PI_SSH)}"
KEY="${PI_KEY:-$(env_value PI_KEY)}"
KEY="${KEY:-$HOME/.ssh/echte_balance_pi}"
if [ -z "$PI" ]; then
  echo "❌ PI_SSH fehlt in der .env (z. B. PI_SSH=benutzer@192.168.0.10)."
  exit 1
fi
SSH=(ssh -i "$KEY" -o BatchMode=yes "$PI")

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "❌ Es gibt nicht committete Änderungen. Bitte zuerst committen - übertragen wird nur der letzte Commit."
  exit 1
fi
echo "▶ Übertrage $(git log -1 --format='%h %s')"
git archive --format=tar HEAD | "${SSH[@]}" 'cd ~/echte-balance && tar -x'
"${SSH[@]}" 'set -e
  cd ~/echte-balance
  chmod +x scripts/pi/*.sh
  ./scripts/pi/backup.sh
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  node --env-file=.env packages/db/src/migrate.ts
  sudo systemctl restart echte-balance-bot
  sleep 8
  systemctl is-active echte-balance-bot >/dev/null && echo "✅ Bot läuft" || { echo "❌ Bot läuft nicht:"; journalctl -u echte-balance-bot -n 20 --no-pager; exit 1; }'
