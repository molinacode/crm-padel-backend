-- Pagos: una operación bancaria puede cubrir varios meses o varios pagadores,
-- y revisión de duplicados entre pagos a mano e importados del banco.
-- Aplicar en crm_padel tras 019_eventos_control.sql.

alter table public.pagos
  add column if not exists operacion_id uuid;

comment on column public.pagos.operacion_id is
  'Agrupa las filas que salen de una sola operación (varios meses y/o varios pagadores).';

create index if not exists idx_pagos_operacion
  on public.pagos (operacion_id)
  where operacion_id is not null;

create index if not exists idx_pagos_alumno_fecha
  on public.pagos (alumno_id, fecha_pago);

-- Pares revisados a mano que NO son duplicado (no se vuelven a proponer).
-- pago_a < pago_b para que el par sea único sin importar el orden.
create table if not exists public.pagos_duplicados_descartados (
  pago_a uuid not null references public.pagos (id) on delete cascade,
  pago_b uuid not null references public.pagos (id) on delete cascade,
  actor_email text,
  created_at timestamptz not null default now(),
  primary key (pago_a, pago_b),
  constraint pagos_duplicados_orden_check check (pago_a < pago_b)
);

comment on table public.pagos_duplicados_descartados is
  'Pares de pagos parecidos que el staff ha marcado como legítimos (no duplicados).';

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'crm_padel') then
    alter table public.pagos_duplicados_descartados owner to crm_padel;
  end if;
end
$$;
