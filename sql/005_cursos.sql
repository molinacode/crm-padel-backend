-- Curso escolar: uno abierto, el resto cerrado. Las fechas no se solapan.
-- El curso ya usado se crea abierto, con las fechas de las clases existentes.

create table if not exists public.cursos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  fecha_inicio date not null,
  fecha_fin date not null,
  estado text not null default 'abierto',
  created_at timestamptz not null default now(),
  constraint cursos_estado check (estado in ('abierto', 'cerrado')),
  constraint cursos_fechas check (fecha_inicio <= fecha_fin)
);

create unique index if not exists cursos_solo_un_abierto
  on public.cursos (estado)
  where estado = 'abierto';

alter table public.clases
  add column if not exists curso_id uuid references public.cursos (id);

create index if not exists idx_clases_curso_id
  on public.clases (curso_id);

do $$
declare
  ini date;
  fin date;
  titulo text;
  nuevo uuid;
begin
  if exists (select 1 from public.cursos) then
    return;
  end if;

  select min(fecha_inicio)::date, max(fecha_fin)::date
    into ini, fin
  from public.clases
  where fecha_inicio is not null
    and fecha_fin is not null;

  if ini is null or fin is null then
    return;
  end if;

  if extract(year from ini) = extract(year from fin) then
    titulo := 'Curso ' || to_char(ini, 'YYYY');
  else
    titulo := 'Curso ' || to_char(ini, 'YYYY') || '-' || to_char(fin, 'YYYY');
  end if;

  insert into public.cursos (nombre, fecha_inicio, fecha_fin, estado)
  values (titulo, ini, fin, 'abierto')
  returning id into nuevo;

  update public.clases
  set curso_id = nuevo
  where curso_id is null;
end $$;
