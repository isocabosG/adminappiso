-- Permiso para aplicar ajustes por cierre de proyecto (OV + factura de Zoho).
-- 09-oct-2026.
--
-- POR QUE EN SU PROPIA COLUMNA Y NO COLGADO DE admin_accesos
-- admin_accesos es el permiso del menu de Usuarios. Quien administra cuentas no
-- es necesariamente quien puede mover el importe de una orden; son dos cosas
-- distintas y tienen que poder darse por separado.
--
-- QUIEN LO VALIDA
-- La Edge Function so-ajuste, contra el JWT de quien llama. La app esconde el
-- boton si no lo tienes, pero esconder un boton no es seguridad.
alter table public.profiles
  add column if not exists puede_ajustar boolean not null default false;

comment on column public.profiles.puede_ajustar is
  'Puede aplicar ajustes por cierre en la OV y su factura de Zoho. Lo valida la Edge Function so-ajuste contra el JWT de quien llama, nunca el navegador.';

update public.profiles p
set puede_ajustar = true
from auth.users u
where u.id = p.id
  and u.email in ('fvargas@innovacionsolar.com',   -- Fran
                  'cbueno@innovacionsolar.com',    -- Constanza Bueno
                  'admin@innovacionsolar.com');    -- Jesus Miranda

-- Verificacion: deben salir TRES en true. fvargascabo@gmail.com y
-- client.care@ se quedan fuera a proposito.
select u.email, p.role, p.admin_accesos, p.puede_ajustar
from public.profiles p
join auth.users u on u.id = p.id
order by p.puede_ajustar desc, u.email;

-- ---------------------------------------------------------------------------
-- Nombre de la persona. 09-oct-2026.
--
-- POR QUE
-- La bitacora de ajustes tiene que decir QUIEN. Con el correo solo, el registro
-- dice "admin@innovacionsolar.com aplico un ajuste de -18,400" y en seis meses
-- nadie sabe que ese es Jesus Miranda. Es el mismo rastro ciego que nos costo
-- no poder contestar quien metio el material con precio.
alter table public.profiles
  add column if not exists nombre text;

comment on column public.profiles.nombre is
  'Nombre de la persona. La bitacora de ajustes y el menu de Usuarios muestran esto, no el correo: admin@innovacionsolar.com no le dice a nadie que es Jesus Miranda.';

update public.profiles p
set nombre = v.nombre
from auth.users u,
     (values
       ('fvargas@innovacionsolar.com',      'Francisco J. Vargas Garibay'),
       ('fvargascabo@gmail.com',            'Francisco J. Vargas Garibay (cuenta 2)'),
       ('cbueno@innovacionsolar.com',       'Constanza Bueno'),
       ('admin@innovacionsolar.com',        'Jesus Miranda'),
       ('client.care@innovacionsolar.com',  'Sergio Hernandez')
     ) as v(correo, nombre)
where u.id = p.id and u.email = v.correo;

-- Verificacion final
select p.nombre, u.email, p.role, p.admin_accesos, p.es_super, p.puede_ajustar
from public.profiles p join auth.users u on u.id = p.id
order by p.puede_ajustar desc, p.nombre;

-- ---------------------------------------------------------------------------
-- CORRECCION. profiles YA tenia full_name, que es la que lee Root.jsx. La
-- columna 'nombre' de arriba sobra: se agrego sin revisar el esquema primero.
-- Los valores buenos ya se pasaron a full_name (hecho el 09-oct). Falta tirar
-- la columna: el camino de DDL del MCP se colgaba y quedo pendiente.
--
-- Correr esto en el editor SQL de Supabase:
alter table public.profiles drop column if exists nombre;

comment on column public.profiles.full_name is
  'Nombre de la persona. La bitacora de ajustes y el menu de Usuarios muestran esto, no el correo: admin@innovacionsolar.com no le dice a nadie que es Jesus Miranda.';
