// Edge Function: oc-sync
//
// Deja en `iso3-mrp-oc-cache-v2` lo que el MRP necesita saber de las órdenes de
// compra: qué material viene en camino, con qué fecha de llegada, y a quién se
// le compra cada SKU. Corre de madrugada, por pg_cron.
//
// LO QUE REEMPLAZA
// Hoy esto lo hace el navegador del primero que abra el MRP cada mañana: lee
// 250 órdenes de compra, una llamada por cada una, y se queda esperando. Cada
// persona paga esa espera y esa cuota de la API de Zoho. Aquí se paga una vez,
// de noche, para todos.
//
// POR QUÉ EL PROVEEDOR SE CUENTA Y NO SE TOMA EL ÚLTIMO
// El campo de proveedor del artículo está vacío en Zoho, así que a quién se le
// compra un SKU hay que deducirlo. Tomar el de la OC más reciente es frágil:
// esa pudo ser una urgencia con quien contestara el teléfono. Gana el que más
// veces aparece, y en empate el más reciente.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-mrp-oc-cache-v2";
const MAX_OC = 250;
const EN_PARALELO = 3;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const up = (s: unknown) => String(s ?? "").trim().toUpperCase();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);

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

  const hoyLocal = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);

  try {
    // ── 1. Encabezados de las OC ────────────────────────────────────────────
    const pos: Array<{ id: string; vendor: string; abierta: boolean; eta: string | null; numero: string; fecha: string }> = [];
    let page = 1, more = true;
    while (more && page <= 25 && pos.length < MAX_OC) {
      const d = await zoho("list_purchase_orders", {
        filter_by: "Status.All", per_page: "100", page: String(page), sort_column: "date", sort_order: "D",
      });
      for (const po of (d.purchaseorders || [])) {
        const st = String(po.status || "").toLowerCase();
        if (st === "cancelled" || st === "draft") continue;
        const abierta = (+po.quantity_yet_to_receive || 0) > 0 || (po.received_status && po.received_status !== "received");
        // ETA a almacén: el custom field que compras sí llena. Sin fecha, el
        // material en camino no se puede asignar a una obra — llegar tarde es
        // lo mismo que no llegar.
        const eta = po.cf_fecha_estimada_a_almac_n_is_unformatted || po.delivery_date || null;
        pos.push({
          id: String(po.purchaseorder_id), vendor: po.vendor_name || "", abierta: !!abierta,
          eta: eta ? String(eta).slice(0, 10) : null,
          numero: po.purchaseorder_number || "", fecha: String(po.date || "").slice(0, 10),
        });
      }
      more = !!d.page_context?.has_more_page;
      page++;
    }
    if (!pos.length) throw new Error("Zoho no devolvió órdenes de compra; no se toca el caché.");

    // ── 2. Las partidas de cada OC ──────────────────────────────────────────
    const lote = pos.slice(0, MAX_OC);
    const trans: Record<string, number> = {};
    const lotes: Record<string, Array<{ qty: number; eta: string | null; oc: string }>> = {};
    const hist: Record<string, { desc: string; porProv: Record<string, { n: number; ult: string; pzas: number }> }> = {};
    let fallidas = 0;

    const motivos: Record<string, number> = {};

    for (let i = 0; i < lote.length; i += EN_PARALELO) {
      const grupo = lote.slice(i, i + EN_PARALELO);
      await Promise.all(grupo.map(async (po) => {
        try {
          let d: any;
          try {
            d = await zoho("get_purchase_order", { purchaseorder_id: po.id });
          } catch (e1) {
            // Un rechazo suele ser el limite de llamadas por minuto de Zoho, no
            // una OC rota. Se espera y se vuelve a intentar una vez.
            await new Promise((r) => setTimeout(r, 2000));
            d = await zoho("get_purchase_order", { purchaseorder_id: po.id });
          }
          for (const li of (d.purchaseorder?.line_items || [])) {
            const sku = up(li.sku);
            if (!sku) continue;
            if (po.vendor) {
              const h = (hist[sku] = hist[sku] || { desc: li.name || li.description || "", porProv: {} });
              if (!h.desc && (li.name || li.description)) h.desc = li.name || li.description;
              const pv = (h.porProv[po.vendor] = h.porProv[po.vendor] || { n: 0, ult: "", pzas: 0 });
              pv.n++; pv.pzas += (+li.quantity || 0);
              if (po.fecha > pv.ult) pv.ult = po.fecha;
            }
            if (po.abierta) {
              const q = (li.quantity_yet_to_receive != null) ? +li.quantity_yet_to_receive : (+li.quantity || 0);
              if (q > 0) {
                trans[sku] = (trans[sku] || 0) + q;
                (lotes[sku] = lotes[sku] || []).push({ qty: q, eta: po.eta, oc: po.numero });
              }
            }
          }
        } catch (e) {
          // Una OC mala no cuesta el recorrido entero, pero si deja dicho de que
          // murio: un contador a secas no se puede diagnosticar.
          fallidas++;
          const m = String((e as Error)?.message || e).slice(0, 160);
          motivos[m] = (motivos[m] || 0) + 1;
        }
      }));
    }

    // ── 3. Proveedor por SKU: el más frecuente ──────────────────────────────
    const prov: Record<string, string> = {};
    for (const [sku, h] of Object.entries(hist)) {
      const mejor = Object.entries(h.porProv)
        .sort((a, b) => b[1].n - a[1].n || String(b[1].ult).localeCompare(String(a[1].ult)))[0];
      if (mejor) prov[sku] = mejor[0];
    }

    // ── 4. Proveedores como están escritos en Zoho ──────────────────────────
    // Para que la semilla proponga nombres que existen: Zoho liga el proveedor
    // del artículo por id, y un nombre aproximado no casa con nada.
    const provZoho: Array<{ nombre: string; tipo: string; moneda: string }> = [];
    let provError: string | null = null;
    try {
      let pc = 1, moreC = true;
      while (moreC && pc <= 10) {
        const dc = await zoho("list_contacts", { contact_type: "vendor", filter_by: "Status.Active", per_page: "200", page: String(pc) });
        for (const c of (dc.contacts || [])) {
          if (String(c.contact_type || "") !== "vendor") continue;
          provZoho.push({ nombre: c.contact_name || c.vendor_name || "", tipo: c.cf_tipo_cliente_proveedor || "", moneda: c.currency_code || "" });
        }
        moreC = !!dc.page_context?.has_more_page;
        pc++;
      }
    } catch (e) { provError = String((e as Error)?.message || e).slice(0, 200); }

    // Si TODAS las OC fallaron no hay nada que guardar: mejor dejar el caché de
    // ayer, viejo pero íntegro, que uno nuevo y vacío.
    if (fallidas === lote.length) throw new Error(`Las ${lote.length} órdenes de compra fallaron; no se toca el caché.`);

    const valor = { fecha: hoyLocal(), transito: trans, proveedor: prov, lotes, hist, provZoho };
    const r = await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: KEY, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error("No se pudo guardar el caché: " + (await r.text()).slice(0, 200));

    return json({
      ok: true, fecha: valor.fecha, ocLeidas: lote.length, ocFallidas: fallidas,
      skuEnTransito: Object.keys(trans).length, skuConProveedor: Object.keys(prov).length,
      proveedoresZoho: provZoho.length,
      provError,
      motivos: Object.entries(motivos).sort((a, b) => b[1] - a[1]).slice(0, 5),
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
