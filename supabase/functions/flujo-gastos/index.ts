// Edge Function `flujo-gastos` — cuánto se va cada mes, y en qué.
//
// PARA QUÉ EXISTE
// El flujo proyectado necesita tres salidas que hoy se confunden en una sola
// bolsa: el material (que ya calendariza el MRP y las órdenes de compra), los
// impuestos y gastos de aduana (que cuelgan de sus pedimentos) y el gasto
// operativo de todos los días. Las dos primeras ya se pueden fechar. La
// tercera no existía como número: `iso3-operaciones` solo tiene del 2 al 6 de
// noviembre, cinco días, y con cinco días no hay promedio.
//
// Esta función saca del banco los últimos meses y los parte en esas clases,
// para que el flujo reste un gasto operativo medido y no uno inventado.
//
// POR QUÉ `/banktransactions` Y NO `/expenses`
// Lo mismo que aprendió `libro-cotejo`: pagarle a un proveedor contra factura
// crea un `vendorpayment`, no un gasto. Con `/expenses` se vería una fracción
// de lo que de verdad salió del banco.
//
// LO QUE NO SE SUMA
// Un traspaso entre cuentas propias no es un egreso: el dinero sigue en casa.
// Va clasificado aparte y NO entra en ningún total de salida. Y los pagos a
// proveedor se separan del operativo a propósito: ese dinero ya está contado
// en las órdenes de compra abiertas del MRP, y sumarlo otra vez cuenta dos
// veces el mismo material.
//
// LO QUE NO SE PUEDE CLASIFICAR
// Se queda en `sinClasificar`, visible y con su monto. No se reparte a ojo ni
// se mete al operativo "porque algo será": un gasto operativo inflado hace
// creer que falta dinero que no falta.
import { Zoho } from "../_shared/zoho.ts";

const CLAVE = "iso3-flujo-gastos";
const MAX_PAGINAS = 40;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const n0 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const dia = (v: unknown) => { const s = String(v ?? "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; };
const mesDe = (f: string) => f.slice(0, 7);
const sinAcentos = (s: unknown) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

// ── CÓMO SE CLASIFICA ──────────────────────────────────────────────────────
// Gana el primero que empata, y el orden es la regla. Aduana va ANTES que
// proveedores: el IVA de importación se le paga a un tercero y Zoho lo puede
// registrar como pago a proveedor, pero no es material — es el costo de
// meterlo al país, y tiene su propia fecha, la del pedimento.
const ADUANA = /\bIGI\b|IVA IMPORTACION|IVA DE IMPORTACION|\bDTA\b|INCREMENTABLE|PREVALIDACION|HONORARIOS IMPO|AGENTE ADUANAL|PEDIMENTO|ADUANA/;
const NOMINA = /NOMINA|FINIQUITO|AGUINALDO|SUELDO|RAYA|\bIMSS\b|INFONAVIT|SAR\b|PTU\b/;
const IMPUESTO = /\bSAT\b|\bISR\b|\bIVA\b(?! IMPORTACION)|IMPUESTO|DECLARACION|CONTRIBUCION/;
const TRASPASO = /TRASPASO|TRANSFER(ENCIA)? ENTRE|FONDEO|MOVIMIENTO ENTRE CUENTAS/;
const PRESTAMO = /PRESTAMO|CREDITO|INTERES|AMORTIZACION|LEASING|ARRENDAMIENTO FINANCIERO/;

// Los tipos que Zoho pone en `transaction_type`. Se listan los que decidimos
// tratar como traspaso o como entrada; cualquier otro tipo cae a la
// clasificación por texto y, si tampoco empata, a `sinClasificar`.
const TIPO_TRASPASO = new Set(["transfer_fund", "inter_bank_transfer", "owner_contribution", "owner_drawings"]);
const TIPO_ENTRADA = new Set(["customer_payment", "deposit", "sales_without_invoices", "interest_income", "other_income", "refund_from_vendor"]);
const TIPO_PROVEEDOR = new Set(["vendor_payment", "bill_payment"]);
const TIPO_GASTO = new Set(["expense", "card_payment", "expense_refund"]);

function clasificar(t: Record<string, unknown>) {
  const tipo = String(t.transaction_type ?? "").toLowerCase();
  const texto = sinAcentos(
    [t.description, t.reference_number, t.payee_name, t.vendor_name, t.account_name, t.customer_name]
      .filter(Boolean).join(" · "),
  );

  if (TIPO_TRASPASO.has(tipo) || TRASPASO.test(texto)) return "traspaso";
  if (TIPO_ENTRADA.has(tipo)) return "entrada";
  if (ADUANA.test(texto)) return "aduana";
  if (NOMINA.test(texto)) return "nomina";
  if (PRESTAMO.test(texto)) return "prestamo";
  if (TIPO_PROVEEDOR.has(tipo)) return "proveedores";
  if (IMPUESTO.test(texto)) return "impuestos";
  if (TIPO_GASTO.has(tipo)) return "operativo";
  return "sinClasificar";
}

// El monto en pesos. Zoho trae `bcy_*` (base currency, que aquí es MXN) en
// casi todo; cuando no, se multiplica por el tipo de cambio del movimiento.
// Nunca se toma `amount` a secas de una cuenta en dólares: serían pesos que
// valen diecinueve veces menos de lo que dicen.
function montoMxn(t: Record<string, unknown>, monedaCuenta: string) {
  const bcy = n0(t.bcy_amount ?? t.bcy_total);
  if (bcy) return bcy;
  const bruto = n0(t.amount ?? t.total ?? t.debit_or_credit_amount);
  if (monedaCuenta === "MXN") return bruto;
  const tc = n0(t.exchange_rate);
  return tc > 0 ? bruto * tc : bruto;
}

function rangoPorDefecto(meses: number) {
  const hoy = new Date();
  const fin = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() + 1, 0));
  const ini = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - (meses - 1), 1));
  return { desde: ini.toISOString().slice(0, 10), hasta: fin.toISOString().slice(0, 10) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const SB = Deno.env.get("SUPABASE_URL")!;
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ORG = Deno.env.get("ZOHO_ORG_ID")!;

  let cuerpo: Record<string, unknown> = {};
  try { cuerpo = await req.json(); } catch { /* sin cuerpo: todo por defecto */ }

  const muestra = cuerpo.muestra === true;
  const meses = Math.max(1, Math.min(24, Number(cuerpo.meses) || 12));
  const porDefecto = rangoPorDefecto(meses);
  const desde = dia(cuerpo.desde) || porDefecto.desde;
  const hasta = dia(cuerpo.hasta) || porDefecto.hasta;

  const z = new Zoho(SB, SRV, ORG);
  const t0 = Date.now();

  try {
    const cuentas = ((await z.get("/bankaccounts", { per_page: "200" })).bankaccounts || [])
      .filter((c: Record<string, unknown>) => c.is_active !== false);

    // mes -> clase -> {n, mxn}
    const porMes = new Map<string, Record<string, { n: number; mxn: number }>>();
    // Los tipos crudos que trajo Zoho, para que un tipo nuevo no pase de largo
    // confundido con otra cosa.
    const tipos = new Map<string, number>();
    const dudosos: Record<string, unknown>[] = [];
    let leidos = 0;

    const anota = (mes: string, clase: string, mxn: number) => {
      let m = porMes.get(mes);
      if (!m) { m = {}; porMes.set(mes, m); }
      const c = m[clase] || (m[clase] = { n: 0, mxn: 0 });
      c.n++; c.mxn = r2(c.mxn + mxn);
    };

    for (const c of cuentas) {
      const id = String(c.account_id || "");
      if (!id) continue;
      const monedaCuenta = String(c.currency_code || "MXN").toUpperCase();
      let page = 1, more = true;

      while (more && page <= MAX_PAGINAS) {
        const d = await z.get("/banktransactions", {
          account_id: id, per_page: "200", page: String(page),
          sort_column: "date", sort_order: "D",
          date_start: desde, date_end: hasta,
        });
        const lote = d.banktransactions || d.banktransaction || [];
        if (!lote.length) break;

        // Se recorta de este lado SIEMPRE, igual que en `libro-cotejo`: si Zoho
        // ignoró el filtro de fechas el resultado es el mismo y solo costó una
        // página de más.
        let hayViejos = false;
        for (const t of lote) {
          const f = dia(t.date);
          if (!f) continue;
          if (f < desde) { hayViejos = true; continue; }
          if (f > hasta) continue;

          leidos++;
          const tipo = String(t.transaction_type ?? "(sin tipo)").toLowerCase();
          tipos.set(tipo, (tipos.get(tipo) || 0) + 1);

          const clase = clasificar(t);
          const mxn = Math.abs(montoMxn(t, monedaCuenta));
          anota(mesDe(f), clase, mxn);

          if (clase === "sinClasificar" && dudosos.length < 25) {
            dudosos.push({
              fecha: f, tipo, mxn: r2(mxn), cuenta: String(c.account_name || ""),
              texto: String(t.description || t.reference_number || t.payee_name || "").slice(0, 120),
            });
          }
        }
        if (hayViejos) break;
        more = !!d.page_context?.has_more_page;
        page++;
      }
    }

    // ── EL PROMEDIO, SOLO SOBRE MESES COMPLETOS ───────────────────────────
    // El mes en curso lleva once días y promediarlo con los doce anteriores
    // bajaría el operativo de golpe. Se calcula aparte y se dice cuántos meses
    // entraron, para que nadie tenga que adivinar de dónde salió el número.
    const mesActual = new Date().toISOString().slice(0, 7);
    const meses_ = [...porMes.keys()].sort();
    const completos = meses_.filter((m) => m < mesActual);
    const prom = (clase: string) =>
      completos.length
        ? r2(completos.reduce((a, m) => a + (porMes.get(m)?.[clase]?.mxn || 0), 0) / completos.length)
        : 0;

    const resultado = {
      fecha: new Date().toISOString().slice(0, 10),
      desde, hasta,
      cuentas: cuentas.length,
      movimientos: leidos,
      meses: Object.fromEntries(meses_.map((m) => [m, porMes.get(m)])),
      mesesCompletos: completos,
      promedioMensual: {
        operativo: prom("operativo"),
        nomina: prom("nomina"),
        impuestos: prom("impuestos"),
        aduana: prom("aduana"),
        prestamo: prom("prestamo"),
        proveedores: prom("proveedores"),
        sinClasificar: prom("sinClasificar"),
      },
      tiposCrudos: Object.fromEntries([...tipos.entries()].sort((a, b) => b[1] - a[1])),
      dudosos,
      ms: Date.now() - t0,
      llamadas: z.llamadas,
    };

    if (!muestra) {
      await fetch(`${SB}/rest/v1/adm_kv`, {
        method: "POST",
        headers: {
          apikey: SRV, Authorization: `Bearer ${SRV}`,
          "Content-Type": "application/json", Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({ key: CLAVE, value: JSON.stringify(resultado), updated_at: new Date().toISOString() }),
      });
    }

    return new Response(JSON.stringify({ ok: true, guardado: !muestra, ...resultado }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e), ms: Date.now() - t0 }), {
      status: 500, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
