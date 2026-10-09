#!/usr/bin/env bash
# Restores a dump made by backup.sh into the database in DATABASE_URL. DESTRUCTIVE: existing objects
# in that database are dropped first, so it needs CONFIRM=yes.
#   CONFIRM=yes DATABASE_URL=postgresql://.../target scripts/restore.sh backups/fees-20261009-120000.dump
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
dump="${1:?usage: restore.sh <dump-file>}"
[ -f "$dump" ] || { echo "no such file: $dump" >&2; exit 1; }
url="${DATABASE_URL%%\?*}"
[ "${CONFIRM:-}" = yes ] || { echo "This replaces everything in ${url##*/}. Re-run with CONFIRM=yes." >&2; exit 1; }
pg_restore --clean --if-exists --no-owner --exit-on-error --dbname "$url" "$dump"
echo "restored $dump into ${url##*/}"
