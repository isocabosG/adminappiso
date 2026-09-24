// Edge Function: catalogo-sync
//
// Trae el catálogo COMPLETO de Zoho Books (activos e inactivos) y lo deja en
// adm_kv bajo `iso3-catalogo-zoho`. Corre solo, por pg_cron, a las 5:00 am de
// Los Cabos — media hora ANTES que el /api/sync-catalog de IS-PMT (5:30), que
// es el acuerdo con ese equipo: nosotros primero, ellos después, para que
// nunca vayan adelante de nosotros sobre el mismo SKU.
//
// POR QUE UN BLOB APARTE Y NO `iso3-inventario-fisico`
// Ese otro blob lo escribe la pestaña Inventario desde el navegador, en dos
// pasadas (a mano, y luego comprometidas con ~2,200 llamadas). Si este cron lo
// sobrescribiera con solo la primera pasada, borraría las comprometidas cada
// madrugada. Aquí se escribe únicamente lo que este proceso sabe de verdad:
// qué SKU existen y cuáles están dados de baja.
//
// Secretos que usa (ya existen en el proyecto):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — los inyecta Supabase
// Reutiliza la función `zoho-books` para el OAuth: el refresh token y su cache
// viven ahí y no hay por qué duplicarlos.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-catalogo-zoho";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB || !SRV) {
    return new Response(JSON.stringify({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const zoho = async (params: Record<string, string>) => {
    const r = await fetch(`${SB}/functions/v1/zoho-books`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list_items", params }),
    });
    const j = await r.json();
    if (j?.error) throw new Error("zoho-books: " + j.error);
    return j;
  };

  try {
    const items: Record<string, unknown> = {};
    let page = 1, more = true, leidos = 0, inactivos = 0;

    // Status.All a propósito: un SKU dado de baja que sigue en un BOM viejo
    // manda a comprar algo que ya no existe. Si solo trajéramos los activos,
    // no habría forma de distinguir "no hay" de "ese código ya murió".
    while (more && page <= 40) {
      const d = await zoho({ per_page: "200", page: String(page), filter_by: "Status.All" });
      for (const it of (d.items || [])) {
        const sku = String(it.sku || "").trim().toUpperCase();
        if (!sku) continue;
        const activo = String(it.status || "").toLowerCase() === "active";
        if (!activo) inactivos++;
        items[sku] = {
          itemId: it.item_id,
          desc: it.name || sku,
          activo,
          rate: +it.purchase_rate || 0,
        };
        leidos++;
      }
      more = !!d.page_context?.has_more_page;
      page++;
    }

    if (!leidos) throw new Error("Zoho no devolvió artículos; no se sobrescribe el catálogo.");

    // Fecha local de Los Cabos, no UTC: a las 5:00 am UTC-7 ya es el día
    // siguiente en UTC, y el blob se marcaría con la fecha equivocada.
    const fecha = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);

    const up = await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: {
        apikey: SRV,
        Authorization: `Bearer ${SRV}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({ key: KEY, value: JSON.stringify({ fecha, items }), updated_at: new Date().toISOString() }),
    });
    if (!up.ok) throw new Error("No se pudo guardar el catálogo: " + (await up.text()).slice(0, 200));

    return new Response(JSON.stringify({ ok: true, fecha, skus: leidos, inactivos }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
