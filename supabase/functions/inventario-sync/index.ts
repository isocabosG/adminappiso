// Edge Function: inventario-sync
//
// Deja en `iso3-inventario-fisico` las existencias FÍSICAS de Zoho: a mano,
// comprometidas y disponible para venta. Corre de madrugada, por pg_cron, en
// vez de que se calcule cuando alguien abre la pestaña Inventario.
//
// POR QUÉ ESTO IMPORTA
// Las comprometidas físicas (`actual_committed_stock`) NO vienen en la lista de
// artículos — solo pidiendo cada artículo por separado. Son ~2,300 llamadas a
// Zoho. Hasta hoy eso lo pagaba el navegador de quien abriera la pestaña: dos o
// tres minutos de espera, cada día, por persona. Ahora se paga una vez.
//
// POR QUÉ VA EN PEDAZOS
// Una Edge Function tiene un tope de tiempo por invocación, y 2,300 llamadas no
// caben. Así que esta procesa un tramo, guarda el avance en un blob temporal y
// se sale. La siguiente invocación mira dónde se quedó y sigue. El cron la
// dispara varias veces seguidas; cuando ya no hay nada pendiente, no hace nada.
//
// POR QUÉ NO PISA EL BLOB BUENO HASTA EL FINAL
// El blob de trabajo es `iso3-inventario-parcial`. El bueno solo se escribe
// cuando el recorrido termina completo. Si una corrida se corta a la mitad, el
// inventario que ve la app sigue siendo el de ayer — viejo pero íntegro, en vez
// de nuevo y a medias.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY_FINAL = "iso3-inventario-fisico";
const KEY_PARCIAL = "iso3-inventario-parcial";

const POR_TRAMO = 500;   // artículos por invocación
const EN_PARALELO = 6;   // llamadas simultáneas a Zoho

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);

  // zoho-books espera { action, params } — todo lo específico de cada endpoint
  // (item_id incluido) viaja dentro de `params`.
  const zoho = async (action: string, params: Record<string, string>) => {
    const r = await fetch(`${SB}/functions/v1/zoho-books`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" },
      body: JSON.stringify({ action, params }),
    });
    const j = await r.json();
    if (j?.error) throw new Error(`zoho-books ${action}: ${j.error}`);
    return j;
  };

  const leerBlob = async (key: string) => {
    const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${key}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows?.[0]?.value) return null;
    try { return JSON.parse(rows[0].value); } catch { return null; }
  };

  const guardarBlob = async (key: string, valor: unknown) => {
    const r = await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error(`No se pudo guardar ${key}: ${(await r.text()).slice(0, 200)}`);
  };

  // Fecha local de Los Cabos (UTC-7): a las 5 am allá, en UTC ya es el día siguiente.
  const hoyLocal = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);

  try {
    let parcial = await leerBlob(KEY_PARCIAL);

    // ── Arranque: la lista de artículos, que sí viene paginada y barata ──────
    if (!parcial || parcial.fecha !== hoyLocal()) {
      const pendientes: Array<{ sku: string; itemId: string; desc: string; activo: boolean; aMano: number; cost: number }> = [];
      let page = 1, more = true;
      while (more && page <= 40) {
        // Status.All a propósito: un SKU de baja que sigue en un BOM viejo
        // manda a comprar algo que ya no existe, y hay que poder distinguir
        // "no hay" de "ese código ya murió".
        const d = await zoho("list_items", { per_page: "200", page: String(page), filter_by: "Status.All" });
        for (const it of (d.items || [])) {
          const sku = String(it.sku || "").trim().toUpperCase();
          if (!sku) continue;
          pendientes.push({
            sku, itemId: String(it.item_id),
            desc: it.name || sku,
            activo: String(it.status || "").toLowerCase() === "active",
            // A mano físico. Viene en la lista, no cuesta llamada extra.
            aMano: Math.max(0, +it.actual_available_stock || 0),
            cost: +it.purchase_rate || 0,
          });
        }
        more = !!d.page_context?.has_more_page;
        page++;
      }
      if (!pendientes.length) throw new Error("Zoho no devolvió artículos; no se toca el inventario.");
      parcial = { fecha: hoyLocal(), i: 0, total: pendientes.length, lista: pendientes, items: {} };
      await guardarBlob(KEY_PARCIAL, parcial);
    }

    // ── El tramo de esta invocación ─────────────────────────────────────────
    const lista = parcial.lista as Array<{ sku: string; itemId: string; desc: string; activo: boolean; aMano: number; cost: number }>;
    let i = parcial.i as number;
    const hasta = Math.min(i + POR_TRAMO, lista.length);

    while (i < hasta) {
      const grupo = lista.slice(i, Math.min(i + EN_PARALELO, hasta));
      await Promise.all(grupo.map(async (x) => {
        // Un artículo dado de baja no tiene comprometidas que valga la pena
        // pedir: se registra con lo que ya trae la lista y se ahorra la llamada.
        if (!x.activo) {
          parcial.items[x.sku] = { itemId: x.itemId, desc: x.desc, activo: false, aMano: x.aMano, comprometido: 0, disponible: x.aMano, cost: x.cost };
          return;
        }
        try {
          const d = await zoho("get_item", { item_id: x.itemId });
          const it = d.item || {};
          const comp = Math.max(0, +it.actual_committed_stock || 0);
          // El disponible NO se aplasta a cero: un negativo significa que hay
          // más comprometido que existencia, y esa es justo la señal que
          // interesa. Taparla convierte un problema en un cero tranquilo.
          const disp = it.actual_available_for_sale_stock != null
            ? +it.actual_available_for_sale_stock
            : (x.aMano - comp);
          parcial.items[x.sku] = { itemId: x.itemId, desc: x.desc, activo: true, aMano: x.aMano, comprometido: comp, disponible: disp, cost: x.cost };
        } catch {
          // Si un artículo falla, se guarda lo que sí se sabe y se sigue. Una
          // llamada mala no puede costar el recorrido entero.
          parcial.items[x.sku] = { itemId: x.itemId, desc: x.desc, activo: x.activo, aMano: x.aMano, comprometido: null, disponible: null, cost: x.cost };
        }
      }));
      i += grupo.length;
    }

    parcial.i = i;

    // ── ¿Terminamos? ────────────────────────────────────────────────────────
    if (i >= lista.length) {
      const listos = Object.keys(parcial.items).length;
      if (!listos) throw new Error("Recorrido vacío; no se toca el inventario bueno.");
      await guardarBlob(KEY_FINAL, { fecha: parcial.fecha, items: parcial.items });
      // El parcial se vacía marcándolo de otra fecha: la próxima corrida
      // arranca de cero sin necesitar permiso de borrado.
      await guardarBlob(KEY_PARCIAL, { fecha: "", i: 0, total: 0, lista: [], items: {} });
      return json({ ok: true, terminado: true, fecha: parcial.fecha, skus: listos });
    }

    await guardarBlob(KEY_PARCIAL, parcial);
    return json({ ok: true, terminado: false, avance: `${i} de ${lista.length}` });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
