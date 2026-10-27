-- Reservas de pista por edición/jornada + seed pistas básicas.
-- Aplicar tras 013_eventos_pyl.sql.

insert into public.instalaciones (nombre, tipo, capacidad, precio_hora)
select v.nombre, v.tipo, v.capacidad, v.precio_hora
from (values
  ('Pista 1', 'pista', 4, null::numeric),
  ('Pista 2', 'pista', 4, null::numeric),
  ('Pista 3', 'pista', 4, null::numeric),
  ('Pista 4', 'pista', 4, null::numeric)
) as v(nombre, tipo, capacidad, precio_hora)
where not exists (
  select 1 from public.instalaciones i where i.nombre = v.nombre
);

create table if not exists public.evento_reservas (
  id uuid primary key default gen_random_uuid(),
  edicion_id uuid not null references public.evento_ediciones (id) on delete cascade,
  jornada_id uuid references public.evento_jornadas (id) on delete set null,
  instalacion_id integer references public.instalaciones (id) on delete set null,
  pista_nombre text,
  fecha date not null,
  hora_inicio time not null,
  hora_fin time not null,
  estado text not null default 'reservada'
    check (estado in ('reservada', 'cancelada')),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evento_reservas_hora_chk check (hora_fin > hora_inicio)
);

create index if not exists evento_reservas_edicion_fecha_idx
  on public.evento_reservas (edicion_id, fecha);
create index if not exists evento_reservas_fecha_pista_idx
  on public.evento_reservas (fecha, instalacion_id)
  where estado = 'reservada';
create index if not exists evento_reservas_jornada_idx
  on public.evento_reservas (jornada_id);

comment on table public.evento_reservas is
  'Franjas de pista reservadas por un evento. Conflictos se detectan vs eventos_clase (misma fecha, solape horario).';
