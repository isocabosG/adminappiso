// Edge Function: so-contratado
//
// Deja en `iso3-so-contratado` dos cosas que solo se pueden saber leyendo los
// RENGLONES de cada orden de venta, y que `list_salesorders` no devuelve:
//
//   1. CUANTO SE CONTRATO de verdad.
//   2. QUE ORDENES TRAEN MATERIAL CON PRECIO, que es lo que infla el total.
//
// POR QUE EL CONTRATADO NO ES EL TOTAL DE LA ORDEN
// La regla de la casa: el material y el equipo van en `rate: 0` y el precio de
// venta vive en el concepto INST («SUMINISTRO E INSTALACION…»). El contratado
// es ese renglon con su IVA, nada mas.
//
// Mientras existio la integracion de Innobyte, su carga de Excel iba RESTANDO
// del INST conforme se subian materiales, asi que el total de la orden siempre
// cuadraba con el contrato aunque el material llevara precio. Esa integracion
// se revoco el 05-oct-2026. Desde entonces, el material que se agrega a mano
// se SUMA y nadie resta del INST: la orden de venta queda por encima del
// contrato.
//
// Caso que lo mostro (SO-01059, FIDEICOMISO OASIS 01):
//     INST ....................  547,749.14
//     material con precio .....  183,680.00
//     subtotal de la orden ....  731,429.14
//     contrato real ...........  635,389.00  (= 547,749.14 x 1.16)
// La factura se emitio por 635,389 exacto. Los 183,680 son el inflado.
//
// POR QUE NO SE TOMA EL 16% A CIEGAS
// El IVA sale de los impuestos del PROPIO renglon, no de multiplicar por 1.16.
// Hay ordenes en USD y clientes con tratamiento distinto; una constante
// escondida en el codigo da un contratado que se ve bien y no lo es.
//
// POR QUE EL UNIVERSO SALE DE ZOHO
// Igual que en `so-limpieza`: armarlo con los proyectos de la app deja huecos —
// una obra cerrada aqui puede tener su orden abierta alla. Para un reporte de
// dinero, no ver una orden es peor que tardarse.
//
// ESTO NO ESCRIBE EN ZOHO. Lee y guarda un blob. Corregir las ordenes infladas
// es decision de direccion y va por otro lado.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-so-contratado";
const MAX_PAGINAS = 40;      // encabezados: 40 x 200 = 8,000 ordenes
const GAP_MS = 400;          // respiro entre llamadas
const CERRADAS = new Set(["closed"]);
const MUERTAS = new Set(["draft", "cancelled", "void"]);

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n0 = (v: unknown) => +(v ?? 0) || 0;
const up = (s: unknown) => String(s ?? "").trim().toUpperCase();

// El renglon del contrato. Primero por SKU, que es lo estable; si no, el primer
// servicio que se llame suministro e instalacion. Fran: "nunca tiene varios
// conceptos de suministro e instalacion, solo es el primero".
const esInst = (li: any) =>
  up(li?.sku) === "INST" ||
  ((li?.line_item_type === "service" || li?.product_type === "service") &&
    /SUMINISTRO\s+E?\s*INSTALACI/i.test(String(li?.name || li?.description || "")));

// IVA del renglon, tomado del renglon. Sin constantes escondidas.
const ivaDe = (li: any) =>
  (li?.line_item_taxes || []).reduce((a: number, t: any) => a + n0(t?.tax_amount), 0);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  const z = new Zoho(SB, SRV, ORG);
  const hoyLocal = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);

  const leerBlob = async () => {
    const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${KEY}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    try { return rows?.[0]?.value ? JSON.parse(rows[0].value) : null; } catch { return null; }
  };

  try {
    const previo = (await leerBlob()) || {};

    // ── 1. Encabezados: que ordenes siguen vivas ───────────────────────────
    const activas: Array<{ id: string; num: string; cliente: string; mon: string; estado: string; fact: string }> = [];
    let page = 1, more = true, truncado = false;
    while (more) {
      if (page > MAX_PAGINAS) { truncado = true; break; }
      const d = await z.get("/salesorders", {
        filter_by: "Status.All", per_page: "200", page: String(page), sort_column: "date", sort_order: "D",
      });
      for (const s of (d.salesorders || [])) {
        const est = String(s.order_status || "").toLowerCase();
        const st = String(s.status || "").toLowerCase();
        if (CERRADAS.has(est) || MUERTAS.has(est) || MUERTAS.has(st)) continue;
        activas.push({
          id: String(s.salesorder_id), num: s.salesorder_number || "", cliente: s.customer_name || "",
          mon: String(s.currency_code || "MXN").toUpperCase(), estado: est,
          fact: String(s.invoiced_status || ""),
        });
      }
      more = !!d.page_context?.has_more_page;
      page++;
    }
    if (!activas.length) throw new Error("Zoho no devolvió órdenes de venta; no se toca el caché.");

    // ── 2. Los renglones, una orden a la vez ───────────────────────────────
    const porOv: Record<string, any> = {};
    const motivos: Record<string, number> = {};
    let completo = !truncado;
    if (truncado) motivos[`barrido truncado en ${MAX_PAGINAS} paginas`] = 1;

    for (const o of activas) {
      try {
        const d = await z.get(`/salesorders/${o.id}`);
        const lineas = d.salesorder?.line_items || [];

        const inst = lineas.find(esInst) || null;
        const instSinIva = inst ? n0(inst.item_total) : 0;
        const contratado = inst ? instSinIva + ivaDe(inst) : null;

        // Material con precio: lo que deberia ir en cero y no lo esta.
        const conPrecio = lineas
          .filter((li: any) => !esInst(li) && (li.line_item_type === "goods" || li.product_type === "goods") && n0(li.rate) > 0)
          .map((li: any) => ({
            sku: up(li.sku), nombre: li.name || li.description || "", cant: n0(li.quantity),
            precio: n0(li.rate), importe: n0(li.item_total),
            facturado: n0(li.quantity_invoiced) > 0,
          }));

        porOv[o.num] = {
          id: o.id, cliente: o.cliente, moneda: o.mon, estado: o.estado, facturacion: o.fact,
          contratado,                                  // INST con su IVA — el contrato
          instSinIva,
          sinInst: !inst,                              // orden sin concepto de suministro: se revisa a mano
          subtotalOrden: n0(d.salesorder?.sub_total),
          totalOrden: n0(d.salesorder?.total),
          material: conPrecio,
          materialImporte: conPrecio.reduce((a: number, m: any) => a + m.importe, 0),
        };
      } catch (e) {
        // Una orden que no se pudo leer deja el reporte incompleto, y un reporte
        // de dinero incompleto se lee como si esas ordenes estuvieran limpias.
        completo = false;
        const m = String((e as Error)?.message || e).slice(0, 160);
        motivos[m] = (motivos[m] || 0) + 1;
      }
      await dormir(GAP_MS);
    }

    const lista = Object.entries(porOv);
    const inflados = lista.filter(([, v]) => v.materialImporte > 0);
    const sinInst = lista.filter(([, v]) => v.sinInst);

    // ── 3. Guardar. Incompleto NO pisa lo bueno ────────────────────────────
    const valor = completo
      ? { fecha: hoyLocal(), corte: hoyLocal(), porOv }
      : { ...(previo || {}), fecha: hoyLocal() };   // se conserva el anterior

    const r = await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: KEY, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error("No se pudo guardar el caché: " + (await r.text()).slice(0, 200));

    return json({
      ok: true,
      fecha: valor.fecha,
      completo,
      barridoTruncado: truncado,
      ordenesActivas: activas.length,
      ordenesLeidas: lista.length,
      conMaterialConPrecio: inflados.length,
      importeMaterialConPrecio: Math.round(inflados.reduce((a, [, v]) => a + v.materialImporte, 0)),
      sinConceptoInst: sinInst.length,
      sinConceptoInstCuales: sinInst.slice(0, 10).map(([k]) => k),
      peores: inflados
        .sort((a, b) => b[1].materialImporte - a[1].materialImporte)
        .slice(0, 10)
        .map(([ov, v]) => ({ ov, cliente: v.cliente, moneda: v.moneda, contratado: v.contratado, deMas: Math.round(v.materialImporte), renglones: v.material.length })),
      frenadas: z.frenadas, esperadoSeg: Math.round(z.esperadoMs / 1000), llamadas: z.llamadas,
      motivos: Object.entries(motivos).sort((a, b) => b[1] - a[1]).slice(0, 5),
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), frenadas: z.frenadas, esperadoSeg: Math.round(z.esperadoMs / 1000), llamadas: z.llamadas }, 500);
  }
});
