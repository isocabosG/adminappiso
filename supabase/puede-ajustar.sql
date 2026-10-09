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
