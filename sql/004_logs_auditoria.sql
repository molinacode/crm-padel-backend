-- Registro de acciones del staff. No venía en el dump de Supabase: la tabla
-- nunca llegó a crearse allí, así que `auditoriaService` avisaba y seguía.
-- `usuario_id` es texto porque ahora el identificador lo pone Zitadel.

create table if not exists public.logs_auditoria (
  id uuid primary key default gen_random_uuid(),
  usuario_id text,
  accion text not null,
  entidad text not null,
  entidad_id text,
  detalle jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_logs_auditoria_created_at
  on public.logs_auditoria (created_at desc);

create index if not exists idx_logs_auditoria_entidad
  on public.logs_auditoria (entidad, entidad_id);
