-- Cuota de cada mes del curso. 4 semanas = precio_mes de la ficha.
-- Menos semanas (vacaciones, mes corto) prorratea el importe del enlace de pago.

create table if not exists public.cuotas_mes (
  id uuid primary key default gen_random_uuid(),
  curso_id uuid not null references public.cursos (id) on delete cascade,
  mes text not null,
  semanas numeric(4, 1) not null default 4,
  dias_clase integer,
  nota text,
  updated_at timestamptz not null default now(),
  constraint cuotas_mes_mes_check check (mes ~ '^[0-9]{4}-[0-9]{2}$'),
  constraint cuotas_mes_semanas_check check (semanas >= 0 and semanas <= 6),
  constraint cuotas_mes_dias_check check (dias_clase is null or (dias_clase >= 0 and dias_clase <= 31)),
  constraint cuotas_mes_curso_mes_key unique (curso_id, mes)
);

comment on table public.cuotas_mes is
  'Calendario de cobro del curso: semanas de clase, días hábiles y nota de vacaciones.';
comment on column public.cuotas_mes.semanas is
  'Semanas de clase de ese mes. 4 = cuota completa (precio_mes del alumno).';
comment on column public.cuotas_mes.dias_clase is
  'Días hábiles de clase del mes. Informativo; el importe sale de las semanas.';
comment on column public.cuotas_mes.nota is
  'Vacaciones o puente que explica un mes más corto.';
