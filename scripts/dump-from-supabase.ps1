# Dump del schema public de Supabase (sin auth). PowerShell.
# Uso:
#   $env:SUPABASE_DB_URL = 'postgres://postgres:CLAVE@db.XXX.supabase.co:5432/postgres'
#   .\scripts\dump-from-supabase.ps1
param(
  [string]$OutFile = 'crm_padel_public.sql'
)
if (-not $env:SUPABASE_DB_URL) {
  Write-Error 'Define SUPABASE_DB_URL (Settings → Database → URI directa). No la pegues en el repo.'
  exit 1
}
pg_dump --no-owner --no-acl --schema=public $env:SUPABASE_DB_URL -f $OutFile
Write-Host "Escrito $OutFile. Importar segun servidor/docs/apps/CRM-PADEL-DEPLOY.md seccion 5."
