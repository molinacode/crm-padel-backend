-- Enlace mágico de horarios para familias (consulta pública por token).
-- Aplicar en crm_padel tras 007_alumno_periodos.sql.

-- Teléfono normalizado (E.164) para agrupar padre/hijos en el mismo enlace.
alter table public.alumnos
  add column if not exists telefono_e164 text;

comment on column public.alumnos.telefono_e164 is
  'Teléfono en E.164 (+34…). Varios alumnos con el mismo valor comparten enlace familiar.';

create or replace function public.normalizar_telefono_e164(raw text)
returns text
language plpgsql
immutable
as $$
declare
  d text;
begin
  if raw is null or btrim(raw) = '' then
    return null;
  end if;
  d := regexp_replace(raw, '[^0-9+]', '', 'g');
  if left(d, 1) = '+' then
    d := '+' || regexp_replace(substr(d, 2), '[^0-9]', '', 'g');
  else
    d := regexp_replace(d, '[^0-9]', '', 'g');
    if d like '00%' then
      d := '+' || substr(d, 3);
    elsif length(d) = 9 and d ~ '^[67]' then
      d := '+34' || d;
    elsif length(d) = 11 and d like '34%' then
      d := '+' || d;
    else
      return null;
    end if;
  end if;
  if length(d) < 10 or length(d) > 16 then
    return null;
  end if;
  return d;
end;
$$;

create or replace function public.trg_alumnos_telefono_e164()
returns trigger
language plpgsql
as $$
begin
  new.telefono_e164 := public.normalizar_telefono_e164(new.telefono);
  return new;
end;
$$;

drop trigger if exists trg_alumnos_telefono_e164 on public.alumnos;
create trigger trg_alumnos_telefono_e164
  before insert or update of telefono on public.alumnos
  for each row
  execute function public.trg_alumnos_telefono_e164();

-- Si cambia el teléfono y nadie más queda con el E.164 anterior, revoca el enlace.
create or replace function public.trg_alumnos_revocar_enlace_telefono()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and old.telefono_e164 is not null
     and old.telefono_e164 is distinct from new.telefono_e164
     and not exists (
       select 1
       from public.alumnos a
       where a.telefono_e164 = old.telefono_e164
         and a.id is distinct from new.id
     )
  then
    update public.familia_enlaces
    set revoked_at = now()
    where telefono_e164 = old.telefono_e164
      and revoked_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_alumnos_revocar_enlace_telefono on public.alumnos;
create trigger trg_alumnos_revocar_enlace_telefono
  after update of telefono on public.alumnos
  for each row
  execute function public.trg_alumnos_revocar_enlace_telefono();

update public.alumnos
set telefono_e164 = public.normalizar_telefono_e164(telefono)
where telefono_e164 is distinct from public.normalizar_telefono_e164(telefono);

create index if not exists idx_alumnos_telefono_e164
  on public.alumnos (telefono_e164)
  where telefono_e164 is not null;

-- Token opaco del enlace (capacidad). Revocable; uno activo por teléfono.
create table if not exists public.familia_enlaces (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  telefono_e164 text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

create unique index if not exists idx_familia_enlaces_tel_activo
  on public.familia_enlaces (telefono_e164)
  where revoked_at is null;

create index if not exists idx_familia_enlaces_token
  on public.familia_enlaces (token)
  where revoked_at is null;

-- Solicitudes de cambio de horario desde la página pública.
create table if not exists public.familia_solicitudes (
  id uuid primary key default gen_random_uuid(),
  enlace_id uuid references public.familia_enlaces (id) on delete set null,
  telefono_e164 text not null,
  mensaje text not null,
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'visto', 'cerrado')),
  created_at timestamptz not null default now()
);

create index if not exists idx_familia_solicitudes_estado
  on public.familia_solicitudes (estado, created_at desc);
