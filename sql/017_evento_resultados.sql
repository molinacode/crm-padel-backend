-- Resultados de partidos por jornada + base para clasificación/ranking.
-- Aplicar en crm_padel tras 016_cuotas_mes.sql.

create table if not exists public.evento_resultados (
  id uuid primary key default gen_random_uuid(),
  edicion_id uuid not null references public.evento_ediciones (id) on delete cascade,
  jornada_id uuid references public.evento_jornadas (id) on delete set null,
  inscripcion_a uuid not null references public.evento_inscripciones (id) on delete cascade,
  inscripcion_b uuid not null references public.evento_inscripciones (id) on delete cascade,
  sets_a integer not null default 0,
  sets_b integer not null default 0,
  juegos_a integer not null default 0,
  juegos_b integer not null default 0,
  walkover boolean not null default false,
  ganador text check (ganador in ('a', 'b', 'empate')),
  notas text,
  created_at timestamptz not null default now(),
  constraint evento_resultados_distintos_chk check (inscripcion_a <> inscripcion_b),
  constraint evento_resultados_sets_chk check (sets_a >= 0 and sets_b >= 0),
  constraint evento_resultados_juegos_chk check (juegos_a >= 0 and juegos_b >= 0)
);

create index if not exists evento_resultados_edicion_idx
  on public.evento_resultados (edicion_id);
create index if not exists evento_resultados_jornada_idx
  on public.evento_resultados (jornada_id);

comment on table public.evento_resultados is
  'Partidos entre dos inscritos de una edición. Base para la clasificación (puntos, sets y juegos a favor/contra).';
comment on column public.evento_resultados.ganador is
  'a | b | empate. Si null se deduce de sets_a vs sets_b al calcular la clasificación.';
