#!/bin/sh
# Consistent online backup of the SQLite database (safe while the server is running).
# Usage: deploy/backup.sh  -> writes ./hiscores-YYYYmmdd-HHMM.db
set -eu
cd "$(dirname "$0")"
out="hiscores-$(date +%Y%m%d-%H%M).db"
docker compose exec -T hiscores node -e "
  const D = require('better-sqlite3');
  new D(process.env.DATABASE_PATH, { readonly: true }).backup('/data/backup.db').then(() => console.log('ok'));
"
docker compose cp hiscores:/data/backup.db "$out"
echo "Backup written to $out"
