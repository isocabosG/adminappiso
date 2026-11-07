// Edge Function: gasto-zoho
//
// Registra en Zoho Books un EGRESO SIN FACTURA: una comisión bancaria, una
// renta, un cargo automático, un pago del que la factura todavía no llega.
// En Zoho eso es un GASTO (expense), no un pago a proveedor: un pago se aplica
// contra una factura que ya existe, y aquí no hay ninguna.
//
// POR QUE UN GASTO Y NO UN PAGO «A CUENTA»
// El gasto lleva la CUENTA CONTABLE (comisiones bancarias, renta, honorarios),
// que es justo el dato que la pantalla pide como «Concepto». Un pago a cuenta
// dejaría el dinero colgando como saldo a favor del proveedor y alguien
// tendría que aplicarlo después a mano. El gasto baja el banco y clasifica el
// importe en un solo movimiento, que es lo que pasó en la realidad.
//
// LAS CUATRO REVISIONES ANTES DE ESCRIBIR
//   1. El importe es mayor que cero.
//   2. La cuenta contable existe Y es de gasto. Mandar un id cualquiera
//      registraría el importe en la cuenta equivocada, y eso se descubre
//      cerrando el mes.
//   3. La cuenta bancaria existe, y el gasto se crea EN SU MONEDA. Un cargo de
//      30.48 dólares registrado como pesos es un error de 17 a 1.
//   4. Si ya existe un gasto con la misma referencia, NO se crea otro: se
//      devuelve el que estaba. El botón se puede picar dos veces.
//
// LO QUE ESTO **NO** HACE
// No convierte el gasto en factura cuando el CFDI llega después. Eso es una
// decisión contable —Jesús puede querer el gasto tal cual, o la factura con su
// IVA acreditable— y no se toma desde aquí. Lo que sí se puede es corregirle
// la referencia para que deje de decir PENDIENTE.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BITACORA = "iso3-gastos-zoho";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const num = (v: unknown) => { const n = Number(v); return isFinite(n) ? n : 0; };
const txt = (v: unknown) => String(v ?? "").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  try {
    const body = await req.json().catch(() => ({}));

    let actor = "";
    try {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SRV, Authorization: `Bearer ${jwt}` } });
      if (u.ok) actor = String((await u.json())?.email || "");
    } catch { /* sin correo se registra vacio */ }

    const conceptoId = txt(body.conceptoId);       // cuenta contable de gasto
    const conceptoNombre = txt(body.concepto);
    const cuentaZoho = txt(body.cuentaZohoId);     // de que banco salio
    const fecha = txt(body.fecha).slice(0, 10);
    const monto = num(body.monto);
    const referencia = txt(body.referencia);       // «PENDIENTE 1» o el folio real
    const proveedor = txt(body.proveedor);
    const vendorId = txt(body.vendorId);
    const nota = txt(body.nota).slice(0, 480);

    if (!conceptoId) return json({ ok: false, error: "Falta el concepto: sin cuenta contable el gasto no se puede clasificar." }, 400);
    if (!cuentaZoho) return json({ ok: false, error: "Falta la cuenta bancaria de la que sale el gasto." }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return json({ ok: false, error: `Fecha invalida: ${fecha}` }, 400);
    if (!(monto > 0)) return json({ ok: false, error: "El importe tiene que ser mayor que cero." }, 400);
    if (!referencia) return json({ ok: false, error: "Falta la referencia. Es lo que evita registrar el gasto dos veces." }, 400);

    const z = new Zoho(SB, SRV, ORG);

    // REVISION 4 — ¿ya estaba? Se pregunta antes de todo lo demas.
    try {
      const ya = await z.get("/expenses", { reference_number: referencia, per_page: "20" });
      const hit = (ya?.expenses || []).find((e: any) => txt(e.reference_number) === referencia);
      if (hit) {
        return json({
          ok: true, yaExistia: true,
          gastoId: txt(hit.expense_id), referencia,
          mensaje: "Ya había un gasto en Zoho con esa misma referencia. No se creó otro.",
        });
      }
    } catch (e) {
      return json({ ok: false, error: `No se pudo comprobar si el gasto ya existia, asi que no se registro: ${String((e as Error)?.message || e).slice(0, 200)}` }, 502);
    }

    // REVISION 2 — la cuenta contable existe y es de gasto.
    try {
      const coa = await z.get("/chartofaccounts", { filter_by: "AccountType.Expense", per_page: "200" });
      const cta = (coa?.chartofaccounts || []).find((c: any) => txt(c.account_id) === conceptoId);
      if (!cta) return json({ ok: false, error: `La cuenta contable «${conceptoNombre || conceptoId}» no existe en Zoho o no es de gastos.` }, 400);
    } catch (e) {
      return json({ ok: false, error: `No se pudo validar la cuenta contable: ${String((e as Error)?.message || e).slice(0, 180)}` }, 502);
    }

    // REVISION 3 — el banco existe y el gasto se crea EN SU MONEDA.
    let currencyId = "";
    let bancoNombre = "";
    try {
      const bk = await z.get("/bankaccounts", { filter_by: "Status.All", per_page: "200" });
      const b = (bk?.bankaccounts || []).find((x: any) => txt(x.account_id) === cuentaZoho);
      if (!b) return json({ ok: false, error: "La cuenta bancaria no existe en Zoho." }, 400);
      currencyId = txt(b.currency_id);
      bancoNombre = txt(b.account_name);
    } catch (e) {
      return json({ ok: false, error: `No se pudo validar la cuenta bancaria: ${String((e as Error)?.message || e).slice(0, 180)}` }, 502);
    }

    const cuerpo: Record<string, unknown> = {
      account_id: conceptoId,
      date: fecha,
      amount: Number(monto.toFixed(2)),
      paid_through_account_id: cuentaZoho,
      reference_number: referencia,
      description: nota || [conceptoNombre, proveedor].filter(Boolean).join(" · ")
        || `Gasto registrado desde AdminAppISO${actor ? ` por ${actor}` : ""}`,
      is_inclusive_tax: false,
    };
    if (currencyId) cuerpo.currency_id = currencyId;
    if (vendorId) cuerpo.vendor_id = vendorId;

    let creado: any;
    try { creado = await z.post("/expenses", cuerpo); }
    catch (e) { return json({ ok: false, error: `Zoho rechazo el gasto: ${String((e as Error)?.message || e).slice(0, 300)}` }, 502); }

    const g = creado?.expense || {};
    const salida = {
      ok: true, yaExistia: false,
      gastoId: txt(g.expense_id), referencia,
      cuenta: bancoNombre, concepto: conceptoNombre,
    };

    try {
      const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${BITACORA}&select=value`, {
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
      });
      let prev: any[] = [];
      if (r.ok) { const rows = await r.json(); if (rows?.[0]?.value) prev = JSON.parse(rows[0].value)?.registros || []; }
      const registros = [{ ts: new Date().toISOString(), actor, conceptoId, conceptoNombre, cuentaZoho, fecha, monto, referencia, proveedor, ...salida }, ...prev].slice(0, 500);
      await fetch(`${SB}/rest/v1/adm_kv`, {
        method: "POST",
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: BITACORA, value: JSON.stringify({ registros }), updated_at: new Date().toISOString() }),
      });
    } catch { /* la bitacora no debe tumbar un gasto que ya se registro */ }

    return json(salida);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
