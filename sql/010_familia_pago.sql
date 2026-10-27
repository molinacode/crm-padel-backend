-- Enlaces de pago familiares + cobro en ficha de alumno.
-- Aplicar en crm_padel tras 009_pendiente_horario.sql.

-- --- Ficha alumno: modalidad y precios ---
alter table public.alumnos
  add column if not exists modalidad_cobro text;

alter table public.alumnos
  add column if not exists iberdrola boolean not null default false;

alter table public.alumnos
  add column if not exists precio_clase numeric(10, 2);

alter table public.alumnos
  add column if not exists precio_mes numeric(10, 2);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'alumnos_modalidad_cobro_check'
  ) then
    alter table public.alumnos
      add constraint alumnos_modalidad_cobro_check
      check (
        modalidad_cobro is null
        or modalidad_cobro in ('mensual', 'turno_suelta')
      );
  end if;
end $$;

comment on column public.alumnos.modalidad_cobro is
  'mensual = cuota del mes; turno_suelta = paga por clase/turno.';
comment on column public.alumnos.iberdrola is
  'true = convenio Iberdrola; el cobro no va por Bizum/transferencia de la academia.';
comment on column public.alumnos.precio_clase is
  'Precio unitario de una clase/turno (€).';
comment on column public.alumnos.precio_mes is
  'Cuota mensual (€) cuando modalidad_cobro = mensual.';

-- --- familia_enlaces: tipo horario|pago + notified_at ---
alter table public.familia_enlaces
  add column if not exists tipo text;

alter table public.familia_enlaces
  add column if not exists notified_at timestamptz;

update public.familia_enlaces
set tipo = 'horario'
where tipo is null;

alter table public.familia_enlaces
  alter column tipo set default 'horario';

alter table public.familia_enlaces
  alter column tipo set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'familia_enlaces_tipo_check'
  ) then
    alter table public.familia_enlaces
      add constraint familia_enlaces_tipo_check
      check (tipo in ('horario', 'pago'));
  end if;
end $$;

comment on column public.familia_enlaces.tipo is
  'horario → /h/:token ; pago → /p/:token';
comment on column public.familia_enlaces.notified_at is
  'Cuando el staff abrió WhatsApp / marcó el enlace como enviado.';

-- Un activo por (teléfono, tipo). Sustituye el índice solo por teléfono.
drop index if exists public.idx_familia_enlaces_tel_activo;

create unique index if not exists idx_familia_enlaces_tel_tipo_activo
  on public.familia_enlaces (telefono_e164, tipo)
  where revoked_at is null;
