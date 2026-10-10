// Edge Function: contratado-anio
//
// EL CONTRATADO VENDIDO DE UN AÑO, CALCULADO COMO LO DEFINE FRAN:
//
//     el concepto 1 de cada orden de venta - SUMINISTRO E INSTALACION ... -
//     más 16% de IVA
//
// Hace falta porque NINGUNO de los tres tableros lo calcula así (10-oct-2026):
//   - Books devuelve el `total` del encabezado de la orden.
//   - El tablero de Quote Creator lee `ventas_historico`, su copia de esos
//     mismos totales.
//   - AdminAppISO usa el total de la FACTURA cuando la hay, y el de la orden
//     cuando no (`totDoc()` en App.jsx).
// Los tres son números distintos y ninguno es el contratado. Esta función es
// la única que aplica la definición, para que los tres puedan colgarse de ella
// en vez de discutir totales.
//
// POR QUÉ NO BASTA `so-contratado`
// Esa barre solo las órdenes VIVAS (excluye las cerradas) y guarda un corte
// diario: 126 órdenes de todos los años. Para un año completo hacen falta
// también las cerradas, que son la mayoría.
//
// DOS CIFRAS, A PROPÓSITO
//   contratadoFran = (INST + ajustes) x 1.16
//   contratadoZoho = (INST + ajustes) + el IVA que Zoho LE CALCULÓ a esos
//                    renglones
// No siempre coinciden, y donde no coinciden hay algo que decidir:
//   - Las órdenes que crea Quote Creator llegan SIN IVA (SO-01127: sub_total
//     258,874.14, tax_total 0). Ahí el renglón no trae impuesto y la de Zoho
//     se queda 16% CORTA: manda la de Fran.
//   - Hay órdenes con el INST genuinamente EXENTO (SO-00950, SO-01077). Ahí
//     x1.16 cobra un IVA que no va: manda la de Zoho.
// Por eso se reportan las dos y se cuentan las que difieren, en vez de elegir
// una y esconder el problema.
//
// OJO CON LOS AJUSTES
// Se leen aparte (`ajSinIva`) y NO deben sumarse al contratado. Los AJUSTE de
// la depuración del 9-oct son espejo de TODOS los renglones de la orden, no
// solo del concepto 1: sumarlos tira el MXN de postventa a -5.68 millones.
// `contratadoFran` los incluye por compatibilidad con `so-ajuste`; el número
// que se publica se arma con `instSinIva` y nada más.
//
// BARRIDO REANUDABLE
// Son ~390 órdenes por año y una llamada no alcanza. La primera corrida arma
// la lista de ids y la guarda; cada llamada siguiente avanza lo que le da el
// tiempo y deja el progreso en adm_kv. Se llama hasta que `pendientes` sea 0.
// `reiniciar: true` empieza de cero.
//
// CORRIDA DEL 10-OCT-2026 (2026 completo, 389 órdenes, 0 fallos)
//   obra  USD  concepto 1 6,581,562.50  ->  x1.16 = 7,634,612.50
//   obra  MXN  concepto 1 1,845,347.42  ->  x1.16 = 2,140,603.01
// De las 95 órdenes de obra USD con concepto 1, 62 lo traen como la orden
// completa y 33 desglosan el material aparte (1,282,242.84 USD que el
// concepto 1 no incluye). Ver claude/contratado-2026-concepto1.md.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GAP_MS = 350;
const TOPE_SEG = 95;
const MAX_PAGINAS = 40;
const MUERTAS = new Set(["draft", "void", "cancelled", "canceled"]);

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n0 = (v: unknown) => +(v ?? 0) || 0;
const up = (s: unknown) => String(s ?? "").trim().toUpperCase();
const r2 = (n: number) => Math.round(n * 100) / 100;

// El concepto 1: el renglón del contrato. Primero por SKU, que es lo estable;
// si no, el primer servicio que se llame suministro e instalación.
const esInst = (li: any) =>
  up(li?.sku) === "INST" ||
  ((li?.line_item_type === "service" || li?.product_type === "service") &&
    /SUMINISTRO\s+E?\s*INSTALACI/i.test(String(li?.name || li?.description || "")));

const esAjuste = (li: any) => up(li?.sku) === "AJUSTE";

// Impuesto que Zoho DE VERDAD le calculó al renglón.
const ivaDe = (li: any) =>
  (li?.line_item_taxes || []).reduce((a: number, t: any) => a + n0(t?.tax_amount), 0);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  let cuerpo: any = {};
  try { cuerpo = await req.json(); } catch { /* sin cuerpo */ }
  const anio = String(cuerpo?.anio || "").trim();
  const reiniciar = cuerpo?.reiniciar === true;
  if (!/^\d{4}$/.test(anio)) return json({ ok: false, error: "Falta `anio` de 4 dígitos." }, 400);

  const KEY = `iso3-contratado-${anio}`;
  const z = new Zoho(SB, SRV, ORG);
  const t0 = Date.now();

  const leer = async () => {
    const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${KEY}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    if (!r.ok) return null;
    try { const f = await r.json(); return JSON.parse(f?.[0]?.value || "null"); } catch { return null; }
  };
  const guardar = async (v: unknown) => {
    await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: KEY, value: JSON.stringify(v), updated_at: new Date().toISOString() }),
    });
  };

  try {
    let est: any = reiniciar ? null : await leer();

    // ── Primera corrida: se arma la lista de ids del año ─────────────────────
    if (!est?.pendientes) {
      const pend: Array<{ ov: string; id: string }> = [];
      let page = 1, more = true;
      while (more && page <= MAX_PAGINAS) {
        const d = await z.get("/salesorders", {
          filter_by: "Status.All", per_page: "200", page: String(page),
          sort_column: "date", sort_order: "A",
        });
        for (const s of (d.salesorders || [])) {
          if (String(s.date || "").slice(0, 4) !== anio) continue;
          if (MUERTAS.has(String(s.status || "").toLowerCase())) continue;
          if (MUERTAS.has(String(s.order_status || "").toLowerCase())) continue;
          pend.push({ ov: s.salesorder_number || "", id: String(s.salesorder_id) });
        }
        more = !!d.page_context?.has_more_page;
        page++;
      }
      if (!pend.length) return json({ ok: false, error: `Zoho no devolvió órdenes de ${anio}.` }, 409);
      est = { anio, arrancado: new Date().toISOString(), pendientes: pend, porOv: {} };
      await guardar(est);
    }

    // ── Avance ───────────────────────────────────────────────────────────────
    const fallos: any[] = [];
    while (est.pendientes.length && (Date.now() - t0) / 1000 < TOPE_SEG) {
      const { ov, id } = est.pendientes[0];
      try {
        const d = await z.get(`/salesorders/${id}`);
        const so = d.salesorder;
        const lineas = so?.line_items || [];
        const inst = lineas.find(esInst) || null;
        const ajustes = lineas.filter(esAjuste);

        const instSinIva = inst ? r2(n0(inst.item_total)) : 0;
        const instIva = inst ? r2(ivaDe(inst)) : 0;
        const ajSinIva = r2(ajustes.reduce((a: number, li: any) => a + n0(li.item_total), 0));
        const ajIva = r2(ajustes.reduce((a: number, li: any) => a + ivaDe(li), 0));
        const base = r2(instSinIva + ajSinIva);

        est.porOv[ov] = {
          id, cliente: so?.customer_name || "", proyecto: so?.reference_number || "",
          moneda: up(so?.currency_code || "MXN"), fecha: so?.date || "",
          estado: String(so?.order_status || "").toLowerCase(),
          origen: String(so?.source || "").toLowerCase(),
          sinInst: !inst,
          instSinIva, ajustes: ajustes.length, ajSinIva,
          base,
          contratadoFran: r2(base * 1.16),
          contratadoZoho: r2(base + instIva + ajIva),
          totalOrden: r2(n0(so?.total)),
          subtotalOrden: r2(n0(so?.sub_total)),
        };
        est.pendientes.shift();
      } catch (e) {
        // Una orden que no se pudo leer NO se descarta en silencio: se manda al
        // final de la cola y se reporta. Un total de ventas incompleto que se
        // ve completo es peor que uno que avisa.
        fallos.push({ ov, mal: String((e as Error)?.message || e).slice(0, 160) });
        est.pendientes.push(est.pendientes.shift());
        if (fallos.length >= 5) break;
      }
      await dormir(GAP_MS);
    }
    est.fallos = fallos;
    est.fecha = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
    await guardar(est);

    // ── Totales de lo que lleva ──────────────────────────────────────────────
    const vals: any[] = Object.values(est.porOv);
    const esPV = (v: any) => up(v.cliente) === "POSTVENTA" || /POSTVENTA/.test(up(v.proyecto));
    const bloque = (lista: any[]) => {
      const por = (mon: string, campo: string) =>
        r2(lista.filter((v) => v.moneda === mon).reduce((a, v) => a + n0(v[campo]), 0));
      return {
        ordenes: lista.length,
        sinConceptoInst: lista.filter((v) => v.sinInst).length,
        franUSD: por("USD", "contratadoFran"), franMXN: por("MXN", "contratadoFran"),
        zohoUSD: por("USD", "contratadoZoho"), zohoMXN: por("MXN", "contratadoZoho"),
        totalOrdenUSD: por("USD", "totalOrden"), totalOrdenMXN: por("MXN", "totalOrden"),
      };
    };
    const difieren = vals.filter((v) => Math.abs(n0(v.contratadoFran) - n0(v.contratadoZoho)) > 1);

    return json({
      ok: true, anio,
      progreso: { leidas: vals.length, pendientes: est.pendientes.length, completo: est.pendientes.length === 0 },
      obra: bloque(vals.filter((v) => !esPV(v))),
      postventa: bloque(vals.filter(esPV)),
      todo: bloque(vals),
      // Donde x1.16 y el IVA real de Zoho no dicen lo mismo. Son las órdenes
      // que hay que mirar una por una antes de cerrar la cifra del año.
      difierenFranVsZoho: {
        ordenes: difieren.length,
        sinImpuestoEnElRenglon: difieren.filter((v) => n0(v.contratadoZoho) < n0(v.contratadoFran)).length,
        conImpuestoDeMas: difieren.filter((v) => n0(v.contratadoZoho) > n0(v.contratadoFran)).length,
        peores: difieren
          .sort((a, b) => Math.abs(n0(b.contratadoFran) - n0(b.contratadoZoho)) - Math.abs(n0(a.contratadoFran) - n0(a.contratadoZoho)))
          .slice(0, 8)
          .map((v) => ({ ov: Object.keys(est.porOv).find((k) => est.porOv[k] === v), proyecto: v.proyecto, moneda: v.moneda, origen: v.origen, fran: v.contratadoFran, zoho: v.contratadoZoho })),
      },
      fallos,
      segundos: Math.round((Date.now() - t0) / 1000),
      llamadas: z.llamadas, frenadas: z.frenadas,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), llamadas: z.llamadas }, 500);
  }
});
