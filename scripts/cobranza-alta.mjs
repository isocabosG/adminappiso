// OBSOLETO (3-oct-2026). El alta de cobranza ya no necesita este script.
//
// Generaba una contrasena, la hasheaba con PBKDF2 e imprimia el SQL para
// pegarlo. Era mas fuerte en el papel y en la practica no entro nadie: tres
// intentos fallidos. Demasiadas piezas que mover a mano.
//
// Ahora el alta es UN SOLO SQL en Supabase. Esta todo documentado en
// supabase/functions/estado-de-cuenta/index.ts, arriba del todo.
console.error(`
  Este script ya no se usa.

  El alta de un usuario de cobranza ahora es un solo SQL:

    insert into adm_kv (key, value, updated_at)
    values ('iso3-cobranza-acceso',
      jsonb_build_object('usuarios', jsonb_build_array(jsonb_build_object(
        'email',  'client.care@innovacionsolar.com',
        'nombre', 'Atencion a Clientes',
        'hash',   encode(sha256('LA-CLAVE-AQUI'::bytea),'hex')
      )))::text, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();

  La clave debe ser larga y aleatoria, minimo 20 caracteres:
    openssl rand -base64 18
`)
process.exit(1)
