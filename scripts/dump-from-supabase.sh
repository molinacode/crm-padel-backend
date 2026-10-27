#!/usr/bin/env bash
# Dump del schema public de Supabase (sin auth).
# Uso:
#   SUPABASE_DB_URL='postgres://postgres:CLAVE@db.XXX.supabase.co:5432/postgres' \
#   ./scripts/dump-from-supabase.sh
set -euo pipefail
if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
  echo "Define SUPABASE_DB_URL (Settings → Database → URI directa). No la pegues en el repo."
  exit 1
fi
out="${1:-crm_padel_public.sql}"
pg_dump --no-owner --no-acl --schema=public "$SUPABASE_DB_URL" -f "$out"
echo "Escrito $out. Importar según servidor/docs/apps/CRM-PADEL-DEPLOY.md §5."
