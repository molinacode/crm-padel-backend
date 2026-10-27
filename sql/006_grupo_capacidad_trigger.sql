-- Impide superar capacidad_maxima al insertar en alumnos_grupos (race-safe).
-- Aplicar en crm_padel tras 003_grupos-y-capacidad.sql.

create or replace function public.fn_check_grupo_capacidad()
returns trigger
language plpgsql
as $$
declare
  max_cap integer;
  cur_count integer;
begin
  select capacidad_maxima into max_cap
  from public.grupos
  where id = new.grupo_id
  for update;

  if max_cap is null then
    raise exception 'Grupo no encontrado';
  end if;

  select count(*)::int into cur_count
  from public.alumnos_grupos
  where grupo_id = new.grupo_id;

  if cur_count >= max_cap then
    raise exception 'Grupo lleno (capacidad maxima %)', max_cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_grupo_capacidad on public.alumnos_grupos;
create trigger trg_grupo_capacidad
  before insert on public.alumnos_grupos
  for each row
  execute function public.fn_check_grupo_capacidad();
