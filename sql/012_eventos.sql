-- Eventos de academia (liga, copas, ranking). Distintos de eventos_clase.
-- Aplicar en crm_padel tras 011_familia_enlace_expires.sql.

create extension if not exists pgcrypto;

create table if not exists public.evento_tipos (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  nombre text not null,
  subtitle text,
  theme text,
  color text,
  accent text,
  form_schema jsonb not null default '[]'::jsonb,
  marketing jsonb not null default '{}'::jsonb,
  orden integer not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.evento_tipos is
  'Plantillas de evento de temporada (Liga Femenina, Prince Cup, Ranking Mixto…).';
comment on column public.evento_tipos.form_schema is
  'JSON array de campos del formulario público: [{key,label,type,required,options?}].';

create table if not exists public.evento_ediciones (
  id uuid primary key default gen_random_uuid(),
  tipo_id uuid not null references public.evento_tipos (id) on delete restrict,
  nombre text not null,
  temporada text,
  fecha_inicio date,
  fecha_fin date,
  publicado boolean not null default false,
  inscripcion_abierta boolean not null default false,
  aforo integer,
  precio_centimos integer,
  cartel_path text,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evento_ediciones_aforo_chk check (aforo is null or aforo > 0),
  constraint evento_ediciones_precio_chk check (precio_centimos is null or precio_centimos >= 0)
);

create index if not exists evento_ediciones_tipo_idx on public.evento_ediciones (tipo_id);
create index if not exists evento_ediciones_pub_idx
  on public.evento_ediciones (publicado, inscripcion_abierta);

comment on column public.evento_ediciones.inscripcion_abierta is
  'Si false, la landing no acepta POST de inscripción (form cerrado).';
comment on column public.evento_ediciones.cartel_path is
  'Ruta del cartel vigente (último subido). S2+ puede pasar a evento_carteles.';

create table if not exists public.evento_jornadas (
  id uuid primary key default gen_random_uuid(),
  edicion_id uuid not null references public.evento_ediciones (id) on delete cascade,
  nombre text,
  fecha date not null,
  hora_inicio time,
  hora_fin time,
  notas text,
  created_at timestamptz not null default now()
);

create index if not exists evento_jornadas_edicion_fecha_idx
  on public.evento_jornadas (edicion_id, fecha);

create table if not exists public.evento_inscripciones (
  id uuid primary key default gen_random_uuid(),
  edicion_id uuid not null references public.evento_ediciones (id) on delete cascade,
  nombre text not null,
  apellidos text not null,
  telefono_e164 text not null,
  nivel text,
  payload jsonb not null default '{}'::jsonb,
  estado text not null default 'nuevo'
    check (estado in ('nuevo', 'revisado', 'confirmado', 'pagado', 'rechazado')),
  alumno_id uuid references public.alumnos (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists evento_inscripciones_edicion_idx
  on public.evento_inscripciones (edicion_id, created_at desc);
create index if not exists evento_inscripciones_tel_idx
  on public.evento_inscripciones (telefono_e164);

comment on table public.evento_inscripciones is
  'Leads/inscritos desde la landing. No crean alumno CRM automáticamente.';

-- Seed tipos temporada 2026/27 (idempotente por slug).
insert into public.evento_tipos (slug, nombre, subtitle, theme, color, accent, orden, form_schema, marketing)
values
  (
    'liga-femenina',
    'Liga Femenina',
    'Iniciación · Liga social',
    'fem',
    '#8B1538',
    '#C9A658',
    1,
    '[
      {"key":"nombre","label":"Nombre","type":"text","required":true},
      {"key":"apellidos","label":"Apellidos","type":"text","required":true},
      {"key":"telefono","label":"Teléfono","type":"tel","required":true},
      {"key":"nivel","label":"Nivel de juego","type":"select","required":true,
       "options":["Iniciación","Medio","Avanzado"]}
    ]'::jsonb,
    '{
      "headline":"Liga social. Sin presión. Toda la temporada.",
      "pitch":"Para jugar, conocer gente y competir sin el peso de una liga federada.",
      "frequency":"Cada 6 semanas",
      "season":"Septiembre — mayo"
    }'::jsonb
  ),
  (
    'prince-padel-cup',
    'Prince Padel Cup',
    'Infantil · 10-16 años · No federados',
    'prince',
    '#0A0A0A',
    '#FFD23F',
    2,
    '[
      {"key":"nombre","label":"Nombre","type":"text","required":true},
      {"key":"apellidos","label":"Apellidos","type":"text","required":true},
      {"key":"telefono","label":"Teléfono tutor","type":"tel","required":true},
      {"key":"nivel","label":"Nivel","type":"select","required":true,
       "options":["Iniciación","Medio"]},
      {"key":"edad","label":"Edad","type":"number","required":true},
      {"key":"tutor","label":"Nombre del tutor","type":"text","required":true}
    ]'::jsonb,
    '{
      "headline":"Cada partido, una carta. Cada carta, otra historia.",
      "pitch":"Liga infantil de iniciación, 10 a 16 años, sin ficha federativa.",
      "frequency":"Cada 6 semanas",
      "season":"Copa Otoño · Copa Primavera"
    }'::jsonb
  ),
  (
    'ranking-mixto',
    'Ranking Mixto',
    'Nivel medio · Mixto · Pozo',
    'mixto',
    '#0F1B3D',
    '#C6FF3D',
    3,
    '[
      {"key":"nombre","label":"Nombre","type":"text","required":true},
      {"key":"apellidos","label":"Apellidos","type":"text","required":true},
      {"key":"telefono","label":"Teléfono","type":"tel","required":true},
      {"key":"nivel","label":"Nivel de juego","type":"select","required":true,
       "options":["Medio","Medio-alto","Avanzado"]}
    ]'::jsonb,
    '{
      "headline":"Pozo mixto. Te apuntas cuando quieres.",
      "pitch":"Partidos cortos, cambio de pareja y de pista. Sin compromiso de toda la temporada.",
      "frequency":"Cada 3 semanas",
      "season":"Septiembre — mayo"
    }'::jsonb
  )
on conflict (slug) do update set
  nombre = excluded.nombre,
  subtitle = excluded.subtitle,
  theme = excluded.theme,
  color = excluded.color,
  accent = excluded.accent,
  orden = excluded.orden,
  form_schema = excluded.form_schema,
  marketing = excluded.marketing,
  updated_at = now();
