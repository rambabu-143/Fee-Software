#!/usr/bin/env bash
# Dumps the database in pg_dump custom format and prunes old dumps.
#   DATABASE_URL=postgresql://... scripts/backup.sh
# Env: BACKUP_DIR (default ./backups), BACKUP_KEEP_DAYS (default 14). Prints the dump path; exits non-zero on failure.
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
dir="${BACKUP_DIR:-./backups}"
keep="${BACKUP_KEEP_DAYS:-14}"
mkdir -p "$dir"
out="$dir/fees-$(date +%Y%m%d-%H%M%S).dump"
trap 'rm -f "$out.tmp"' EXIT

# Prisma URLs carry ?schema=public, which pg_dump rejects.
pg_dump --format=custom --no-owner --file "$out.tmp" "${DATABASE_URL%%\?*}"
pg_restore --list "$out.tmp" >/dev/null   # fail now if the dump is unreadable
mv "$out.tmp" "$out"
find "$dir" -name 'fees-*.dump' -mtime +"$keep" -delete
echo "$out"
