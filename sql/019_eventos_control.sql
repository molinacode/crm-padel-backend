-- Control de torneo: pago por inscrito, lista de espera, QR de votación por evento,
-- datos del votante y bitácora de todo lo que ocurre en una edición.
-- Aplicar en crm_padel tras 018_evento_votaciones.sql.

alter table public.evento_inscripciones
  add column if not exists importe_pagado_centimos integer,
  add column if not exists metodo_pago text,
  add column if not exists pagado_at timestamptz;

alter table public.evento_inscripciones
  drop constraint if exists evento_inscripciones_estado_check;
alter table public.evento_inscripciones
  add constraint evento_inscripciones_estado_check
  check (estado in ('nuevo', 'revisado', 'confirmado', 'pagado', 'espera', 'rechazado'));

alter table public.evento_inscripciones
  drop constraint if exists evento_inscripciones_importe_chk;
alter table public.evento_inscripciones
  add constraint evento_inscripciones_importe_chk
  check (importe_pagado_centimos is null or importe_pagado_centimos >= 0);

comment on column public.evento_inscripciones.importe_pagado_centimos is
  'Importe cobrado al inscrito (céntimos). Null = sin pago registrado.';

alter table public.evento_ediciones
  add column if not exists votacion_token text;
create unique index if not exists evento_ediciones_votacion_token_idx
  on public.evento_ediciones (votacion_token)
  where votacion_token is not null;

comment on column public.evento_ediciones.votacion_token is
  'Token del QR de votación del evento. Regenerarlo invalida el QR anterior.';

alter table public.evento_votos
  add column if not exists votante_nombre text,
  add column if not exists votante_telefono text;

comment on column public.evento_votos.huella is
  'Teléfono E.164 del votante: un voto por teléfono y votación.';

create table if not exists public.evento_bitacora (
  id uuid primary key default gen_random_uuid(),
  edicion_id uuid not null references public.evento_ediciones (id) on delete cascade,
  tipo text not null,
  descripcion text not null,
  datos jsonb not null default '{}'::jsonb,
  actor_email text,
  actor_rol text,
  created_at timestamptz not null default now()
);

create index if not exists evento_bitacora_edicion_idx
  on public.evento_bitacora (edicion_id, created_at desc);

comment on table public.evento_bitacora is
  'Registro de lo que ocurre en un evento: inscripciones, pagos, resultados, votaciones y notas/incidencias.';
