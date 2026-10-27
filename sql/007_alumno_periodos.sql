-- Historial de periodos de alta/baja de alumnos.
-- fecha_fin NULL = periodo de alta abierto (alumno activo ahora).
-- Las deudas solo se generan en meses que solapan un periodo de alta;
-- al pasar a baja se cierra el periodo y no se generan deudas nuevas,
-- pero las de meses de alta sin pago se siguen calculando.

create table if not exists public.alumno_periodos (
  id uuid primary key default gen_random_uuid(),
  alumno_id uuid not null references public.alumnos (id) on delete cascade,
  fecha_inicio date not null,
  fecha_fin date null,
  created_at timestamptz not null default now(),
  constraint alumno_periodos_fechas check (
    fecha_fin is null or fecha_fin >= fecha_inicio
  )
);

create index if not exists idx_alumno_periodos_alumno
  on public.alumno_periodos (alumno_id);

create unique index if not exists idx_alumno_periodos_un_abierto
  on public.alumno_periodos (alumno_id)
  where fecha_fin is null;

-- Backfill: un periodo por alumno según estado actual.
insert into public.alumno_periodos (alumno_id, fecha_inicio, fecha_fin)
select
  a.id,
  coalesce(a.created_at::date, current_date),
  case
    when a.activo is false then coalesce(a.fecha_baja, current_date)
    else null
  end
from public.alumnos a
where not exists (
  select 1 from public.alumno_periodos p where p.alumno_id = a.id
);
