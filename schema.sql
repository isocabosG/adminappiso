-- AdminAppISO — esquema para el primer despliegue
-- Almacenamiento clave-valor compartido (los datos de la app viven aquí).
-- Correr en Supabase → SQL Editor → Run.

create table if not exists adm_kv (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);

alter table adm_kv enable row level security;

-- Solo usuarios autenticados pueden leer/escribir.
drop policy if exists "adm_kv authenticated all" on adm_kv;
create policy "adm_kv authenticated all" on adm_kv
  for all to authenticated
  using (true) with check (true);
