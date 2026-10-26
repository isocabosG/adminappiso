-- Crons del flujo de efectivo — AdminAppISO
--
-- Dos piezas que el flujo necesita refrescadas solas:
--   5:05 am  gastos-zoho          egresos del año  → iso3-gastos-zoho
--   6:05 am  contratado-anio      concepto 1 por OV → iso3-contratado-<año>
--
-- Los Cabos es UTC-7 todo el año (no hay horario de verano), así que la hora
-- UTC del cron es la local + 7.
--
-- POR QUÉ ESTAS HORAS
-- El límite de llamadas de Zoho es por organización y lo comparten esta app,
-- IS-PMT y los demás crons. El calendario de madrugada ya está apretado:
-- 5:00 catálogo · 5:10 OC · 5:15 comprometido · 5:30 IS-PMT · 5:40-5:58
-- inventario. Los gastos son pocas llamadas y caben en el hueco de las 5:05.
-- El contratado lee todas las órdenes del año, así que va DESPUÉS de que todo
-- lo demás terminó, a las 6:05.
--
-- AQUÍ NO SE ESCRIBE NINGUNA LLAVE
-- Los dos jobs toman los headers del job `oc-zoho` que ya existe, igual que
-- hace `proyectos-zoho`. Así la anon key vive en un solo lugar: si algún día se
-- rota, se corrige ese job y estos dos la heredan. Y la service_role nunca
-- queda escrita en la definición de un cron.

-- ── Egresos del año ─────────────────────────────────────────────────────────
-- Sin cuerpo: la función toma el año en curso por default.
select cron.unschedule('gastos-zoho') where exists (select 1 from cron.job where jobname = 'gastos-zoho');

select cron.schedule(
  'gastos-zoho',
  '5 12 * * *',             -- 12:05 UTC = 5:05 am en Los Cabos
  replace((select command from cron.job where jobname = 'oc-zoho'), '/oc-sync', '/gastos-sync')
);

-- ── Contratado por orden de venta (concepto 1, sin IVA) ─────────────────────
-- Esta función SÍ exige `anio` de 4 dígitos en el cuerpo, y es reanudable:
-- procesa un tramo, guarda los pendientes y se sale. Por eso se dispara cuatro
-- veces seguidas; cuando ya no quedan pendientes las corridas sobrantes
-- terminan al instante sin pedirle nada a Zoho.
--
-- El año se calcula en cada disparo, no se escribe: así el 1 de enero empieza
-- a construir el blob del año nuevo sin que nadie toque el cron.
select cron.unschedule('contratado-anio') where exists (select 1 from cron.job where jobname = 'contratado-anio');

select cron.schedule(
  'contratado-anio',
  '5,9,13,17 13 * * *',     -- 6:05 a 6:17 am en Los Cabos
  $$
    select net.http_post(
      url     := 'https://gkoibrjhlqmuiuedrtaz.supabase.co/functions/v1/contratado-anio',
      headers := (select substring(command from 'headers := ''(.*?)''')
                    from cron.job where jobname = 'oc-zoho')::jsonb,
      body    := jsonb_build_object('anio', to_char(now() at time zone 'America/Mazatlan', 'YYYY')),
      timeout_milliseconds := 180000
    );
  $$
);

-- ── Comprobaciones ──────────────────────────────────────────────────────────
--   select jobname, schedule, active from cron.job order by jobname;
--
--   select key, updated_at, length(value) from adm_kv
--    where key in ('iso3-gastos-zoho','iso3-contratado-2026');
--
--   select id, status_code, timed_out, error_msg, left(content::text,300), created
--     from net._http_response order by created desc limit 10;
--
-- Para dispararlos a mano sin esperar a mañana, corre el net.http_post solo.
-- El de contratado hay que repetirlo hasta que conteste "terminado": true.
