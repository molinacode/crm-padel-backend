#!/usr/bin/env bash
# Importa el dump public al Postgres de Coolify (socket interno).
# Uso:
#   PG_CONTAINER=ela7voixyyw4waqkttycdanq \
#   ./scripts/import-to-vps.sh crm_padel_public.sql
set -euo pipefail
container="${PG_CONTAINER:-ela7voixyyw4waqkttycdanq}"
dump="${1:-crm_padel_public.sql}"
if [[ ! -f "$dump" ]]; then
  echo "No está $dump. Primero dump-from-supabase.sh"
  exit 1
fi
cat "$dump" | ssh vikey@62.238.57.103 \
  "docker exec -i ${container} psql -U crm_padel -d crm_padel -v ON_ERROR_STOP=1"
echo "Importado. Aplica sql/001_staff.sql y, si hace falta, la migración de grupos."
