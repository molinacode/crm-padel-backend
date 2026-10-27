-- Staff local al CRM (mapeo Zitadel → perfil).
-- Aplicar en la base crm_padel DESPUÉS del pg_dump de public.
-- El dump de Supabase no trae esta tabla.

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  zitadel_sub text not null unique,
  email text,
  nombre text,
  telefono text,
  rol text not null default 'profesor',
  foto_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_staff_email on public.staff (email);
