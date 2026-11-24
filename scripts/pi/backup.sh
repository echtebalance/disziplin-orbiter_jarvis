#!/usr/bin/env bash
# Tägliche Sicherung der Datenbank (läuft per systemd-Timer auf dem Pi).
# Behält die letzten 14 Sicherungen in ~/echte-balance-backups.
# Wiederherstellen: pg_restore --clean --if-exists -d "$DATABASE_URL" <datei>.dump
set -euo pipefail
cd "$(dirname "$0")/../.."
DATABASE_URL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)
DIR="$HOME/echte-balance-backups"
mkdir -p "$DIR"
chmod 700 "$DIR"
FILE="$DIR/echte_balance-$(date +%Y-%m-%d_%H%M).dump"
pg_dump -Fc -d "$DATABASE_URL" -f "$FILE"
chmod 600 "$FILE"
ls -1t "$DIR"/echte_balance-*.dump | tail -n +15 | xargs -r rm --
echo "Sicherung: $FILE ($(du -h "$FILE" | cut -f1))"
