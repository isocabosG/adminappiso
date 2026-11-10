-- Cotejo del libro de bancos contra Zoho — AdminAppISO
--
-- Fran, 10-nov-2026: «si hay diferencias significa que no han trabajado en la
-- app y están subiendo movimientos a Zoho y no a la app; que salga un cuadro
-- que diga: SE SUBIERON MOVIMIENTOS A ZOHO Y NO EN LA APP».
--
-- `libro-cotejo` NO importa nada: compara y escribe `iso3-libro-cotejo`, que
-- es lo que la pantalla lee para pintar el aviso. Por eso el cron puede correr
-- tranquilo: no hay nada que pueda ensuciar.
--
-- DOS CORRIDAS AL DÍA, Y ES A PROPÓSITO. Un aviso que se calcula de madrugada
-- y nadie vuelve a tocar llega viejo a las cuatro de la tarde: si capturaron
-- en Zoho a mediodía, el cuadro no aparece hasta mañana y para entonces el
-- atraso ya es de dos días. La de la tarde es la que hace que el aviso sirva
-- el mismo día.
--
-- Los Cabos es UTC-7 todo el año (no hay horario de verano), así que la hora
-- UTC del cron es la local + 7.
--
-- POR QUÉ ESTAS HORAS. El límite de llamadas de Zoho es por organización y lo
-- comparten esta app, IS-PMT y los demás crons. La madrugada está apretada:
-- 5:00 catálogo · 5:05 gastos · 5:10 OC · 5:15 comprometido · 5:30 IS-PMT ·
-- 5:40-5:58 inventario · 6:05 contratado. El cotejo lee las ~28 cuentas y sus
-- movimientos del mes (unas 40-60 llamadas), así que va DESPUÉS de todo, a las
-- 6:20. La segunda corrida, a las 3:20 pm, cae en hueco limpio.
--
-- AQUÍ NO SE ESCRIBE NINGUNA LLAVE. Los dos jobs toman los headers del job
-- `oc-zoho` que ya existe. Así la llave vive en un solo lugar: si algún día se
-- rota, se corrige ese job y estos la heredan.

select cron.unschedule('libro-cotejo-am') where exists (select 1 from cron.job where jobname = 'libro-cotejo-am');
select cron.unschedule('libro-cotejo-pm') where exists (select 1 from cron.job where jobname = 'libro-cotejo-pm');

-- Sin cuerpo: la función toma el mes en curso (hora de Los Cabos) por default.
select cron.schedule(
  'libro-cotejo-am',
  '20 13 * * *',            -- 13:20 UTC = 6:20 am en Los Cabos
  replace((select command from cron.job where jobname = 'oc-zoho'), '/oc-sync', '/libro-cotejo')
);

select cron.schedule(
  'libro-cotejo-pm',
  '20 22 * * *',            -- 22:20 UTC = 3:20 pm en Los Cabos
  replace((select command from cron.job where jobname = 'oc-zoho'), '/oc-sync', '/libro-cotejo')
);

-- Para revisar que quedaron:
--   select jobname, schedule, active from cron.job where jobname like 'libro-cotejo%';
--   select jobname, status, return_message, start_time from cron.job_run_details
--    where jobname like 'libro-cotejo%' order by start_time desc limit 5;
