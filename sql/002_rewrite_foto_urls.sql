-- Tras copiar las fotos al volumen Docker.
-- Reescribe URLs del bucket de Supabase a app.v3sports.es.

update alumnos
set foto_url = regexp_replace(
  foto_url,
  '^https://[^/]+/storage/v1/object/public/fotos-alumnos/',
  'https://app.v3sports.es/fotos-alumnos/'
)
where foto_url like '%fotos-alumnos%';
