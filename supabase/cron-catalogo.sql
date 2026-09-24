-- Refresco del catálogo de Zoho, 5:00 am de Los Cabos (UTC-7 todo el año).
-- Media hora ANTES del /api/sync-catalog de IS-PMT (5:30), por acuerdo con ese
-- equipo: nosotros primero, ellos después.
--
-- ANTES DE CORRER: reemplaza <SERVICE_ROLE_KEY> por la service_role key del
-- proyecto (Supabase → Settings → API). Se corre en el SQL Editor del
-- proyecto gkoibrjhlqmuiuedrtaz.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotente: si ya existe, se reemplaza.
select cron.unschedule('catalogo-zoho-5am')
where exists (select 1 from cron.job where jobname = 'catalogo-zoho-5am');

select cron.schedule(
  'catalogo-zoho-5am',
  '0 12 * * *',            -- 12:00 UTC = 5:00 am en America/Mazatlan
  $$
    select net.http_post(
      url     := 'https://gkoibrjhlqmuiuedrtaz.supabase.co/functions/v1/catalogo-sync',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
      body    := '{}'::jsonb
    );
  $$
);

-- Comprobaciones:
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 5;
--   select key, updated_at, length(value) from adm_kv where key = 'iso3-catalogo-zoho';
