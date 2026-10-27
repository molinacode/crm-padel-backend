-- Pendiente de horario: alumno activo sin horario confirmado/notificado para el curso.
-- Independiente de activo/baja (eso sigue gobernando deuda y periodos).

alter table public.alumnos
  add column if not exists pendiente_horario boolean not null default false;

comment on column public.alumnos.pendiente_horario is
  'true = a la espera de horario/notificación familiar para el curso; no implica baja.';

create index if not exists idx_alumnos_pendiente_horario
  on public.alumnos (pendiente_horario)
  where pendiente_horario = true and coalesce(activo, true) = true;
