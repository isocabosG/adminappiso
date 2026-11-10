// Edge Function: libro-cotejo
//
// NO IMPORTA NADA. SOLO DICE SI LA APP SE QUEDO ATRAS.
//
// Fran, 10-nov-2026: «no quiero agregar nada; si hay diferencias significa que
// no han trabajado en la app y estan subiendo movimientos a Zoho y no a la app.
// Si eso pasa, que salga un cuadro que diga: SE SUBIERON MOVIMIENTOS A ZOHO Y
// NO EN LA APP, LA INFORMACION NO ESTA ACTUALIZADA».
//
// Es la decision correcta y vale la pena escribir por que. Un cron que copiara
// los movimientos de Zoho al libro taparia el problema de verdad --que el
// equipo no esta usando la app-- y lo taparia bien: la pantalla se veria al
// dia para siempre y nadie volveria a capturar nada aqui. Lo que hace falta no
// es rellenar el hueco, es que el hueco se vea.
//
// QUE SE MIDIO ANTES DE ESCRIBIR ESTO (10-nov-2026)
//   · Zoho trae gastos capturados hasta el 9-nov, y se capturan al dia o al dia
//     siguiente (los del 2-nov se crearon el 3-nov; los del 9-nov, el 9-nov).
//   · `iso3-operaciones` de la app termina el 6-nov y no se ha vuelto a escribir
//     desde el 9-nov 12:13, que fue la importacion del Excel de Jesus.
//   · O sea: SI estan capturando, pero en Zoho. La app lleva tres dias atras.
//   · Ninguna cuenta de Zoho tiene feed bancario automatico (`bank_balance` en
//     0 y `feeds_last_refresh_date` vacio en las 28). Zoho tambien es a mano:
//     el libro de bancos no tiene una fuente automatica en ningun lado.
//
// POR QUE `/banktransactions` Y NO `/expenses`
// El libro necesita TODO lo que mueve una cuenta. Un gasto es solo una de las
// formas: pagarle a un proveedor contra su factura crea un `vendorpayment`, no
// un gasto, y en el libro que subio Fran la cuenta Mifel Pesos trae 103
// movimientos del 2 al 6-nov por 2.6 M mientras que en `/expenses` esos mismos
// dias traen unos 20. La diferencia son pagos a proveedores. Contar solo gastos
// daria «te faltan 80» todos los dias y seria mentira en los dos sentidos.
//
// TODAS LAS CUENTAS (Fran: «TODAS»). Bancos, dolares, caja chica, efectivo,
// prestamos y tarjeta. Una cuenta sin movimiento en el mes sale en cero y no
// estorba; dejarla fuera es decidir por el contador que esa cuenta no importa.
//
// LAS FECHAS SE FILTRAN AQUI, NO SOLO EN ZOHO. Se le manda `date_start` y
// `date_end` por si los respeta, pero igual se recorta mes por mes de este
// lado y se deja de pedir paginas en cuanto las fechas se pasan del mes. Asi
// la funcion da el mismo resultado aunque Zoho ignore el filtro o le cambie el
// nombre al parametro: no depende de un contrato que no se pueda verificar.
//
// `muestra: true` no escribe nada y devuelve los movimientos CRUDOS de la
// primera cuenta con actividad, para ver que campos manda Zoho de verdad antes
// de confiar en el mapeo. Mismo patron que `gastos-sync`.
//
// verify_jwt: TRUE. El cron le pasa la llave en los headers, igual que oc-sync.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-libro-cotejo";
const MAX_PAGINAS = 25;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const n0 = (v: unknown) => +(v ?? 0) || 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const dia = (v: unknown) => String(v ?? "").slice(0, 10);

// Los Cabos es UTC-7 todo el año, sin horario de verano.
const hoyMx = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
const finDeMes = (ym: string) => {
  const [a, m] = ym.split("-").map(Number);
  return `${ym}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, "0")}`;
};

async function kv(SB: string, SRV: string, key: string): Promise<any> {
  const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${key}&select=value`, {
    headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
  });
  if (!r.ok) return null;
  const raw = (await r.json())?.[0]?.value;
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

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
  const hoy = hoyMx();
  const ym = /^\d{4}-\d{2}$/.test(String(cuerpo?.ym || "")) ? String(cuerpo.ym) : hoy.slice(0, 7);
  const muestra = cuerpo?.muestra === true;
  const desde = `${ym}-01`, hasta = finDeMes(ym);

  const z = new Zoho(SB, SRV, ORG);
  const t0 = Date.now();

  try {
    const cuentas = (await z.get("/bankaccounts", { per_page: "200" })).bankaccounts || [];

    // ── LO QUE ZOHO TIENE, CUENTA POR CUENTA ────────────────────────────
    const zohoPorCuenta = new Map<string, any>();
    let crudosMuestra: any[] = [];

    for (const c of cuentas) {
      const id = String(c.account_id || "");
      if (!id) continue;
      const movs: any[] = [];
      let page = 1, more = true;

      while (more && page <= MAX_PAGINAS) {
        const d = await z.get("/banktransactions", {
          account_id: id, per_page: "200", page: String(page),
          sort_column: "date", sort_order: "D",
          date_start: desde, date_end: hasta,
        });
        const lote = d.banktransactions || d.banktransaction || [];
        if (!lote.length) break;

        // Se recorta de este lado SIEMPRE: si Zoho ignoró el filtro de fechas,
        // el resultado es el mismo y solo costó una página de más.
        let hayViejos = false;
        for (const t of lote) {
          const f = dia(t.date);
          if (!f) continue;
          if (f < desde) { hayViejos = true; continue; }
          if (f > hasta) continue;
          movs.push(t);
        }
        // Ordenado de nuevo a viejo: si este lote ya trae fechas de antes del
        // mes, las siguientes páginas son más viejas todavía.
        if (hayViejos) break;
        more = !!d.page_context?.has_more_page;
        page++;
      }

      if (muestra && !crudosMuestra.length && movs.length) crudosMuestra = movs.slice(0, 3);

      const mxn = String(c.currency_code || "MXN").toUpperCase() === "MXN";
      zohoPorCuenta.set(id, {
        id, nombre: String(c.account_name || "").trim(),
        tipo: String(c.account_type || ""), moneda: String(c.currency_code || "MXN").toUpperCase(),
        activa: c.is_active !== false,
        saldoZoho: r2(n0(c.current_balance ?? c.balance)),
        n: movs.length,
        monto: r2(movs.reduce((a, t) => a + Math.abs(n0(t.amount)), 0)),
        ultima: movs.map((t) => dia(t.date)).sort().slice(-1)[0] || null,
        // Por día, para poder decir «Zoho tiene 9 movimientos del lunes que
        // la app no tiene» en vez de solo un total que no dice dónde mirar.
        porDia: movs.reduce((m: Record<string, number>, t) => {
          const f = dia(t.date); if (f) m[f] = (m[f] || 0) + 1; return m;
        }, {}),
        esMXN: mxn,
      });
    }

    if (muestra) {
      return json({ ok: true, escrito: false, ym,
        cuentas: cuentas.length,
        conMovimiento: [...zohoPorCuenta.values()].filter((c) => c.n > 0)
          .map((c) => ({ nombre: c.nombre, n: c.n, ultima: c.ultima })),
        campos: Object.keys(crudosMuestra[0] || {}),
        ejemplo: crudosMuestra,
        llamadas: z.llamadas, segundos: Math.round((Date.now() - t0) / 1000) });
    }

    // ── LO QUE LA APP TIENE ─────────────────────────────────────────────
    // `iso3-operaciones` es el libro vivo de Tesorería. Se filtra al mes que
    // se está cotejando y se agrupa por cuenta con la misma llave que Zoho.
    const ops = (await kv(SB, SRV, "iso3-operaciones")) || [];
    const appPorCuenta = new Map<string, any>();
    for (const o of (Array.isArray(ops) ? ops : [])) {
      const f = dia(o?.fecha);
      if (!f || f < desde || f > hasta) continue;
      const id = String(o?.cuentaId || o?.cuenta || "");
      const a = appPorCuenta.get(id) || { n: 0, monto: 0, ultima: null as string | null };
      a.n++; a.monto += Math.abs(n0(o?.monto));
      if (!a.ultima || f > a.ultima) a.ultima = f;
      appPorCuenta.set(id, a);
    }

    // ── EL COTEJO ───────────────────────────────────────────────────────
    // La alarma es UNA SOLA Y EN UN SENTIDO: Zoho trae movimientos que la app
    // no. Es lo que Fran pidió y es lo que significa «no están usando la app».
    // El sentido contrario (la app trae algo que Zoho no) se reporta aparte,
    // sin alarma: el Excel de Jesús puede traer renglones que contabilidad
    // todavía no capturó, y eso no es que la app esté atrasada.
    const filas = [...zohoPorCuenta.values()].map((c) => {
      const a = appPorCuenta.get(c.id) || { n: 0, monto: 0, ultima: null };
      const faltan = Math.max(0, c.n - a.n);
      // Días que Zoho tiene después del último que la app registró: eso es
      // atraso sin ambigüedad, sin tener que casar renglón por renglón.
      const diasDespues = Object.keys(c.porDia)
        .filter((f) => !a.ultima || f > a.ultima).sort();
      return {
        id: c.id, cuenta: c.nombre, tipo: c.tipo, moneda: c.moneda, activa: c.activa,
        zoho: { n: c.n, monto: c.monto, ultima: c.ultima },
        app: { n: a.n, monto: r2(a.monto), ultima: a.ultima },
        faltanEnApp: faltan,
        sobranEnApp: Math.max(0, a.n - c.n),
        diasSinCapturar: diasDespues,
        atrasada: c.n > a.n,
      };
    }).sort((x, y) => y.faltanEnApp - x.faltanEnApp || x.cuenta.localeCompare(y.cuenta));

    const conAtraso = filas.filter((f) => f.atrasada);
    const totalFaltan = conAtraso.reduce((a, f) => a + f.faltanEnApp, 0);
    const ultimaZoho = filas.map((f) => f.zoho.ultima).filter(Boolean).sort().slice(-1)[0] || null;
    const ultimaApp = filas.map((f) => f.app.ultima).filter(Boolean).sort().slice(-1)[0] || null;
    const diasDeAtraso = ultimaZoho && ultimaApp
      ? Math.round((+new Date(ultimaZoho + "T12:00:00Z") - +new Date(ultimaApp + "T12:00:00Z")) / 86400000)
      : null;

    const valor = {
      fecha: hoy, ym, generado: new Date().toISOString(),
      desactualizado: totalFaltan > 0,
      // El texto va en el blob y no en la pantalla a propósito: así el aviso
      // dice lo mismo en Tesorería, en Movimientos y en cualquier lugar donde
      // se pinte mañana, y se corrige en un solo lado.
      aviso: totalFaltan > 0
        ? "SE SUBIERON MOVIMIENTOS A ZOHO Y NO EN LA APP · LA INFORMACIÓN NO ESTÁ ACTUALIZADA"
        : null,
      resumen: {
        cuentas: filas.length,
        cuentasAtrasadas: conAtraso.length,
        movimientosFaltantes: totalFaltan,
        ultimaZoho, ultimaApp, diasDeAtraso,
      },
      cuentas: filas,
      llamadas: z.llamadas,
    };

    await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: KEY, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });

    return json({ ok: true, escrito: true, ym,
      desactualizado: valor.desactualizado, resumen: valor.resumen,
      atrasadas: conAtraso.slice(0, 8).map((f) => ({ cuenta: f.cuenta, faltan: f.faltanEnApp, zoho: f.zoho.n, app: f.app.n })),
      segundos: Math.round((Date.now() - t0) / 1000), llamadas: z.llamadas });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), llamadas: z.llamadas }, 500);
  }
});
