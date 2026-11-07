// Edge Function: borrar-zoho
//
// Borra en Zoho Books lo que la app registró allá: un gasto o un pago a
// proveedor. Existe para que borrar un movimiento en AdminAppISO no deje un
// huérfano en la contabilidad — dos libros que dicen cosas distintas son peor
// que uno incompleto.
//
// QUE PASA DE VERDAD AL BORRAR
//   · Un GASTO: el movimiento deja de existir y el saldo del banco en Zoho
//     vuelve a como estaba. No es que Zoho «abone» nada: es que ya no hay
//     cargo.
//   · Un PAGO a proveedor: además de devolver el saldo, LA FACTURA REGRESA A
//     POR PAGAR. Eso es más grave que borrar un gasto y por eso la pantalla
//     que llama aquí lo dice con todas sus letras antes de preguntar.
//
// LO QUE NO HACE
// No borra nada que no le hayan dicho exactamente qué es y con qué id. No
// acepta rutas, no borra por búsqueda, no borra en lote. Si Zoho se niega
// —una transacción conciliada no se puede borrar— se devuelve su motivo tal
// cual en vez de reportar un éxito que no ocurrió.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BITACORA = "iso3-borrados-zoho";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

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

    const tipo = txt(body.tipo);    // "gasto" | "pago"
    const id = txt(body.id);
    const porque = txt(body.porque).slice(0, 300);

    if (tipo !== "gasto" && tipo !== "pago") return json({ ok: false, error: `Tipo no soportado: ${tipo}. Solo «gasto» o «pago».` }, 400);
    if (!id) return json({ ok: false, error: "Falta el id de lo que se va a borrar." }, 400);

    const z = new Zoho(SB, SRV, ORG);
    const ruta = tipo === "gasto" ? `/expenses/${encodeURIComponent(id)}` : `/vendorpayments/${encodeURIComponent(id)}`;

    // Se lee antes de borrar, por dos razones: para dejar en la bitacora QUE se
    // borro —despues ya no hay forma de saberlo— y para contestar «ya no
    // estaba» en vez de un error feo cuando alguien lo borro desde Zoho.
    let antes: Record<string, unknown> = {};
    try {
      const d = await z.get(ruta);
      const o: any = tipo === "gasto" ? d?.expense : (d?.payment || d?.vendorpayment);
      if (o) {
        antes = tipo === "gasto"
          ? { fecha: txt(o.date), monto: Number(o.total) || 0, cuenta: txt(o.paid_through_account_name), concepto: txt(o.account_name), referencia: txt(o.reference_number) }
          : { fecha: txt(o.date), monto: Number(o.amount) || 0, numero: txt(o.payment_number), proveedor: txt(o.vendor_name), referencia: txt(o.reference_number) };
      }
    } catch (e) {
      const m = String((e as Error)?.message || e);
      if (/404|not\s*exist|no\s*se\s*encontr/i.test(m)) {
        return json({ ok: true, yaNoEstaba: true, mensaje: "En Zoho ya no existía ese registro. No había nada que borrar." });
      }
      return json({ ok: false, error: `No se pudo leer el registro antes de borrarlo, asi que no se borro: ${m.slice(0, 200)}` }, 502);
    }

    try { await z.del(ruta); }
    catch (e) {
      return json({ ok: false, error: `Zoho no dejó borrarlo: ${String((e as Error)?.message || e).slice(0, 300)}` }, 502);
    }

    const salida = { ok: true, yaNoEstaba: false, tipo, id, antes };

    try {
      const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${BITACORA}&select=value`, {
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
      });
      let prev: any[] = [];
      if (r.ok) { const rows = await r.json(); if (rows?.[0]?.value) prev = JSON.parse(rows[0].value)?.registros || []; }
      const registros = [{ ts: new Date().toISOString(), actor, porque, ...salida }, ...prev].slice(0, 500);
      await fetch(`${SB}/rest/v1/adm_kv`, {
        method: "POST",
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: BITACORA, value: JSON.stringify({ registros }), updated_at: new Date().toISOString() }),
      });
    } catch { /* la bitacora no debe tumbar un borrado que ya ocurrio */ }

    return json(salida);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
