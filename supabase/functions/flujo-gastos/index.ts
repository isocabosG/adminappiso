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
// Por el NOMBRE DE LA CUENTA CONTABLE, no por palabras sueltas en la
// descripción. La primera versión usaba expresiones regulares sobre el texto
// libre del movimiento y dio nómina, impuestos y aduana en CERO sobre 5,063
// movimientos — imposible, cuando el libro de noviembre trae NOMINA e IGI con
// nombre y apellido. El texto libre casi siempre viene vacío; lo que sí viene
// es la cuenta a la que se cargó el gasto.
//
// Las listas son las 61 cuentas de gasto que existen hoy en Zoho, leídas del
// catálogo. Una cuenta que NO esté aquí cae en `sinClasificar` a propósito: si
// alguien crea una cuenta nueva, queremos enterarnos en la pantalla y no que
// se diluya dentro del operativo.
const CUENTAS: Record<string, string[]> = {
  nomina: [
    "NOMINA QUINCENAL", "NOMINA SEMANAL", "IMSS SIPARE", "AGUINALDO", "FONACOT",
    "BONO DE PRODUCTIVIDAD", "IMPUESTOS ISN", "EQUIPAMIENTO PARA EL PERSONAL",
  ],
  // El flete entra aquí porque en esta empresa el grueso es traída de material
  // importado, y va pegado al pedimento igual que el IGI.
  aduana: ["GASTOS DE IMPORTACION", "FLETES"],
  prestamo: [
    "PRESTAMO EMPRESA", "PRESTAMOS BANCOS",
    "INTERES BANCARIO PESOS (515-001-611)", "INTERES BANCARIO PESOS (515-001-462)",
  ],
  // Costo de lo vendido es MATERIAL, no operativo. Metido en el operativo
  // inflaba el gasto fijo con el costo de las obras, que ya se cuenta en las
  // órdenes de compra.
  proveedores: ["COSTES DE PRODUCTOS VENDIDOS"],
  operativo: [
    "ALOJAMIENTO", "GASTOS DE COMBUSTIBLE", "COMISIONES SOBRE VENTAS",
    "COMISIONES BANCARIAS", "COMISION BANCARIA PESOS", "SUMINISTROS DE OFICINA",
    "HERRAMIENTAS", "PUBLICIDAD Y MARKETING", "CARGOS Y TASAS BANCARIAS",
    "CARGOS DE TARJETA DE CREDITO", "GASTOS DE VIAJES", "GASTOS TELEFONICOS",
    "RENTA BODEGA Y OFICINA", "GASTOS DE VEHICULOS", "GASTOS DE TI Y DE INTERNET",
    "GASTOS DE ALQUILER", "GASTOS DE MANTENIMIENTO", "GPS VEHICULOS",
    "MATERIAL DE OFICINA E IMPRESION", "CFE ENERGIA", "COMIDAS Y ENTRETENIMIENTO",
    "GASTOS DE CONSULTORES", "SOFTWARE", "HONORARIOS CONTABLES", "HONORARIOS LEGALES",
    "STARLINK", "MEDICINAS", "SERVICIOS", "CONSUMO", "CONSUMIBLES", "CAPACITACION",
    "POLIZAS SEGUROS", "ARTICULOS DE LIMPIEZA", "UTILIDADES", "DEUDA INCOBRABLE",
  ],
  // Ni salida de caja ni gasto: movimientos contables. No suman en ningún lado.
  contable: [
    "GANANCIAS O PERDIDAS DE CAMBIO", "CAMBIO DIVISA DOLARES", "AJUSTE AL NETO",
    "DESCUENTOS DE COMPRA", "GASTO DE DEPRECIACION", "REEMBOLSO CLIENTES",
  ],
};

// Se arma una sola vez: cuenta -> clase.
const CLASE_DE_CUENTA = new Map<string, string>();
for (const [clase, lista] of Object.entries(CUENTAS)) {
  for (const c of lista) CLASE_DE_CUENTA.set(c, clase);
}

// Los tipos que Zoho pone en `transaction_type`.
const TIPO_TRASPASO = new Set(["transfer_fund", "inter_bank_transfer", "owner_contribution", "owner_drawings"]);
const TIPO_ENTRADA = new Set(["customer_payment", "deposit", "sales_without_invoices", "interest_income", "other_income", "refund_from_vendor"]);
const TIPO_PROVEEDOR = new Set(["vendor_payment", "bill_payment"]);

function clasificar(t: Record<string, unknown>) {
  const tipo = String(t.transaction_type ?? "").toLowerCase();

  if (TIPO_TRASPASO.has(tipo)) return "traspaso";
  if (TIPO_ENTRADA.has(tipo)) return "entrada";
  // Un pago a proveedor no pasa por cuenta de gasto: se aplica contra la
  // factura del proveedor. Su clase la da el tipo y nada más.
  if (TIPO_PROVEEDOR.has(tipo)) return "proveedores";

  // De aquí en adelante es un gasto, y manda la cuenta contable. En
  // `/banktransactions` esa cuenta viene en `account_name`; el banco por el que
  // salió es `paid_through_account_name`, que aquí no se mira.
  const cuenta = sinAcentos(t.account_name ?? t.expense_account_name);
  const clase = CLASE_DE_CUENTA.get(cuenta);
  if (clase) return clase;

  // Cuenta que no está en el catálogo, o un movimiento sin cuenta. Visible.
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
    // Un movimiento completo de cada tipo, tal como lo manda Zoho. Sin esto la
    // clasificacion se afina a ciegas: la primera corrida dio nomina, aduana e
    // impuestos en CERO --imposible, el libro de noviembre los trae con nombre
    // y apellido-- y no habia forma de ver que campo hay que mirar.
    const crudoPorTipo = new Map<string, Record<string, unknown>>();
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

          if (!crudoPorTipo.has(tipo)) crudoPorTipo.set(tipo, t);
          const clase = clasificar(t);
          const mxn = Math.abs(montoMxn(t, monedaCuenta));
          anota(mesDe(f), clase, mxn);

          if (clase === "sinClasificar" && dudosos.length < 25) {
            dudosos.push({
              fecha: f, tipo, mxn: r2(mxn), cuenta: String(c.account_name || ""),
              cuenta: String(t.account_name || "(sin cuenta)"),
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
        contable: prom("contable"),
        impuestos: prom("impuestos"),
        aduana: prom("aduana"),
        prestamo: prom("prestamo"),
        proveedores: prom("proveedores"),
        sinClasificar: prom("sinClasificar"),
      },
      tiposCrudos: Object.fromEntries([...tipos.entries()].sort((a, b) => b[1] - a[1])),
      // Solo en `muestra`: no tiene por que vivir en el blob que lee la app.
      ...(muestra ? { crudoPorTipo: Object.fromEntries(crudoPorTipo) } : {}),
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
