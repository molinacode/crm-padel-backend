-- Recuento exacto de filas por tabla del schema public.
-- Sirve para comparar el origen (Supabase) con el destino (VPS) tras el dump.
select
  table_name,
  (xpath('/row/cnt/text()', xml_count))[1]::text::int as filas
from (
  select
    table_name,
    query_to_xml(format('select count(*) as cnt from public.%I', table_name), false, true, '') as xml_count
  from information_schema.tables
  where table_schema = 'public'
    and table_type = 'BASE TABLE'
) t
order by table_name;
