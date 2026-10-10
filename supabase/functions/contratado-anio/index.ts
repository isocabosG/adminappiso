// Edge Function: contratado-anio
//
// EL CONTRATADO VENDIDO DE UN AÑO, CALCULADO COMO LO DEFINE FRAN:
//
//     el concepto 1 de cada orden de venta - SUMINISTRO E INSTALACION ... -
//     más 16% de IVA
//
// Hace falta porque los tres tableros dan tres cifras distintas (10-oct-2026):
//   - Books y el tablero de Quote Creator (que lee `ventas_historico`, su copia)
//     devuelven el `total` del encabezado de la orden. Resultan ser los que más
//     se acercan: 9,401,521 USD contra 9,453,037 de obra. Los 51,314 de
//     diferencia son 7 órdenes: las que entran sin IVA desde Quote Creator
//     (SO-01127, SO-01077), las de concepto 1 exento (SO-00950, SO-00895) y
//     las que traen renglones de equipo sin gravar (SO-01051, SO-00952).
//   - AdminAppISO usa el total de la FACTURA cuando la hay y el de la orden
//     cuando no (`totDoc()` en App.jsx), y multiplica por 1.16 solo si
//     `source = api`. Ese es el que más se aleja.
// Esta función aplica la definición una sola vez para que los tres se cuelguen
// de ella en vez de discutir totales.
//
// POR QUÉ NO BASTA `so-contratado`
// Esa barre solo las órdenes VIVAS (excluye las cerradas) y guarda un corte
// diario: 126 órdenes de todos los años. Para un año completo hacen falta
// también las cerradas, que son la mayoría.
//
// QUÉ SE LEE COMO CONTRATADO, Y POR QUÉ NO ES EL CONCEPTO 1
// Leer el concepto 1 directo da 1.8 M USD de menos. Causa: el link viejo de
// Innobyte le RESTABA al concepto 1 el valor de los materiales que no salían
// en cero, sin tocar el total. 65 órdenes no-postventa de 2026 traen material
// con precio y en las 65 se cumple concepto 1 + material = subtotal; en 61 de
// ellas total = subtotal x 1.16 al centavo. La firma son tres concepto 1 en
// NEGATIVO (SO-00790, SO-00900, SO-00905): una resta que se pasó.
// El total nunca se movió, así que el SUBTOTAL es el contrato. Eso es lo que
// devuelve `contratado`.
//
// Se toma el subtotal TAL COMO ESTÁ, sin devolver los ajustes de cierre. Los
// renglones AJUSTE de la depuración del 9-oct son garantías dadas por perdidas,
// no ventas: devolverlos infla postventa MXN de 2.29 a 8.30 millones. En obra
// los ajustes son -80,913 USD / -100,555 MXN, el 1% de la cifra.
//
// No se corrige el dato en Zoho: de las 38 órdenes con renglón INST comido,
// 37 están CERRADAS y la única abierta es SO-01069 con 73.52 USD. No hay nada
// que escribir; se arregla midiendo, no escribiendo.
//
// Las órdenes DEPURADAS (garantías llevadas a cero el 9-oct) no aparecen: no
// son ventas. 2026: 14 de obra y 75 de postventa quedan fuera del conteo.
// Se excluyen por TOTAL de la orden en cero, no por subtotal: ver abajo.
//
// Las órdenes sin concepto 1 (21 en 2026: REVISION, GEN, INGENIERIA, ALARMAS)
// SÍ cuentan en el total, por decisión de Fran del 10-oct-2026.
//
// BARRIDO REANUDABLE
// Son ~390 órdenes por año y una llamada no alcanza. La primera corrida arma
// la lista de ids y la guarda; cada llamada siguiente avanza lo que le da el
// tiempo y deja el progreso en adm_kv. Se llama hasta que `pendientes` sea 0.
// `reiniciar: true` empieza de cero.
//
// CORRIDA DEL 10-OCT-2026 (2026 completo, 389 órdenes, 0 fallos)
//   OBRA       USD 9,453,036.91   MXN 3,552,091.95   (120 órdenes)
//   POSTVENTA  USD   122,529.99   MXN 2,288,824.95   (180 órdenes)
// Leyendo solo el concepto 1 habría dado 7,634,612.50 USD / 2,140,603.01 MXN.
// Ver claude/contratado-2026-concepto1.md.
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
          // LA CIFRA. El total de la orden nunca se movio cuando la resta le
          // comio el importe al concepto 1, asi que el subtotal ES el contrato.
          // Se toma TAL COMO ESTA, sin devolver los ajustes: los AJUSTE de la
          // depuracion son garantias dadas por perdidas, no ventas. Devolverlos
          // inflaba postventa MXN de 2.29 a 8.30 millones.
          contratado: r2(n0(so?.sub_total) * 1.16),
          // Para contraste, no para reportar:
          contratadoFran: r2(base * 1.16),       // solo el concepto 1 (+ ajustes)
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
    const todas: any[] = Object.values(est.porOv);
    // Las depuradas quedan FUERA del reporte, no solo en cero: son garantias,
    // nunca fueron una venta, y contarlas como ordenes infla el conteo del ano
    // (2026: 14 de obra y 75 de postventa). Decision de Fran, 10-oct-2026.
    //
    // El criterio es el TOTAL de la orden, no el subtotal. Filtrar por
    // |subtotal| >= 1 dejaba pasar SO-01011 QUERENCIA 49: subtotal -173.39 con
    // el total en 0, porque su ajuste de -1,342.96 sobrepaso el subtotal. Metia
    // -201.13 USD a la cifra de obra. Una venta tiene total positivo; lo demas
    // esta depurado. Lo encontro Quote Creator al verificar la cifra.
    const vals: any[] = todas.filter((v) => n0(v.totalOrden) >= 0.5);
    const depuradas = todas.length - vals.length;
    const esPV = (v: any) => up(v.cliente) === "POSTVENTA" || /POSTVENTA/.test(up(v.proyecto));
    // Se DERIVA del subtotal en vez de leer el campo `contratado` guardado, para
    // que un blob escrito por una version anterior tambien de la cifra buena.
    // Leerlo del campo hacia que un barrido viejo reportara 0.00.
    const contratadoDe = (v: any) => n0(v.subtotalOrden) * 1.16;
    const bloque = (lista: any[]) => {
      const por = (mon: string, campo: string) =>
        r2(lista.filter((v) => v.moneda === mon).reduce((a, v) => a + n0(v[campo]), 0));
      const porC = (mon: string) =>
        r2(lista.filter((v) => v.moneda === mon).reduce((a, v) => a + contratadoDe(v), 0));
      return {
        ordenes: lista.length,
        sinConceptoInst: lista.filter((v) => v.sinInst).length,
        // La cifra buena:
        contratadoUSD: porC("USD"), contratadoMXN: porC("MXN"),
        // Lo que da leer el concepto 1 crudo: 1.8M USD menos, porque 35 ordenes
        // cerradas traen el importe en los renglones de material. No reportar.
        soloConcepto1USD: por("USD", "contratadoFran"), soloConcepto1MXN: por("MXN", "contratadoFran"),
        totalOrdenUSD: por("USD", "totalOrden"), totalOrdenMXN: por("MXN", "totalOrden"),
      };
    };
    const difieren = vals.filter((v) => Math.abs(contratadoDe(v) - n0(v.totalOrden)) > 1);

    return json({
      ok: true, anio,
      progreso: { leidas: todas.length, pendientes: est.pendientes.length, completo: est.pendientes.length === 0 },
      depuradasExcluidas: depuradas,
      obra: bloque(vals.filter((v) => !esPV(v))),
      postventa: bloque(vals.filter(esPV)),
      todo: bloque(vals),
      // Donde el contratado no coincide con el total del encabezado. Son las
      // ordenes que entran sin IVA, las de concepto 1 exento y las que traen
      // renglones de equipo sin gravar. 2026: 6 ordenes, 51,515 USD.
      difierenContraEncabezado: {
        ordenes: difieren.length,
        detalle: difieren
          .sort((a, b) => Math.abs(contratadoDe(b) - n0(b.totalOrden)) - Math.abs(contratadoDe(a) - n0(a.totalOrden)))
          .slice(0, 12)
          .map((v) => ({
            ov: Object.keys(est.porOv).find((k) => est.porOv[k] === v),
            proyecto: v.proyecto, moneda: v.moneda, origen: v.origen,
            contratado: r2(contratadoDe(v)), totalEncabezado: v.totalOrden,
            diferencia: r2(contratadoDe(v) - n0(v.totalOrden)),
          })),
      },
      fallos,
      segundos: Math.round((Date.now() - t0) / 1000),
      llamadas: z.llamadas, frenadas: z.frenadas,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), llamadas: z.llamadas }, 500);
  }
});
