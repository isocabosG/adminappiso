// Edge Function: zoho-write
//
// La UNICA via por la que esta app puede cambiar algo en Zoho, y solo puede
// cambiar UNA cosa: el costo de compra (`purchase_rate`) de un articulo.
//
// POR QUE EXISTE
// El costo promedio ponderado se calcula aqui al cerrar una importacion. Hasta
// hoy el boton decia "enviado a Zoho" y no enviaba nada: solo movia el numero
// dentro de la app. El resultado fue que la app y Zoho se fueron separando sin
// que nadie se enterara, porque la pantalla afirmaba lo contrario.
//
// POR QUE NO ES UN PROXY GENERICO
// `zoho-books` es de solo lectura a proposito: si se filtra, lo peor que puede
// pasar es que alguien lea. Esta funcion escribe, asi que no acepta rutas ni
// cuerpos arbitrarios. Recibe una lista de (itemId, costo) y arma ella misma la
// llamada. No hay forma de pedirle que toque una factura, un pago o un cliente,
// aunque quien la llame lo intente.
//
// POR QUE INFORMA ARTICULO POR ARTICULO
// Devuelve el resultado de cada SKU por separado. La app solo marca como
// enviado lo que Zoho confirmo. Un fallo silencioso aqui vuelve a crear el
// problema que esta funcion viene a resolver.
//
// LO QUE ESTO **NO** HACE
// `purchase_rate` es el precio de compra por omision del articulo, que es el
// campo que la app ya lee. NO es la valuacion contable del inventario: esa la
// calcula Zoho con las facturas de compra reales y moverla seria un ajuste de
// inventario, con asiento contable. Eso es otra decision y no se toma aqui.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_ITEMS = 100;
const BITACORA = "iso3-zoho-escrituras";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  try {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "update_item_cost") {
      return json({ ok: false, error: "Accion no soportada. Esta funcion solo actualiza el costo de compra de articulos." }, 400);
    }

    // Quien pide el cambio, sacado del JWT del lado servidor. No se acepta del
    // navegador: un actor que manda el cliente no es una firma, es un campo.
    let actor = "";
    try {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SRV, Authorization: `Bearer ${jwt}` } });
      if (u.ok) actor = String((await u.json())?.email || "");
    } catch { /* sin correo se registra vacio, no se bloquea */ }

    const entrada = Array.isArray(body.items) ? body.items : [];
    if (!entrada.length) return json({ ok: false, error: "No se recibio ningun articulo." }, 400);
    if (entrada.length > MAX_ITEMS) return json({ ok: false, error: `Maximo ${MAX_ITEMS} articulos por llamada.` }, 400);

    const z = new Zoho(SB, SRV, ORG);
    const resultados: Array<{ sku: string; ok: boolean; costo?: number; error?: string }> = [];

    for (const it of entrada) {
      const sku = String(it?.sku || "").trim().toUpperCase();
      const itemId = String(it?.itemId || "").trim();
      const costo = Number(it?.costo);

      if (!sku) { resultados.push({ sku: "(sin sku)", ok: false, error: "Renglon sin SKU." }); continue; }
      if (!itemId) { resultados.push({ sku, ok: false, error: "Sin item_id de Zoho: sincroniza el catalogo primero." }); continue; }
      // Un costo de cero o negativo casi siempre es un calculo que salio mal, no
      // una decision. Se rechaza aqui antes de que llegue a la contabilidad.
      if (!isFinite(costo) || costo <= 0) { resultados.push({ sku, ok: false, error: `Costo invalido (${it?.costo}).` }); continue; }

      try {
        await z.put(`/items/${encodeURIComponent(itemId)}`, { purchase_rate: costo });
        resultados.push({ sku, ok: true, costo });
      } catch (e) {
        resultados.push({ sku, ok: false, error: String((e as Error)?.message || e).slice(0, 220) });
      }
    }

    const okN = resultados.filter((r) => r.ok).length;

    // Bitacora: quien, cuando y que se movio. Un cambio de costo en la
    // contabilidad sin rastro de quien lo hizo no es auditable.
    try {
      const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${BITACORA}&select=value`, {
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
      });
      let prev: any[] = [];
      if (r.ok) { const rows = await r.json(); if (rows?.[0]?.value) prev = JSON.parse(rows[0].value)?.registros || []; }
      const registros = [{ ts: new Date().toISOString(), actor, resultados }, ...prev].slice(0, 200);
      await fetch(`${SB}/rest/v1/adm_kv`, {
        method: "POST",
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: BITACORA, value: JSON.stringify({ registros }), updated_at: new Date().toISOString() }),
      });
    } catch { /* la bitacora no debe tumbar la operacion */ }

    return json({ ok: okN > 0, actualizados: okN, fallidos: resultados.length - okN, resultados });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
