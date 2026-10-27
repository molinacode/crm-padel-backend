-- Grupos de clase + capacidad por franja.
-- Aplicar en crm_padel DESPUÉS del pg_dump si el dump no trae grupos.
-- Sin RLS ni rol authenticated (eso era de Supabase).

alter table public.clases
  add column if not exists capacidad_maxima integer default 4;

comment on column public.clases.capacidad_maxima is
  'Aforo de la clase. Particular = 1; grupal por defecto 4.';

create table if not exists public.grupos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nivel text,
  capacidad_maxima integer not null default 4,
  profesor text,
  instalacion_id integer references public.instalaciones (id) on delete set null,
  dia_semana text,
  hora_inicio text,
  hora_fin text,
  color text not null default '#3b82f6',
  activo boolean not null default true,
  observaciones text,
  clase_id uuid references public.clases (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint grupos_capacidad_positiva check (capacidad_maxima >= 1)
);

create index if not exists idx_grupos_dia_hora
  on public.grupos (dia_semana, hora_inicio);

create index if not exists idx_grupos_activo
  on public.grupos (activo);

create table if not exists public.alumnos_grupos (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.grupos (id) on delete cascade,
  alumno_id uuid not null references public.alumnos (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (grupo_id, alumno_id)
);

create index if not exists idx_alumnos_grupos_grupo
  on public.alumnos_grupos (grupo_id);

create index if not exists idx_alumnos_grupos_alumno
  on public.alumnos_grupos (alumno_id);
