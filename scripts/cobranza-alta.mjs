// Da de alta (o cambia la contraseña de) un usuario de la pantalla de cobranza.
//   node scripts/cobranza-alta.mjs client.care@innovacionsolar.com "Nombre Apellido"
//
// Genera la contraseña él mismo y la imprime una sola vez. No la pide por
// teclado ni la recibe como argumento a propósito: así no queda en el historial
// del shell ni hay que escribirla en un chat. Lo que se guarda en la base es
// solo el hash — de ahí no se puede recuperar la contraseña.
import { webcrypto as crypto } from 'node:crypto'

const email = (process.argv[2] || '').trim().toLowerCase()
const nombre = process.argv[3] || email
if (!email) { console.error('Uso: node scripts/cobranza-alta.mjs <correo> "<nombre>"'); process.exit(1) }

const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
const ALFA = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // sin l/I/0/O
const clave = [...crypto.getRandomValues(new Uint32Array(16))].map((n) => ALFA[n % ALFA.length]).join('')
const salt = hex(crypto.getRandomValues(new Uint8Array(16)))

const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(clave), 'PBKDF2', false, ['deriveBits'])
const hash = hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt.match(/.{2}/g).map((h) => parseInt(h, 16))), iterations: 120000 }, base, 256))

const usuario = { email, nombre, salt, hash }

console.log(`
  ───────────────────────────────────────────────────────────────
  CONTRASEÑA DE ${email}

      ${clave}

  Mándasela por un canal seguro. No vuelve a aparecer: si se
  pierde, se corre este script otra vez y se genera una nueva.
  ───────────────────────────────────────────────────────────────

  Y corre esto en el SQL editor de Supabase para darla de alta.
  Si ya existe un usuario con ese correo, lo reemplaza:

insert into adm_kv (key, value, updated_at)
values ('iso3-cobranza-acceso', '${JSON.stringify({ usuarios: [usuario] })}', now())
on conflict (key) do update set
  value = (
    select jsonb_build_object('usuarios',
      coalesce(jsonb_agg(u) filter (where u->>'email' <> ${JSON.stringify(email)}), '[]'::jsonb)
      || ${JSON.stringify(JSON.stringify([usuario]))}::jsonb
    )::text
    from jsonb_array_elements((adm_kv.value::jsonb)->'usuarios') u
  ),
  updated_at = now();
`)
