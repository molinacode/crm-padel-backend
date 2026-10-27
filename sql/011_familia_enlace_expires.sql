-- Caducidad de enlaces familiares (esp. pago).
-- Aplicar en crm_padel tras 010_familia_pago.sql.

alter table public.familia_enlaces
  add column if not exists expires_at timestamptz;

comment on column public.familia_enlaces.expires_at is
  'Tras esta fecha el token responde 404. Pago ~45d; horario ~90d (configurable al crear).';

-- Enlaces ya emitidos: dar margen desde created_at.
update public.familia_enlaces
set expires_at = created_at + interval '45 days'
where expires_at is null
  and tipo = 'pago'
  and revoked_at is null;

update public.familia_enlaces
set expires_at = created_at + interval '90 days'
where expires_at is null
  and tipo = 'horario'
  and revoked_at is null;

create index if not exists idx_familia_enlaces_expires
  on public.familia_enlaces (expires_at)
  where revoked_at is null;
