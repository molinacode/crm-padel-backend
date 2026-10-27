-- Configurador P&L + movimientos reales de eventos (impacto Instalaciones).
-- Aplicar tras 012_eventos.sql.

alter table public.evento_ediciones
  add column if not exists config_pyl jsonb not null default '{}'::jsonb;

comment on column public.evento_ediciones.config_pyl is
  'Configurador: { escenarios:{aforo_pct}, ingresos:[{concepto,precio_centimos,unidades,variable}], gastos:[...] }.';

create table if not exists public.evento_movimientos (
  id uuid primary key default gen_random_uuid(),
  edicion_id uuid not null references public.evento_ediciones (id) on delete cascade,
  tipo text not null check (tipo in ('ingreso', 'gasto')),
  concepto text not null,
  cantidad_centimos integer not null check (cantidad_centimos >= 0),
  fecha date not null default (current_date),
  origen text not null default 'manual'
    check (origen in ('manual', 'inscripcion', 'config')),
  inscripcion_id uuid references public.evento_inscripciones (id) on delete set null,
  impacto_instalaciones boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists evento_movimientos_edicion_idx
  on public.evento_movimientos (edicion_id, fecha);
create index if not exists evento_movimientos_inst_idx
  on public.evento_movimientos (impacto_instalaciones, fecha)
  where impacto_instalaciones = true;

comment on table public.evento_movimientos is
  'Ingresos/gastos reales del evento. Con impacto_instalaciones=true entran en el P&L de Instalaciones.';
