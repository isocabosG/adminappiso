-- RLS en adm_kv — AdminAppISO
--
-- Hasta hoy, adm_kv se leia y escribia desde el navegador SIN RLS: cualquier
-- cuenta con sesion podia sacar todos los blobs desde la consola, costos
-- incluidos. Los roles decidian que pestanas se pintaban, no a que datos se
-- llegaba. Esto es la cerradura.
--
-- CORRER DESPUES de desplegar la app, no antes. La app tiene que traer ya el
-- candado de solo lectura; si no, un rol restringido puede guardar semillas
-- encima de los datos buenos.
--
-- ROLLBACK, una linea, si algo truena para Jesus o Constanza:
--     alter table public.adm_kv disable row level security;
-- Las politicas se quedan guardadas y se vuelven a prender con `enable`.

-- ── 1. Quien pregunta ──────────────────────────────────────────────────────
-- security definer porque profiles tiene su propio RLS: sin esto, la funcion
-- se veria a si misma bloqueada al consultar el renglon del que llama.
create or replace function public.mi_rol()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid()
$$;

revoke all on function public.mi_rol() from public;
grant execute on function public.mi_rol() to authenticated;

-- ── 2. Que llaves lee cada rol ─────────────────────────────────────────────
-- Cobranza solo necesita lo que alimenta Proyectos y las secciones 1 a 3.
-- Todo lo demas — el catalogo de costos, importaciones, tesoreria, inventario
-- y el MRP — queda fuera.
--
-- Un rol que no aparezca aqui lee todo, igual que hasta hoy: esta tabla quita,
-- nunca da.
create or replace function public.puede_leer_kv(k text)
returns boolean
language sql
stable
as $$
  select case public.mi_rol()
    when 'cobranza' then k in (
      'iso3-proyectos-cache',  -- lista de obras, montos, facturas
      'iso3-pagos-zoho',       -- pagos aplicados
      'iso3-proyectos',        -- cliente, documentos  (VER NOTA ABAJO)
      'iso3-tcfix'             -- tipo de cambio
    )
    else true
  end
$$;

revoke all on function public.puede_leer_kv(text) from public;
grant execute on function public.puede_leer_kv(text) to authenticated;

-- NOTA, y hay que decirla: `iso3-proyectos` trae en el MISMO blob los datos
-- del cliente y los costos (analisis con margen y utilidad, costos manuales,
-- dias y costo de mano de obra). RLS es por renglon, no por campo: o se da
-- entero o se niega entero. Darlo entero deja esos costos al alcance de quien
-- abra la consola. Negarlo rompe las secciones 1 a 3.
-- Esta version lo da. Cerrarlo de verdad pide separar el blob en dos llaves
-- (cliente/documentos por un lado, costos por otro) o servirlo por una Edge
-- Function que quite los campos de costo. Va en su propio paso.

-- ── 3. Las politicas ───────────────────────────────────────────────────────
alter table public.adm_kv enable row level security;

drop policy if exists "lectura por rol"   on public.adm_kv;
drop policy if exists "alta por rol"      on public.adm_kv;
drop policy if exists "cambio por rol"    on public.adm_kv;
drop policy if exists "borrado por rol"   on public.adm_kv;

create policy "lectura por rol" on public.adm_kv
  for select to authenticated
  using (public.puede_leer_kv(key));

-- Escribir: solo quien no es de solo lectura. Es el respaldo del candado que
-- ya trae la app — el del navegador se puede saltar, este no.
create policy "alta por rol" on public.adm_kv
  for insert to authenticated
  with check (public.mi_rol() is distinct from 'cobranza');

create policy "cambio por rol" on public.adm_kv
  for update to authenticated
  using (public.mi_rol() is distinct from 'cobranza')
  with check (public.mi_rol() is distinct from 'cobranza');

create policy "borrado por rol" on public.adm_kv
  for delete to authenticated
  using (public.mi_rol() is distinct from 'cobranza');

-- Nadie sin sesion toca esta tabla. Las Edge Functions usan la llave de
-- servicio, que se salta RLS por diseno, asi que los crones no se ven afectados.
revoke all on public.adm_kv from anon;

-- ── 4. VERIFICACION — mira los RENGLONES, no el "Success" ──────────────────
-- 4a. Deben salir las 4 politicas.
select polname, polcmd
  from pg_policy
 where polrelid = 'public.adm_kv'::regclass
 order by polname;
