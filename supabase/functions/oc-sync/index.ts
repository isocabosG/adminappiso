// Edge Function: oc-sync
//
// Deja en `iso3-mrp-oc-cache-v2` lo que el MRP necesita saber de las órdenes de
// compra: qué material viene en camino, con qué fecha de llegada, y a quién se
// le compra cada SKU. Corre de madrugada, por pg_cron.
//
// POR QUÉ ESTA VERSIÓN PIDE MENOS
// La primera versión leía las 250 OC más recientes completas, todos los días.
// Zoho lo rechazó: "Rate limit exceeded, retry after 44s". Ese límite es por
// organización y por minuto, y lo comparten esta app, IS-PMT y los crons. No se
// gana empujando más fuerte; se gana pidiendo menos. Así que ahora:
//
//   · Las OC ABIERTAS se leen completas cada día. Son las únicas que pueden
//     cambiar lo que viene en camino, y son pocas.
//   · El historial de proveedores se construye UNA VEZ y se acumula. Cada
//     corrida muerde un puñado de OC viejas que todavía no ha visto y las
//     recuerda. En unos días tiene las 250 y después ya no cuesta casi nada.
//   · La lista de proveedores de Zoho se refresca una vez por semana. No cambia
//     a diario y cada refresco son varias llamadas.
//
// Y cuando Zoho dice "espérate", se espera: lee el tiempo que pide y lo respeta.
//
// POR QUÉ EL TRÁNSITO ES TODO O NADA
// Si una OC abierta no se pudo leer, el tránsito queda incompleto — y un
// tránsito incompleto es peor que uno viejo: le dice al MRP que viene menos
// material del que viene, y compras pide de más. Así que si falla una sola
// abierta, se conserva el tránsito del día anterior y se dice en la respuesta.
//
// POR QUÉ EL PROVEEDOR SE CUENTA Y NO SE TOMA EL ÚLTIMO
// El campo de proveedor del artículo está vacío en Zoho, así que a quién se le
// compra un SKU hay que deducirlo. Tomar el de la OC más reciente es frágil:
// esa pudo ser una urgencia con quien contestara el teléfono. Gana el que más
// veces aparece, y en empate el más reciente.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-mrp-oc-cache-v2";
const MAX_OC = 250;          // ventana de historial: las 250 OC más recientes
const BACKFILL = 40;         // OC viejas nuevas que se muerden por corrida
const GAP_MS = 400;          // respiro entre llamadas
const ESPERA_MAX_MS = 30000; // lo más que aceptamos esperar cuando Zoho frena
const PROV_CADA_DIAS = 7;

type Hist = Record<string, { desc: string; porProv: Record<string, { n: number; ult: string; pzas: number }> }>;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const up = (s: unknown) => String(s ?? "").trim().toUpperCase();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);


  // Una llamada a Zoho que entiende el "espérate". Si Zoho contesta que nos
  // pasamos del límite, lee los milisegundos que pide y los respeta, hasta dos
  // veces. Más allá de eso no vale la pena seguir peleando en esta corrida.
  // Zoho directo, sin pasar por el Edge Function `zoho-books`: cientos de
  // llamadas función-a-función las frena Supabase, no Zoho. Ver _shared/zoho.ts.
  const z = new Zoho(SB, SRV, ORG);
  const zoho = async (action: string, params: Record<string, string> = {}): Promise<any> => {
    const { purchaseorder_id, item_id, ...resto } = params as any;
    if (action === "list_purchase_orders") return z.get("/purchaseorders", resto);
    if (action === "get_purchase_order") return z.get(`/purchaseorders/${purchaseorder_id}`, resto);
    if (action === "list_contacts") return z.get("/contacts", resto);
    if (action === "list_items") return z.get("/items", resto);
    if (action === "get_item") return z.get(`/items/${item_id}`, resto);
    throw new Error("Acción no soportada: " + action);
  };

  const leerBlob = async () => {
    const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${KEY}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows?.[0]?.value) return null;
    try { return JSON.parse(rows[0].value); } catch { return null; }
  };

  const hoyLocal = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
  const diasEntre = (a: string, b: string) =>
    Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

  try {
    const previo = (await leerBlob()) || {};
    const hist: Hist = previo.hist || {};
    const vistas = new Set<string>(previo.vistas || []);

    // ── 1. Encabezados de las OC (barato: 3 llamadas para 250) ──────────────
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

    const lote = pos.slice(0, MAX_OC);
    const abiertas = lote.filter((p) => p.abierta);
    // Las viejas que todavía no hemos mirado nunca, de la más reciente hacia atrás.
    const pendientes = lote.filter((p) => !p.abierta && !vistas.has(p.id)).slice(0, BACKFILL);

    const trans: Record<string, number> = {};
    const lotes: Record<string, Array<{ qty: number; eta: string | null; oc: string }>> = {};
    const motivos: Record<string, number> = {};

    const anotar = (po: typeof lote[number], lineas: any[], paraTransito: boolean) => {
      for (const li of lineas) {
        const sku = up(li.sku);
        if (!sku) continue;
        if (po.vendor) {
          const h = (hist[sku] = hist[sku] || { desc: li.name || li.description || "", porProv: {} });
          if (!h.desc && (li.name || li.description)) h.desc = li.name || li.description;
          const pv = (h.porProv[po.vendor] = h.porProv[po.vendor] || { n: 0, ult: "", pzas: 0 });
          pv.n++; pv.pzas += (+li.quantity || 0);
          if (po.fecha > pv.ult) pv.ult = po.fecha;
        }
        if (paraTransito) {
          const q = (li.quantity_yet_to_receive != null) ? +li.quantity_yet_to_receive : (+li.quantity || 0);
          if (q > 0) {
            trans[sku] = (trans[sku] || 0) + q;
            (lotes[sku] = lotes[sku] || []).push({ qty: q, eta: po.eta, oc: po.numero });
          }
        }
      }
    };

    // ── 2. Las OC abiertas, completas. Son las que mueven el tránsito ───────
    let transitoOK = true;
    for (const po of abiertas) {
      try {
        const d = await zoho("get_purchase_order", { purchaseorder_id: po.id });
        anotar(po, d.purchaseorder?.line_items || [], true);
        vistas.add(po.id);
      } catch (e) {
        transitoOK = false;
        const m = String((e as Error)?.message || e).slice(0, 160);
        motivos[m] = (motivos[m] || 0) + 1;
      }
      await dormir(GAP_MS);
    }

    // ── 3. Historial: se muerde de a poco, sin prisa ────────────────────────
    let backfilled = 0;
    for (const po of pendientes) {
      try {
        const d = await zoho("get_purchase_order", { purchaseorder_id: po.id });
        anotar(po, d.purchaseorder?.line_items || [], false);
        vistas.add(po.id);
        backfilled++;
      } catch (e) {
        // Si aquí falla, no pasa nada: mañana vuelve a intentar esta misma OC.
        const m = String((e as Error)?.message || e).slice(0, 160);
        motivos[m] = (motivos[m] || 0) + 1;
        break; // si Zoho ya está frenando, no insistir con el resto
      }
      await dormir(GAP_MS);
    }

    // ── 4. Proveedor por SKU: el más frecuente ──────────────────────────────
    const prov: Record<string, string> = {};
    for (const [sku, h] of Object.entries(hist)) {
      const mejor = Object.entries(h.porProv)
        .sort((a, b) => b[1].n - a[1].n || String(b[1].ult).localeCompare(String(a[1].ult)))[0];
      if (mejor) prov[sku] = mejor[0];
    }

    // ── 5. Proveedores de Zoho: una vez por semana ──────────────────────────
    // Para que la semilla proponga nombres que existen: Zoho liga el proveedor
    // del artículo por id, y un nombre aproximado no casa con nada.
    let provZoho = previo.provZoho || [];
    let provFecha = previo.provFecha || "";
    let provError: string | null = null;
    const tocaProv = !provZoho.length || !provFecha || diasEntre(provFecha, hoyLocal()) >= PROV_CADA_DIAS;
    if (tocaProv) {
      try {
        const acum: Array<{ nombre: string; tipo: string; moneda: string }> = [];
        let pc = 1, moreC = true;
        while (moreC && pc <= 10) {
          const dc = await zoho("list_contacts", { contact_type: "vendor", filter_by: "Status.Active", per_page: "200", page: String(pc) });
          for (const c of (dc.contacts || [])) {
            if (String(c.contact_type || "") !== "vendor") continue;
            acum.push({ nombre: c.contact_name || c.vendor_name || "", tipo: c.cf_tipo_cliente_proveedor || "", moneda: c.currency_code || "" });
          }
          moreC = !!dc.page_context?.has_more_page;
          pc++;
          await dormir(GAP_MS);
        }
        if (acum.length) { provZoho = acum; provFecha = hoyLocal(); }
      } catch (e) {
        // Sin proveedores el resto sigue sirviendo, y se conserva la lista vieja.
        provError = String((e as Error)?.message || e).slice(0, 200);
      }
    }

    // ── 6. Guardar ──────────────────────────────────────────────────────────
    // Sólo se escribe el tránsito de hoy si TODAS las abiertas se leyeron. Si no,
    // se conserva el de ayer: viejo pero íntegro, en vez de nuevo y a medias.
    const valor = {
      fecha: hoyLocal(),
      transito: transitoOK ? trans : (previo.transito || {}),
      lotes: transitoOK ? lotes : (previo.lotes || {}),
      transitoFecha: transitoOK ? hoyLocal() : (previo.transitoFecha || null),
      proveedor: prov,
      hist,
      vistas: Array.from(vistas).filter((id) => lote.some((p) => p.id === id)),
      provZoho, provFecha,
    };

    const r = await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: KEY, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error("No se pudo guardar el caché: " + (await r.text()).slice(0, 200));

    return json({
      ok: true,
      fecha: valor.fecha,
      ocEnVentana: lote.length,
      abiertas: abiertas.length,
      transitoOK,
      transitoFecha: valor.transitoFecha,
      historialNuevas: backfilled,
      historialFaltan: lote.filter((p) => !p.abierta && !vistas.has(p.id)).length,
      skuEnTransito: Object.keys(valor.transito).length,
      skuConProveedor: Object.keys(prov).length,
      proveedoresZoho: provZoho.length,
      provError,
      frenadas: z.frenadas, esperadoSeg: Math.round(z.esperadoMs / 1000), llamadas: z.llamadas,
      motivos: Object.entries(motivos).sort((a, b) => b[1] - a[1]).slice(0, 5),
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), frenadas: z.frenadas, esperadoSeg: Math.round(z.esperadoMs / 1000), llamadas: z.llamadas }, 500);
  }
});
