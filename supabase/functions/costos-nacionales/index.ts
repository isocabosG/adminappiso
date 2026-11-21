// Edge Function: costos-nacionales
//
// Deja en `iso3-costos-nacionales` el historial de precios de compra NACIONAL
// por SKU, para que el catálogo pueda promediarlos igual que ya promedia las
// importaciones.
//
// QUÉ CUENTA COMO NACIONAL
// Todo lo que no entró por pedimento. La app ya sabe cuáles OC amparan una
// importación —están escritas en las partidas de `iso3-pedimentos`— así que
// esas se excluyen y el resto es compra nacional. No se adivina por moneda ni
// por nombre de proveedor: se mira el documento.
//
// DE DÓNDE SALE EL PRECIO
// De la ORDEN DE COMPRA (decisión de Fran, 20-nov-2026), no de la factura del
// proveedor. Llega antes y hay muchas más OC capturadas que facturas.
//
// POR QUÉ SE GUARDAN LAS COMPRAS Y NO EL PROMEDIO
// El promedio se calcula al pintar, no aquí. Así la ventana de 12 meses se
// puede mover sin volver a barrer Zoho, y sobre todo: se puede ver DE DÓNDE
// sale un promedio. Un promedio sin sus renglones es un número que nadie puede
// defender — es la lección del PTBG485.
//
// POR QUÉ PIDE POCO Y VUELVE
// El límite de Zoho es por organización y por minuto, y lo comparten esta app,
// IS-PMT y los demás crons. Los encabezados son baratos (100 por llamada); lo
// caro es leer los renglones de cada OC, una llamada cada una. Así que cada
// corrida muerde un lote, se acuerda de lo que ya leyó y la siguiente sigue
// donde quedó. En unos días tiene los 12 meses y después sólo lo nuevo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-costos-nacionales";
const KEY_PED = "iso3-pedimentos";
const MESES = 12;             // ventana del historial
const MAX_PAGINAS = 60;       // tope del barrido de encabezados
const LOTE = 150;             // OC nuevas que se leen completas por corrida
const GAP_MS = 400;           // respiro entre llamadas
const PRESUPUESTO_MS = 110000; // lo más que dura una corrida leyendo detalle
const MAX_POR_SKU = 80;       // compras que se recuerdan de cada SKU

type Compra = { f: string; po: string; q: number; u: number; prov: string };

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const up = (s: unknown) => String(s ?? "").trim().toUpperCase();
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const soloDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  const z = new Zoho(SB, SRV, ORG);
  const arranque = Date.now();

  const leerKV = async (k: string) => {
    const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${k}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows?.[0]?.value) return null;
    try { return JSON.parse(rows[0].value); } catch { return null; }
  };

  const hoyLocal = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
  const desdeFecha = () => {
    const d = new Date(Date.now() - 7 * 3600 * 1000);
    d.setMonth(d.getMonth() - MESES);
    return d.toISOString().slice(0, 10);
  };

  try {
    const previo = (await leerKV(KEY)) || {};
    const compras: Record<string, Compra[]> = previo.compras || {};
    const vistas = new Set<string>(previo.vistas || []);

    // ── Las OC que amparan importaciones NO son compra nacional ─────────────
    const peds = (await leerKV(KEY_PED)) || [];
    const ocImportacion = new Set<string>();
    for (const p of Array.isArray(peds) ? peds : []) {
      for (const x of (p.partidas || [])) {
        const n = soloDigitos(x.oc);
        if (n) ocImportacion.add(n);
      }
      const n = soloDigitos(p.ocZoho);
      if (n) ocImportacion.add(n);
    }

    const desde = desdeFecha();

    // ── 1. Encabezados de la ventana ────────────────────────────────────────
    const enVentana: Array<{ id: string; numero: string; fecha: string; prov: string; moneda: string }> = [];
    let page = 1, more = true, truncado = false;
    while (more) {
      if (page > MAX_PAGINAS) { truncado = true; break; }
      const d = await z.get("/purchaseorders", {
        filter_by: "Status.All", per_page: "100", page: String(page),
        sort_column: "date", sort_order: "D", date_after: desde,
      });
      for (const po of (d.purchaseorders || [])) {
        const st = String(po.status || "").toLowerCase();
        if (st === "cancelled" || st === "draft") continue;
        const numero = String(po.purchaseorder_number || "");
        if (ocImportacion.has(soloDigitos(numero))) continue;   // es importación
        enVentana.push({
          id: String(po.purchaseorder_id),
          numero,
          fecha: String(po.date || ""),
          prov: String(po.vendor_name || ""),
          moneda: String(po.currency_code || "MXN"),
        });
      }
      more = !!d.page_context?.has_more_page;
      page++;
      await dormir(GAP_MS);
    }

    // ── 2. Renglones de las que todavía no se han leído ─────────────────────
    const pendientes = enVentana.filter((p) => !vistas.has(p.id));
    let leidas = 0, renglones = 0, sinTipoCambio = 0;
    for (const po of pendientes) {
      if (leidas >= LOTE) break;
      if (Date.now() - arranque > PRESUPUESTO_MS) break;
      const d = await z.get(`/purchaseorders/${po.id}`, {});
      const det = d.purchaseorder;
      if (det) {
        // El precio viaja en la moneda de la OC. Para promediar en pesos se usa
        // el tipo de cambio de la propia orden; si no lo trae, el renglón se
        // salta y se dice cuántos — mejor que meter dólares al promedio de pesos.
        const tc = +det.exchange_rate || 0;
        const esMXN = String(det.currency_code || "MXN").toUpperCase() === "MXN";
        for (const li of (det.line_items || [])) {
          const sku = up(li.sku);
          const q = +li.quantity || 0;
          const r = +li.rate || 0;
          if (!sku || !(q > 0) || !(r > 0)) continue;
          if (!esMXN && !(tc > 0)) { sinTipoCambio++; continue; }
          const u = esMXN ? r : r * tc;
          (compras[sku] ||= []).push({ f: po.fecha, po: po.numero, q, u, prov: po.prov });
          renglones++;
        }
      }
      vistas.add(po.id);
      leidas++;
      await dormir(GAP_MS);
    }

    // ── 3. Limpieza: fuera de ventana, duplicados y tope por SKU ────────────
    let skus = 0;
    for (const sku of Object.keys(compras)) {
      const seen = new Set<string>();
      const lista = compras[sku]
        .filter((c) => c.f >= desde)
        .filter((c) => { const k = `${c.po}|${c.q}|${c.u}`; if (seen.has(k)) return false; seen.add(k); return true; })
        .sort((a, b) => (a.f < b.f ? 1 : -1))
        .slice(0, MAX_POR_SKU);
      if (lista.length) { compras[sku] = lista; skus++; } else delete compras[sku];
    }

    const idsVentana = new Set(enVentana.map((p) => p.id));
    const valor = {
      fecha: hoyLocal(),
      desde,
      meses: MESES,
      compras,
      vistas: Array.from(vistas).filter((id) => idsVentana.has(id)),
      ocEnVentana: enVentana.length,
      faltanPorLeer: Math.max(0, pendientes.length - leidas),
      truncado,
    };

    const r = await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: KEY, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error("No se pudo guardar: " + (await r.text()).slice(0, 200));

    return json({
      ok: true, fecha: valor.fecha, desde,
      ocEnVentana: enVentana.length, ocLeidasHoy: leidas,
      faltanPorLeer: valor.faltanPorLeer, renglones, skus,
      sinTipoCambio, barridoTruncado: truncado,
      ocDeImportacionExcluidas: ocImportacion.size,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
