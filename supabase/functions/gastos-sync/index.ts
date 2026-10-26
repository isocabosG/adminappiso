// Edge Function: gastos-sync
//
// Baja los gastos del anio a `iso3-gastos-zoho`. Es la unica pieza de datos que
// le faltaba al flujo de efectivo: los saldos de banco, los pagos de clientes y
// el contratado por OV ya se bajan solos.
//
// LA TRAMPA QUE ESTA FUNCION EXISTE PARA EVITAR
// Del 1-sep al 19-oct Zoho tenia 182 gastos por 35.5 M. De esos, 22.3 M NO son
// salida de efectivo:
//   19.6 M  "Cambio Divisa Dolares" - 12 movimientos que salen de Mifel Dolares
//           y entran como pesos. Es un traspaso entre cuentas propias.
//    2.7 M  "Ajuste al Neto" - asientos contables del 9-sep sobre cuentas
//           ZInactivo y Fondos Sin Depositar.
// La salida real son 13.2 M en 7 semanas, ~1.9 M por semana. Sin esta
// clasificacion la grafica dice que la empresa gasta 5 M a la semana y esta mal
// desde el primer dia.
//
// POR QUE EL TRASPASO SE MARCA Y NO SE BORRA
// Decision de Fran (19-oct): el cambio de divisas no entra al flujo. Pero si se
// tiran los renglones, saldo inicial + entradas - salidas deja de dar el saldo
// final, y una tabla de flujo que no cuadra contra el banco no la vuelve a creer
// nadie. Por eso cada gasto viaja con `traspaso: true|false` y el `motivo`, y la
// pantalla decide: los suma en su propio renglon, fuera de "salidas".
//
// POR QUE LAS REGLAS ESTAN EN UNA CONSTANTE Y NO ESCONDIDAS EN UN IF
// Clasificar mal un gasto mueve el valle de la semana, que es el numero con el
// que se decide. REGLAS_TRASPASO se lee de un vistazo y cada renglon dice por
// que esta ahi. Si manana aparece otro concepto que es traspaso, se agrega una
// linea y se vuelve a correr; no hay que releer la funcion.
//
// POR QUE NO PASA POR `zoho-books`
// Igual que el resto de las sincronias: funcion llamando a funcion pega con el
// limite de Supabase ("Rate limit exceeded for trace"). Se le habla a Zoho
// directo con el cliente compartido, que ademas comparte el token.
//
// verify_jwt: TRUE. El cron le pasa la llave en los headers, igual que oc-sync.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-gastos-zoho";
const MAX_PAGINAS = 40;

// Cada regla dice que texto delata al traspaso, donde buscarlo y por que no es
// salida de efectivo. El `motivo` viaja pegado al gasto para que en la pantalla
// se pueda auditar sin volver a Zoho.
const REGLAS_TRASPASO: { re: RegExp; motivo: string }[] = [
  { re: /cambio\s+divisa/i,      motivo: "Cambio de divisa entre cuentas propias" },
  { re: /ajuste\s+al\s+neto/i,   motivo: "Ajuste contable, no toca banco" },
  { re: /traspaso|transferencia\s+entre\s+cuentas/i, motivo: "Traspaso entre cuentas propias" },
];

// Cuentas que no son dinero disponible: lo que sale de aqui no es egreso del
// negocio. ZInactivo son cuentas dadas de baja; Fondos Sin Depositar es el
// limbo de Zoho entre que se cobra y se deposita.
const CUENTAS_NO_BANCO = /zinactivo|fondos\s+sin\s+depositar|undeposited/i;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const n0 = (v: unknown) => +(v ?? 0) || 0;
const r2 = (n: number) => Math.round(n * 100) / 100;

// Lunes de la semana de esa fecha, en YYYY-MM-DD. Se guarda la fecha y no el
// numero de semana ISO a proposito: el numero se repite cada anio y en el cruce
// de diciembre/enero manda a la semana 1 fechas del anio anterior. La fecha del
// lunes ordena sola y nunca es ambigua.
const lunesDe = (iso: string): string => {
  const d = new Date(iso + "T00:00:00Z");
  if (isNaN(+d)) return "";
  const dow = d.getUTCDay();                 // 0 = domingo
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV || !ORG) {
    return json({ ok: false, error: "Faltan SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY o ZOHO_ORG_ID." }, 500);
  }

  let cuerpo: any = {};
  try { cuerpo = await req.json(); } catch { /* el cron lo llama sin cuerpo */ }
  const hoyISO = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
  const anio = String(cuerpo?.anio || hoyISO.slice(0, 4));
  // `muestra` devuelve los primeros gastos CRUDOS y no escribe nada. Sirve para
  // ver que campos manda Zoho de verdad antes de confiar en el mapeo.
  const muestra = cuerpo?.muestra === true;

  const z = new Zoho(SB, SRV, ORG);
  const t0 = Date.now();

  try {
    const crudos: any[] = [];
    let page = 1, more = true;
    while (more && page <= MAX_PAGINAS) {
      const d = await z.get("/expenses", {
        per_page: "200", page: String(page),
        sort_column: "date", sort_order: "A",
        date_start: `${anio}-01-01`, date_end: `${anio}-12-31`,
      });
      for (const e of (d.expenses || [])) crudos.push(e);
      more = !!d.page_context?.has_more_page;
      page++;
    }

    if (muestra) {
      return json({ ok: true, escrito: false, anio, leidos: crudos.length,
                    campos: Object.keys(crudos[0] || {}), ejemplo: crudos.slice(0, 3) });
    }

    const gastos = crudos.map((e) => {
      const categoria = String(e.account_name || "").trim();
      const cuenta = String(e.paid_through_account_name || "").trim();
      const desc = String(e.description || "").trim();
      const prov = String(e.vendor_name || "").trim();
      // Se busca en los cuatro campos porque el concepto no siempre cae en el
      // mismo: "Cambio Divisa Dolares" a veces es la categoria y a veces la
      // descripcion del movimiento.
      const texto = `${categoria} ${desc} ${prov} ${cuenta}`;
      const regla = REGLAS_TRASPASO.find((r) => r.re.test(texto));
      const noBanco = CUENTAS_NO_BANCO.test(cuenta);
      const fecha = String(e.date || "").slice(0, 10);

      // `total` viene en la moneda del gasto; `bcy_total` ya convertido a pesos
      // por Zoho al TC del documento. Para el consolidado se usa bcy_total y no
      // se recalcula: el TC del dia del gasto es el que de verdad se pago.
      const moneda = String(e.currency_code || "MXN").toUpperCase();
      const tc = n0(e.exchange_rate) || 1;
      const total = r2(n0(e.total));

      return {
        id: String(e.expense_id || ""),
        fecha, semana: lunesDe(fecha),
        categoria, cuenta, proveedor: prov, desc,
        moneda, tc, total,
        totalMXN: r2(n0(e.bcy_total) || total * tc),
        estado: String(e.status || ""),
        traspaso: !!regla || noBanco,
        motivo: regla?.motivo || (noBanco ? "Cuenta que no es dinero disponible" : null),
      };
    }).filter((g) => g.fecha);

    const salidas = gastos.filter((g) => !g.traspaso);
    const traspasos = gastos.filter((g) => g.traspaso);
    const suma = (l: any[], campo: string) => r2(l.reduce((a, b) => a + n0(b[campo]), 0));

    // Por semana, para que la pantalla no vuelva a recorrer todo el arreglo.
    const porSemana: Record<string, any> = {};
    for (const g of gastos) {
      const s = (porSemana[g.semana] = porSemana[g.semana] || { salidaMXN: 0, salidaUSD: 0, traspasoMXN: 0, n: 0 });
      s.n++;
      if (g.traspaso) s.traspasoMXN += g.totalMXN;
      else if (g.moneda === "USD") s.salidaUSD += g.total;
      else s.salidaMXN += g.total;
    }
    for (const s of Object.values<any>(porSemana)) {
      s.salidaMXN = r2(s.salidaMXN); s.salidaUSD = r2(s.salidaUSD); s.traspasoMXN = r2(s.traspasoMXN);
    }

    // Las categorias mas grandes primero: es lo que se mira cuando el valle de
    // una semana sorprende.
    const porCategoria: Record<string, number> = {};
    for (const g of salidas) porCategoria[g.categoria || "(sin categoria)"] = (porCategoria[g.categoria || "(sin categoria)"] || 0) + g.totalMXN;
    const categorias = Object.entries(porCategoria).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ categoria: k, mxn: r2(v) }));

    const valor = {
      fecha: hoyISO, anio,
      leidosDeZoho: crudos.length,
      salidas: { gastos: salidas.length, mxn: suma(salidas, "totalMXN") },
      traspasos: { gastos: traspasos.length, mxn: suma(traspasos, "totalMXN") },
      categorias, porSemana, gastos,
    };

    await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: KEY, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });

    return json({
      ok: true, escrito: true, anio,
      leidosDeZoho: crudos.length,
      salidas: valor.salidas, traspasos: valor.traspasos,
      semanas: Object.keys(porSemana).length,
      top5: categorias.slice(0, 5),
      segundos: Math.round((Date.now() - t0) / 1000), llamadas: z.llamadas,
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), llamadas: z.llamadas }, 500);
  }
});
