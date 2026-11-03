-- Meses elegidos en el enlace de pago (impagados y mes en curso).
-- null = enlaces antiguos: la página sigue mostrando solo el mes actual.

alter table public.familia_enlaces
  add column if not exists meses_pago jsonb;

comment on column public.familia_enlaces.meses_pago is
  'Selección [{alumno_id, meses: YYYY-MM}] que ve la familia en /p/:token. null = solo el mes en curso.';
