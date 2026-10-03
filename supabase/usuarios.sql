-- Menú de usuarios — AdminAppISO
-- Traducción de la instrucción del 3-oct-2026 (escrita desde IS-PMT).
--
-- AdminAppISO no tenía tabla de perfiles ni roles: hasta hoy, cualquier cuenta
-- con sesión podía todo. Esto crea el modelo. Se corre UNA vez, en el SQL
-- editor del proyecto gkoibrjhlqmuiuedrtaz.
--
-- Léelo antes de pegarlo. Al final hay un bloque de VERIFICACIÓN: un "Success"
-- también sale cuando el `where` no encontró a nadie.

-- ── 1. La tabla ────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  role       text not null default 'operacion',
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists admin_accesos boolean not null default false,
  add column if not exists protegido     boolean not null default false,
  add column if not exists es_super      boolean not null default false,
  add column if not exists activo        boolean not null default true;

comment on column public.profiles.admin_accesos is 'Ve y usa la pantalla de Usuarios. Solo Constanza y Francisco.';
comment on column public.profiles.protegido     is 'Esta cuenta solo la toca el super admin.';
comment on column public.profiles.es_super      is 'Quien puede tocar las protegidas. Solo Francisco.';
comment on column public.profiles.activo        is 'En false la cuenta esta dada de baja.';

-- ── 2. Un perfil para cada cuenta que YA existe ────────────────────────────
-- Sin esto, el rechazo al inactivo dejaria fuera a todos: quien no tiene
-- perfil no tiene `activo = true`.
insert into public.profiles (id, full_name, role)
select u.id, coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)), 'operacion'
  from auth.users u
 where not exists (select 1 from public.profiles p where p.id = u.id);

-- ── 3. Quien administra accesos ────────────────────────────────────────────
update public.profiles p
   set admin_accesos = true, protegido = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) in ('cbueno@innovacionsolar.com', 'fvargas@innovacionsolar.com');

update public.profiles p
   set es_super = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) = 'fvargas@innovacionsolar.com';

-- ── 4. RLS de la tabla de perfiles ─────────────────────────────────────────
-- Cada quien lee SOLO su propio perfil: la app lo necesita para saber si
-- muestra la pantalla de Usuarios y para comprobar que sigue activo.
-- Escribir no lo puede hacer nadie desde el navegador — solo la Edge Function
-- con la llave de servicio. Por eso no hay politica de insert/update/delete:
-- su ausencia ES la regla.
alter table public.profiles enable row level security;

drop policy if exists "cada quien lee su perfil" on public.profiles;
create policy "cada quien lee su perfil" on public.profiles
  for select using (auth.uid() = id);

-- ── 5. VERIFICACIÓN — mira los RENGLONES, no el "Success" ──────────────────
-- Salen TODAS las cuentas (una por cada auth.users), ordenadas para que las
-- que administran accesos queden arriba. Que salgan 8 o 15 renglones no es
-- un error: es cuanta gente tiene cuenta.
--
-- Lo que hay que comprobar son los DOS PRIMEROS renglones:
--   Constanza  -> admin_accesos t, protegido t, es_super f
--   Francisco  -> admin_accesos t, protegido t, es_super t
-- y que a partir del tercero NADIE traiga admin_accesos en true.
-- Si Constanza o Francisco no aparecen arriba, su correo en auth.users no es
-- el que el paso 3 busca: corrigelo ahi y vuelve a correr el paso 3.
select u.email, p.full_name, p.role, p.admin_accesos, p.protegido, p.es_super, p.activo
  from public.profiles p
  join auth.users u on u.id = p.id
 order by p.admin_accesos desc, p.es_super desc, u.email;
