-- Votaciones por QR para premios de evento (mejor outfit, puntualidad, etc.).
-- Aplicar en crm_padel tras 017_evento_resultados.sql.

create table if not exists public.evento_votaciones (
  id uuid primary key default gen_random_uuid(),
  edicion_id uuid not null references public.evento_ediciones (id) on delete cascade,
  titulo text not null,
  descripcion text,
  token text not null unique,
  abierta boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists evento_votaciones_edicion_idx
  on public.evento_votaciones (edicion_id);

comment on table public.evento_votaciones is
  'Votación pública por categoría (mejor outfit, puntualidad…). token = slug público del QR.';

create table if not exists public.evento_votacion_opciones (
  id uuid primary key default gen_random_uuid(),
  votacion_id uuid not null references public.evento_votaciones (id) on delete cascade,
  etiqueta text not null,
  inscripcion_id uuid references public.evento_inscripciones (id) on delete set null,
  orden integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists evento_votacion_opciones_votacion_idx
  on public.evento_votacion_opciones (votacion_id);

create table if not exists public.evento_votos (
  id uuid primary key default gen_random_uuid(),
  votacion_id uuid not null references public.evento_votaciones (id) on delete cascade,
  opcion_id uuid not null references public.evento_votacion_opciones (id) on delete cascade,
  huella text not null,
  created_at timestamptz not null default now(),
  constraint evento_votos_unico_por_votante unique (votacion_id, huella)
);

create index if not exists evento_votos_votacion_idx
  on public.evento_votos (votacion_id);
create index if not exists evento_votos_opcion_idx
  on public.evento_votos (opcion_id);

comment on table public.evento_votos is
  'Un voto por votante (huella) y votación. La huella deriva de cookie/token anónimo del votante.';
