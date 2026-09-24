// Edge Function: mrp-write
//
// Proxy de ESCRITURA hacia IS-PMT (POST /api/mrp/material). Corrige el SKU, la
// cantidad requerida o libera un candado de una partida de `project_materials`.
//
// DOS RAZONES PARA QUE ESTO SEA UNA FUNCIÓN Y NO UNA LLAMADA DIRECTA
//
// 1. El token. `MRP_WRITE_TOKEN` escribe en los materiales de obras en
//    producción. Si viviera en el frontend —aunque fuera como variable de
//    Vite— quedaría horneado en el bundle que descarga el navegador, y
//    cualquiera con la URL de la app podría cambiar cantidades y SKU desde la
//    consola. Aquí nunca sale del servidor.
//
// 2. El `actor`. IS-PMT lo exige para la bitácora, y con un bearer de
//    servidor a servidor no puede saber quién fue: el token identifica a la
//    app, no a la persona. Así que el correo NO lo manda el navegador — se
//    saca aquí, del JWT de la sesión de Supabase de quien llamó. Si lo
//    mandara el cliente, cualquiera podría firmar una edición con el correo
//    de otro.
//
// Secretos de Supabase:
//   IS_PMT_URL       base del deploy de IS-PMT (ya existe, lo usa mrp-feed)
//   MRP_WRITE_TOKEN  token de ESCRITURA, distinto del MRP_FEED_TOKEN
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const base = (Deno.env.get("IS_PMT_URL") || "").replace(/\/+$/, "");
    const token = Deno.env.get("MRP_WRITE_TOKEN");
    if (!base) return json({ ok: false, error: "Falta el secreto IS_PMT_URL." }, 500);
    // Falla cerrado a propósito: sin token no se intenta escribir nada.
    if (!token) return json({ ok: false, error: "Falta el secreto MRP_WRITE_TOKEN. La edición está apagada." }, 500);

    // ── Quién está editando ───────────────────────────────────────────
    // Del JWT del llamante, no del body. Es la única parte que no se puede
    // falsificar desde el navegador.
    const auth = req.headers.get("Authorization") || "";
    const SB = Deno.env.get("SUPABASE_URL");
    const ANON = Deno.env.get("SUPABASE_ANON_KEY");
    if (!auth.startsWith("Bearer ") || !SB || !ANON) return json({ ok: false, error: "Sesión no válida." }, 401);

    const u = await fetch(`${SB}/auth/v1/user`, { headers: { Authorization: auth, apikey: ANON } });
    if (!u.ok) return json({ ok: false, error: "Sesión no válida o expirada. Vuelve a entrar." }, 401);
    const user = await u.json();
    const actor = String(user?.email || "").trim();
    if (!actor) return json({ ok: false, error: "La sesión no trae correo; no se puede firmar la edición." }, 401);

    // ── Lo que se va a cambiar ────────────────────────────────────────
    const b = await req.json().catch(() => ({}));
    const { projectId, materialId, sku, cant_disenada, descripcion, nota, liberar } = b || {};
    if (!projectId || !materialId) return json({ ok: false, error: "Faltan projectId y materialId." }, 400);

    const hayCambio = sku !== undefined || cant_disenada !== undefined ||
      descripcion !== undefined || (Array.isArray(liberar) && liberar.length > 0);
    if (!hayCambio) return json({ ok: false, error: "No mandaste ningún cambio." }, 400);

    const payload: Record<string, unknown> = { projectId, materialId, actor };
    // Solo viaja lo que de verdad cambia: IS-PMT distingue "no lo mandes" de
    // "mándalo vacío", y un undefined convertido en null borraría el campo.
    if (sku !== undefined) payload.sku = sku;
    if (cant_disenada !== undefined) payload.cant_disenada = cant_disenada;
    if (descripcion !== undefined) payload.descripcion = descripcion;
    if (nota !== undefined) payload.nota = nota;
    if (Array.isArray(liberar) && liberar.length) payload.liberar = liberar;

    const r = await fetch(`${base}/api/mrp/material`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: text.slice(0, 300) }; }

    // Se respeta el código de IS-PMT (422 SKU de baja, 409 obra terminada, …)
    // para que la pantalla pueda decir el motivo real y no un "falló" genérico.
    return json(data, r.status);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
