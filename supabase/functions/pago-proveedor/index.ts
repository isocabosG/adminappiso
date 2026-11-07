// Edge Function: pago-proveedor
//
// Registra en Zoho Books el PAGO de una o varias facturas de proveedor y, con
// eso, las deja en pagadas. Es la primera vez que esta app mueve dinero en la
// contabilidad, asi que esta escrita para fallar antes de equivocarse.
//
// POR QUE NO ES UN PROXY GENERICO
// `zoho-books` es de solo lectura a proposito. Esta funcion escribe, asi que no
// acepta rutas ni cuerpos arbitrarios: recibe el proveedor, la cuenta, el monto
// y la lista de (factura, importe), y arma ella misma la llamada. No hay forma
// de pedirle que toque una orden de venta, un cliente o un articulo.
//
// LAS CUATRO REVISIONES ANTES DE CREAR NADA
//   1. La suma de lo aplicado tiene que dar EXACTO el monto del pago. Un peso
//      de diferencia es un dato mal leido, no un redondeo que haya que tapar.
//   2. Cada factura se lee de Zoho y se comprueba que sea DEL MISMO PROVEEDOR.
//      Empatar por folio puede traer la factura de otro —los folios se repiten
//      entre proveedores— y pagarle a quien no era no se deshace con un clic.
//   3. Lo aplicado a cada factura no puede pasar de su saldo.
//   4. Si ya existe un pago con la misma clave de rastreo, NO se crea otro: se
//      devuelve el que ya estaba. Un pago duplicado en contabilidad es peor que
//      uno no registrado, y el boton se puede picar dos veces.
//
// LO QUE ESTO **NO** HACE
// No concilia el banco ni toca el saldo de la libreta interna de la app. En
// Zoho el saldo de la cuenta baja porque el pago se registra contra ella
// (`paid_through_account_id`); en la app baja porque la operacion queda
// confirmada. Son dos libros distintos a proposito, y el dia que se junten hay
// que decidirlo, no que pase solo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BITACORA = "iso3-pagos-proveedor";
const MAX_FACTURAS = 40;
const TOLERANCIA = 0.5;   // pesos

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

    // Quien lo pide, sacado del JWT del lado servidor. Un actor que manda el
    // navegador no es una firma, es un campo que cualquiera escribe.
    let actor = "";
    try {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SRV, Authorization: `Bearer ${jwt}` } });
      if (u.ok) actor = String((await u.json())?.email || "");
    } catch { /* sin correo se registra vacio, no se bloquea */ }

    const vendorId = txt(body.vendorId);
    const cuentaZoho = txt(body.cuentaZohoId);
    const fecha = txt(body.fecha).slice(0, 10);
    const monto = num(body.monto);
    const referencia = txt(body.referencia);          // clave de rastreo del SPEI
    const moneda = txt(body.moneda) || "MXN";
    const nota = txt(body.nota).slice(0, 500);
    const facturas = Array.isArray(body.facturas) ? body.facturas : [];

    if (!vendorId) return json({ ok: false, error: "Falta el proveedor de Zoho." }, 400);
    if (!cuentaZoho) return json({ ok: false, error: "Falta la cuenta bancaria de Zoho de la que sale el pago." }, 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return json({ ok: false, error: `Fecha invalida: ${fecha}` }, 400);
    if (!(monto > 0)) return json({ ok: false, error: "El monto del pago tiene que ser mayor que cero." }, 400);
    if (!facturas.length) return json({ ok: false, error: "No se recibio ninguna factura que pagar." }, 400);
    if (facturas.length > MAX_FACTURAS) return json({ ok: false, error: `Maximo ${MAX_FACTURAS} facturas por pago.` }, 400);
    if (!referencia) return json({ ok: false, error: "Falta la referencia bancaria (clave de rastreo). Es lo que evita registrar el pago dos veces." }, 400);

    // REVISION 1 — la suma tiene que dar el monto.
    const aplicar = facturas.map((f: any) => ({ billId: txt(f?.billId), monto: num(f?.monto) }));
    if (aplicar.some((f) => !f.billId)) return json({ ok: false, error: "Hay facturas sin amarrar a Zoho. Amarra todas antes de pagar." }, 400);
    if (aplicar.some((f) => !(f.monto > 0))) return json({ ok: false, error: "Hay facturas con importe cero o negativo." }, 400);
    const suma = aplicar.reduce((a, f) => a + f.monto, 0);
    if (Math.abs(suma - monto) > TOLERANCIA) {
      return json({ ok: false, error: `Lo aplicado (${suma.toFixed(2)}) no da el monto del pago (${monto.toFixed(2)}).` }, 400);
    }

    const z = new Zoho(SB, SRV, ORG);

    // REVISION 4 — ¿ya se registro este mismo pago? Se busca por la clave de
    // rastreo del proveedor. Se hace ANTES de leer las facturas: si ya existe,
    // no hay nada que revisar.
    try {
      const ya = await z.get("/vendorpayments", { vendor_id: vendorId, reference_number: referencia, per_page: "20" });
      const hit = (ya?.vendorpayments || []).find((p: any) => txt(p.reference_number) === referencia);
      if (hit) {
        return json({
          ok: true, yaExistia: true,
          pagoId: txt(hit.payment_id), numero: txt(hit.payment_number || hit.vendor_payment_number || ""),
          mensaje: "Ese pago ya estaba registrado en Zoho con la misma clave de rastreo. No se creo otro.",
        });
      }
    } catch (e) {
      // Si la busqueda falla no se sigue a ciegas: el riesgo es duplicar.
      return json({ ok: false, error: `No se pudo comprobar si el pago ya existia, asi que no se registro: ${String((e as Error)?.message || e).slice(0, 200)}` }, 502);
    }

    // REVISIONES 2 y 3 — cada factura, leida de Zoho.
    const revisadas: Array<{ billId: string; numero: string; saldo: number; aplica: number }> = [];
    for (const f of aplicar) {
      let b: any;
      try { b = (await z.get(`/bills/${encodeURIComponent(f.billId)}`))?.bill; }
      catch (e) { return json({ ok: false, error: `No se pudo leer la factura ${f.billId}: ${String((e as Error)?.message || e).slice(0, 160)}` }, 502); }
      if (!b) return json({ ok: false, error: `Zoho no devolvio la factura ${f.billId}.` }, 502);
      if (txt(b.vendor_id) !== vendorId) {
        return json({ ok: false, error: `La factura ${txt(b.bill_number)} es de ${txt(b.vendor_name)}, no del proveedor que se esta pagando. No se registro nada.` }, 400);
      }
      const saldo = num(b.balance);
      if (f.monto - saldo > TOLERANCIA) {
        return json({ ok: false, error: `A la factura ${txt(b.bill_number)} se le quieren aplicar ${f.monto.toFixed(2)} y solo debe ${saldo.toFixed(2)}.` }, 400);
      }
      revisadas.push({ billId: f.billId, numero: txt(b.bill_number), saldo, aplica: f.monto });
    }

    // Ahora si: el pago.
    const cuerpo: Record<string, unknown> = {
      vendor_id: vendorId,
      date: fecha,
      amount: Number(monto.toFixed(2)),
      payment_mode: "banktransfer",
      paid_through_account_id: cuentaZoho,
      reference_number: referencia,
      description: nota || `Pago registrado desde AdminAppISO${actor ? ` por ${actor}` : ""}`,
      bills: revisadas.map((r) => ({ bill_id: r.billId, amount_applied: Number(r.aplica.toFixed(2)) })),
    };
    if (moneda && moneda !== "MXN" && num(body.tc) > 0) cuerpo.exchange_rate = num(body.tc);

    let creado: any;
    try { creado = await z.post("/vendorpayments", cuerpo); }
    catch (e) { return json({ ok: false, error: `Zoho rechazo el pago: ${String((e as Error)?.message || e).slice(0, 300)}` }, 502); }

    const pago = creado?.payment || creado?.vendorpayment || {};
    const salida = {
      ok: true, yaExistia: false,
      pagoId: txt(pago.payment_id),
      numero: txt(pago.payment_number || pago.vendor_payment_number || ""),
      facturas: revisadas.map((r) => ({ billId: r.billId, numero: r.numero, aplicado: r.aplica })),
    };

    // Bitacora. Un movimiento de dinero sin rastro de quien lo hizo no es
    // auditable, y esta es la unica parte del ERP que crea pagos.
    try {
      const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${BITACORA}&select=value`, {
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
      });
      let prev: any[] = [];
      if (r.ok) { const rows = await r.json(); if (rows?.[0]?.value) prev = JSON.parse(rows[0].value)?.registros || []; }
      const registros = [{ ts: new Date().toISOString(), actor, vendorId, cuentaZoho, fecha, monto, referencia, ...salida }, ...prev].slice(0, 500);
      await fetch(`${SB}/rest/v1/adm_kv`, {
        method: "POST",
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: BITACORA, value: JSON.stringify({ registros }), updated_at: new Date().toISOString() }),
      });
    } catch { /* la bitacora no debe tumbar un pago que ya se registro */ }

    return json(salida);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
