// Edge Function: comprometido-sync
//
// Deja en `iso3-comprometido-ov` el desglose de las EXISTENCIAS COMPROMETIDAS
// por orden de venta: para cada SKU, que ordenes lo tienen apartado, de que
// proyecto y cuantas piezas. Es la hoja "Exist Comp" del Excel de Jesus, en vivo.
//
// POR QUE HACE FALTA
// Zoho da el comprometido TOTAL por articulo (`actual_committed_stock`), un solo
// numero. Para repartirlo por mes hay que saber de que orden viene cada pieza, y
// eso solo esta dentro de cada orden de venta. No hay atajo: el listado de
// ordenes NO trae los renglones.
//
// LA REGLA, VERIFICADA CONTRA SO-00069 RENGLON POR RENGLON
//   comprometido = cantidad - entregado, solo en articulos de INVENTARIO.
// El renglon de "suministro e instalacion" es un servicio y no compromete nada,
// aunque se lleve todo el precio de la orden.
//
// POR QUE EL UNIVERSO SALE DE ZOHO
// Las ordenes abiertas son `order_status !== 'closed'` y `status !== 'void'`.
// No se filtra por los proyectos de la app: una obra cerrada aqui puede tener su
// orden abierta alla, comprometiendo material, y hay ordenes que la app no tiene
// amarradas a ningun proyecto. Para compras, no ver una orden significa creer
// que hay material libre que en realidad ya esta apartado.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-comprometido-ov";
const KEY_INV = "iso3-inventario-fisico";
const GAP_MS = 350;
// Solo lo apartado en el Almacén Central. Un renglón surtido desde RMA o desde
// un almacén de importación no compromete el material con el que se trabaja.
const ALMACEN = Deno.env.get("ZOHO_ALMACEN_ID") || "4053294000001024003";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const up = (v: unknown) => String(v ?? "").trim().toUpperCase();
const num = (v: unknown) => Number(v || 0);
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  const z = new Zoho(SB, SRV, ORG);
  const hoyLocal = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);

  try {
    // ── 1. Las ordenes vivas ────────────────────────────────────────────
    const abiertas: Array<{ id: string; ov: string; proyecto: string; cliente: string; estado: string }> = [];
    for (let page = 1; page <= 20; page++) {
      const d = await z.get("/salesorders", {
        page: String(page), per_page: "200", filter_by: "Status.All", sort_column: "salesorder_number",
      });
      for (const o of (d.salesorders || [])) {
        const oe = String(o.order_status || "").toLowerCase();
        const st = String(o.status || "").toLowerCase();
        if (oe === "closed" || st === "void") continue;
        abiertas.push({
          id: String(o.salesorder_id), ov: o.salesorder_number || "",
          proyecto: o.reference_number || o.customer_name || "", cliente: o.customer_name || "", estado: o.status || "",
        });
      }
      if (!d.page_context?.has_more_page) break;
    }
    if (!abiertas.length) throw new Error("Zoho no devolvió órdenes de venta; no se toca el caché.");

    // ── 2. Los renglones de cada una ────────────────────────────────────
    // Por SKU: quien lo tiene apartado y cuanto.
    const porSku: Record<string, { total: number; ovs: Array<{ ov: string; proyecto: string; cant: number }> }> = {};
    let fallidas = 0;
    const motivos: Record<string, number> = {};

    for (const so of abiertas) {
      try {
        const d = await z.get(`/salesorders/${encodeURIComponent(so.id)}`);
        for (const l of (d.salesorder?.line_items || [])) {
          // Solo articulos de inventario: un servicio no aparta nada.
          const esInventario = String(l.item_type || "") === "inventory" || String(l.product_type || "") === "goods";
          if (!esInventario) continue;
          // Si el renglón dice de qué almacén sale y no es Central, no es
          // nuestro. Si no lo dice (renglones viejos), se cuenta: dejarlo fuera
          // reportaría menos comprometido del que hay, y eso se lee como
          // material libre.
          if (l.warehouse_id && String(l.warehouse_id) !== ALMACEN) continue;
          const sku = up(l.sku);
          if (!sku) continue;
          const comp = num(l.quantity) - num(l.quantity_delivered);
          if (comp <= 0) continue;
          const e = (porSku[sku] = porSku[sku] || { total: 0, ovs: [] });
          e.total += comp;
          e.ovs.push({ ov: so.ov, proyecto: so.proyecto, cant: comp });
        }
      } catch (e) {
        fallidas++;
        const m = String((e as Error)?.message || e).slice(0, 160);
        motivos[m] = (motivos[m] || 0) + 1;
      }
      await dormir(GAP_MS);
    }

    // Una lectura incompleta reporta MENOS comprometido del que hay, y eso se
    // lee como material libre. Mejor conservar el de ayer.
    if (fallidas > abiertas.length * 0.1) {
      throw new Error(`${fallidas} de ${abiertas.length} órdenes no se pudieron leer; no se toca el caché.`);
    }

    // ── 3. Comprobacion contra el total que da Zoho ─────────────────────
    // Si nuestro desglose no suma lo que Zoho dice del articulo, algo se nos
    // escapa. Se reporta en vez de esconderse.
    let cuadran = 0, difieren = 0, sinInv = 0;
    const ejemplos: Array<{ sku: string; nuestro: number; zoho: number }> = [];
    try {
      const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${KEY_INV}&select=value`, {
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
      });
      if (r.ok) {
        const rows = await r.json();
        const inv = rows?.[0]?.value ? JSON.parse(rows[0].value).items || {} : {};
        for (const [sku, e] of Object.entries(porSku)) {
          const zc = inv[sku]?.comprometido;
          if (zc == null) { sinInv++; continue; }
          if (Math.abs(e.total - +zc) < 0.01) cuadran++;
          else { difieren++; if (ejemplos.length < 5) ejemplos.push({ sku, nuestro: e.total, zoho: +zc }); }
        }
      }
    } catch { /* la comprobación es opcional */ }

    const valor = { fecha: hoyLocal(), ordenes: abiertas.length, porSku };
    const up2 = await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: KEY, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });
    if (!up2.ok) throw new Error("No se pudo guardar: " + (await up2.text()).slice(0, 200));

    return json({
      ok: true, fecha: valor.fecha,
      ordenesAbiertas: abiertas.length, ordenesFallidas: fallidas,
      skuComprometidos: Object.keys(porSku).length,
      cuadranConZoho: cuadran, difieren, sinInventario: sinInv, ejemplos,
      llamadas: z.llamadas, frenadas: z.frenadas,
      motivos: Object.entries(motivos).sort((a, b) => b[1] - a[1]).slice(0, 3),
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), llamadas: z.llamadas }, 500);
  }
});
