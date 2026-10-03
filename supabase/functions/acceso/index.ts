// Edge Function: acceso
// ---------------------------------------------------------------------------
// La pantalla de Usuarios. AdminAppISO no tiene rutas de servidor (es una SPA
// de Vite), asi que el equivalente de `/api/acceso` de IS-PMT es esta funcion.
//
// LA REGLA: esconder el boton no es el permiso. Quien sepa llamar esta funcion
// puede intentar lo que el boton hace aunque no lo vea. Por eso TODA la logica
// vive aqui y se vuelve a revisar quien llama, en CADA llamada. La pantalla
// apaga controles por comodidad; esta funcion impide.
//
// El candado: las cuentas `protegido` solo las toca quien tiene `es_super`.
// No es desconfianza — quien puede cambiarle la contrasena a alguien puede
// entrar como esa persona, y eso no debe poder hacerse en silencio entre pares.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SB = Deno.env.get("SUPABASE_URL")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BAN_PERPETUO = "876000h";   // 100 anios

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// Helpers REST con la LLAVE DE SERVICIO. Se usa aqui a proposito: el estado de
// la cuenta objetivo no puede depender de los permisos de quien pregunta. Si
// dependiera, una politica mal puesta devolveria `protegido` en null y el
// candado se abriria solo.
const adminHeaders = { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" };

async function perfil(id: string) {
  const r = await fetch(`${SB}/rest/v1/profiles?id=eq.${id}&select=id,full_name,role,admin_accesos,protegido,es_super,activo`, { headers: adminHeaders });
  if (!r.ok) return null;
  return (await r.json())?.[0] || null;
}

async function authAdmin(path: string, init: RequestInit) {
  const r = await fetch(`${SB}/auth/v1/admin${path}`, { ...init, headers: { ...adminHeaders, ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Auth ${r.status}: ${t.slice(0, 200)}`);
  try { return JSON.parse(t); } catch { return {}; }
}

// listUsers pagina de 50 en 50. Hay que recorrerlo completo: hoy caben en una
// pagina, pero el dia que pasen de cincuenta se perderia media lista sin un
// solo error — que es justo como nos ha mordido el tope de PostgREST.
async function correosPorId() {
  const out: Record<string, { email: string; baneado: boolean }> = {};
  for (let page = 1; page <= 20; page++) {
    const d = await authAdmin(`/users?page=${page}&per_page=50`, { method: "GET" });
    const us = d?.users || [];
    for (const u of us) out[u.id] = { email: u.email || "", baneado: !!u.banned_until && new Date(u.banned_until) > new Date() };
    if (us.length < 50) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    // ── Quien llama ────────────────────────────────────────────────────────
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const ru = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SRV, Authorization: `Bearer ${jwt}` } });
    if (!ru.ok) return json({ ok: false, error: "No autorizado." }, 401);
    const quien = await ru.json();
    const yo = await perfil(quien.id);
    if (!yo?.admin_accesos) return json({ ok: false, error: "No administras accesos." }, 403);
    if (!yo.activo) return json({ ok: false, error: "Tu cuenta esta dada de baja." }, 403);

    const body = await req.json().catch(() => ({}));
    const accion = String(body?.accion || "");
    const userId = String(body?.userId || "");

    // ── Listar ─────────────────────────────────────────────────────────────
    if (accion === "listar") {
      const r = await fetch(`${SB}/rest/v1/profiles?select=id,full_name,role,admin_accesos,protegido,es_super,activo&order=full_name`, { headers: adminHeaders });
      const perfiles = r.ok ? await r.json() : [];
      const correos = await correosPorId();
      return json({
        ok: true,
        yo: { id: yo.id, esSuper: !!yo.es_super },
        usuarios: perfiles.map((p: any) => ({ ...p, email: correos[p.id]?.email || "", baneadoEnAuth: !!correos[p.id]?.baneado })),
      });
    }

    // ── Crear ──────────────────────────────────────────────────────────────
    if (accion === "crear") {
      const email = String(body?.email || "").trim().toLowerCase();
      const clave = String(body?.clave || "");
      if (!email) return json({ ok: false, error: "Falta el correo." }, 400);
      if (clave.length < 8) return json({ ok: false, error: "La contrasena debe tener al menos 8 caracteres." }, 400);
      const creado = await authAdmin("/users", {
        method: "POST",
        body: JSON.stringify({ email, password: clave, email_confirm: true }),
      });
      const id = creado?.id || creado?.user?.id;
      if (!id) return json({ ok: false, error: "Auth no devolvio el id del usuario nuevo." }, 500);
      await fetch(`${SB}/rest/v1/profiles`, {
        method: "POST",
        headers: { ...adminHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id, full_name: String(body?.nombre || email.split("@")[0]), role: String(body?.rol || "operacion") }),
      });
      // La contrasena NO se devuelve, no se registra y no se guarda en ningun
      // lado. Entra, se aplica y se va. Se le da a la persona en directo.
      return json({ ok: true, creado: email });
    }

    // ── De aqui en adelante hace falta un objetivo ─────────────────────────
    if (!userId) return json({ ok: false, error: "Falta el usuario." }, 400);
    const objetivo = await perfil(userId);
    if (!objetivo) return json({ ok: false, error: "No existe ese acceso." }, 404);

    // EL CANDADO. Se revisa aqui, en el servidor, siempre.
    if (objetivo.protegido && !yo.es_super && userId !== yo.id) {
      return json({ ok: false, error: "Esa cuenta esta protegida. Solo la direccion puede tocarla." }, 403);
    }

    if (accion === "rol") {
      // Si el ultimo administrador se bajara por error, nadie podria volver a
      // administrar nada y habria que entrar a la base a mano.
      if (userId === yo.id) return json({ ok: false, error: "No puedes cambiarte el rol a ti mismo." }, 400);
      await fetch(`${SB}/rest/v1/profiles?id=eq.${userId}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ role: String(body?.rol || "operacion") }),
      });
      return json({ ok: true });
    }

    if (accion === "clave") {
      const clave = String(body?.clave || "");
      if (clave.length < 8) return json({ ok: false, error: "La contrasena debe tener al menos 8 caracteres." }, 400);
      await authAdmin(`/users/${userId}`, { method: "PUT", body: JSON.stringify({ password: clave }) });
      return json({ ok: true });
    }

    // ── Baja y alta ────────────────────────────────────────────────────────
    // Desactivar, nunca borrar: las bitacoras y los registros apuntan a esa
    // cuenta. Y son LAS DOS cosas juntas, porque cada una sola deja un hueco:
    // solo la bandera y la persona sigue entrando hasta que expire su sesion;
    // solo el bloqueo en Auth y la app la sigue tratando como activa.
    if (accion === "baja" || accion === "alta") {
      const activo = accion === "alta";
      if (userId === yo.id) return json({ ok: false, error: "No puedes darte de baja a ti mismo." }, 400);
      await fetch(`${SB}/rest/v1/profiles?id=eq.${userId}`, {
        method: "PATCH", headers: adminHeaders, body: JSON.stringify({ activo }),
      });
      await authAdmin(`/users/${userId}`, {
        method: "PUT", body: JSON.stringify({ ban_duration: activo ? "none" : BAN_PERPETUO }),
      });
      return json({ ok: true });
    }

    return json({ ok: false, error: "Accion no valida." }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
