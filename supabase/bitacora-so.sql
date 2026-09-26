-- Bitácora de la limpieza masiva de órdenes de venta.
--
-- Un cambio en una orden de venta de la contabilidad sin rastro de quién lo
-- hizo no es auditable. Aquí queda qué orden, qué renglón, quién y con qué
-- resultado — incluidos los intentos que fallaron, que son los que más se
-- necesitan después.
create table if not exists zoho_so_log (
  id          bigserial primary key,
  creado_at   timestamptz not null default now(),
  zoho_so_id  text,
  ov          text,
  quien       text,                       -- correo, sacado del JWT del lado servidor
  estado      text,                       -- aplicado | omitido | error
  altas       int  not null default 0,    -- siempre 0: esta herramienta NUNCA agrega partidas
  bajas       int  not null default 0,
  cambios     int  not null default 0,
  motivo      text,
  detalle     jsonb,
  error       text
);

create index if not exists zoho_so_log_ov_idx    on zoho_so_log (ov);
create index if not exists zoho_so_log_fecha_idx on zoho_so_log (creado_at desc);

-- RLS prendido y SIN políticas: nadie con la llave anon puede leerla ni
-- escribirla desde el navegador. Solo la Edge Function, que usa service_role y
-- se salta RLS por diseño. Una bitácora que el cliente puede editar no sirve
-- como bitácora.
alter table zoho_so_log enable row level security;

-- Para revisar una corrida:
--   select ov, estado, bajas, cambios, motivo, quien, creado_at
--     from zoho_so_log where motivo ilike '%NDR12024%' order by creado_at;
