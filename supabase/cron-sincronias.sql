-- Sincronías de madrugada — AdminAppISO
--
-- Hasta hoy la app solo trabajaba cuando alguien la miraba: el primero que
-- abría el MRP cada mañana pagaba 250 llamadas a Zoho, y el que abría
-- Inventario pagaba ~2,300 y dos o tres minutos de espera. Cada persona, cada
-- día. Esto lo mueve a la madrugada y lo paga una vez para todos.
--
-- HORARIOS (Los Cabos es UTC-7 todo el año, sin horario de verano)
--   5:00 am  catalogo-zoho-5am   catálogo de artículos      (ya existía)
--   5:10 am  oc-zoho             órdenes de compra
--   5:20 am  inventario-zoho     existencias físicas, en tramos hasta las 5:40
--
-- El de IS-PMT corre a las 5:30 por acuerdo con ese equipo: nosotros primero.
--
-- ANTES DE CORRER: sustituye el marcador de la llave -- las dos veces que
-- aparece mas abajo, dentro de los headers -- por la anon key del proyecto
-- (Settings → API → anon / public). NO hace falta la service_role: estas
-- funciones usan su propia llave inyectada por Supabase, y al gateway le basta
-- cualquier JWT válido. Poner service_role aquí la dejaría escrita en la
-- definición del job sin comprar nada.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── Órdenes de compra: tránsito, ETA y proveedor por SKU ────────────────────
select cron.unschedule('oc-zoho') where exists (select 1 from cron.job where jobname = 'oc-zoho');

select cron.schedule(
  'oc-zoho',
  '10 12 * * *',            -- 12:10 UTC = 5:10 am en Los Cabos
  $$
    select net.http_post(
      url     := 'https://gkoibrjhlqmuiuedrtaz.supabase.co/functions/v1/oc-sync',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer <ANON_KEY>"}'::jsonb,
      body    := '{}'::jsonb,
      timeout_milliseconds := 180000
    );
  $$
);

-- ── Inventario físico: va en tramos ─────────────────────────────────────────
-- Son ~2,300 llamadas a Zoho y no caben en una sola invocación: hay un tope de
-- tiempo por ejecución. La función procesa un tramo, guarda el avance y se
-- sale; la siguiente invocación mira dónde se quedó y sigue. Por eso se dispara
-- cada 4 minutos entre las 5:20 y las 5:40 — cuando ya no hay pendientes, las
-- corridas sobrantes no hacen nada y terminan al instante.
--
-- El blob que lee la app solo se escribe cuando el recorrido termina completo.
-- Si una corrida se corta, el inventario sigue siendo el de ayer: viejo pero
-- íntegro, en vez de nuevo y a medias.
select cron.unschedule('inventario-zoho') where exists (select 1 from cron.job where jobname = 'inventario-zoho');

select cron.schedule(
  'inventario-zoho',
  '20,24,28,32,36,40 12 * * *',   -- 5:20 a 5:40 am de Los Cabos
  $$
    select net.http_post(
      url     := 'https://gkoibrjhlqmuiuedrtaz.supabase.co/functions/v1/inventario-sync',
      headers := '{"Content-Type":"application/json","Authorization":"Bearer <ANON_KEY>"}'::jsonb,
      body    := '{}'::jsonb,
      timeout_milliseconds := 180000
    );
  $$
);

-- ── Comprobaciones ──────────────────────────────────────────────────────────
--   select jobname, schedule, active from cron.job order by jobname;
--   select id, status_code, timed_out, error_msg, left(content::text,200), created
--     from net._http_response order by created desc limit 10;
--   select key, updated_at, length(value) from adm_kv
--    where key in ('iso3-catalogo-zoho','iso3-mrp-oc-cache-v2','iso3-inventario-fisico');
--
-- Para dispararlos a mano sin esperar a mañana, corre el net.http_post solo.
-- El de inventario hay que repetirlo hasta que conteste "terminado": true.
