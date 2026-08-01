# AdminAppISO — Despliegue

App React (Vite) conectada a tu Supabase. Frontend validado del prototipo, ya cableado.

## Qué incluye
- Frontend completo (`src/App.jsx`) — todos los módulos.
- Conexión a Supabase (`src/supabaseClient.js`, `src/storageShim.js`).
- Login por correo/contraseña (`src/Login.jsx`, `src/Root.jsx`).
- `schema.sql` — la tabla que hay que crear en Supabase.
- `.env.example` — las variables (ya con tus valores).

## Paso 1 — Crear la tabla en Supabase
Supabase → tu proyecto → **SQL Editor** → pega `schema.sql` → **Run**.

## Paso 2 — Crear usuarios
Supabase → **Authentication → Users → Add user** → correo + contraseña para cada persona del equipo (tú, almacén, contabilidad…).

## Paso 3 — Probar local (opcional)
```
npm install
npm run dev
```
Abre el localhost que muestre, entra con un usuario que creaste.

## Paso 4 — Subir a GitHub
Copia estos archivos a tu repo (NO subas `node_modules` ni `.env`; ya están en `.gitignore`).
```
git add .
git commit -m "AdminAppISO frontend + Supabase"
git push
```

## Paso 5 — Desplegar en Vercel
1. vercel.com → **New Project** → importa tu repo.
2. Framework: **Vite** (lo detecta solo).
3. **Environment Variables** → agrega las dos:
   - `VITE_SUPABASE_URL` = `https://gkoibrjhlqmuiuedrtaz.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `sb_publishable_po802HDbmyo14oj43w5bpQ_9B2fb6N_`
4. **Deploy**. Te da la URL. Conecta tu dominio en Settings → Domains.

## Notas honestas (léelas)
- **Primer arranque:** la app siembra sus datos (catálogo, cuentas) en Supabase la primera vez. A partir de ahí, es compartido entre todos los usuarios.
- **La cámara SÍ funciona desplegada** (Vercel da HTTPS). En el sandbox del chat estaba bloqueada; aquí no.
- **Las funciones con IA** (leer PDF de pedimentos, leer etiquetas con foto) **todavía no funcionarán** en producción: dependen de una llave de Anthropic que va en un backend (Edge Function), aún no montado. El resto de la app (inventario, tesorería, costeo manual, flujo) funciona completo.
- **Concurrencia:** por ahora los datos se guardan como bloques (KV). Si dos personas editan a la vez, gana el último. Para operación intensa multiusuario, el siguiente paso es normalizar a las tablas `adm_` de la especificación.
- **Seguridad:** el login protege el acceso. La `anon/publishable key` es pública por diseño; lo que protege los datos es el RLS + el login. No subas la `service_role` key a ningún lado.
