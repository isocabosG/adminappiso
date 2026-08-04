// Edge Function: zoho-books
// Proxy de SOLO LECTURA a Zoho Books (org DC US). La app la llama para
// auto-buscar órdenes de compra que cuadren con cada factura.
// Credenciales OAuth guardadas como secretos de Supabase:
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Data Center US. Si algún día la org migra de DC, cambiar estos dos dominios.
const ACCOUNTS = "https://accounts.zoho.com";
const API = "https://www.zohoapis.com/books/v3";

async function getAccessToken() {
  const id = Deno.env.get("ZOHO_CLIENT_ID");
  const secret = Deno.env.get("ZOHO_CLIENT_SECRET");
  const refresh = Deno.env.get("ZOHO_REFRESH_TOKEN");
  if (!id || !secret || !refresh) {
    throw new Error("Faltan secretos: ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN");
  }
  const params = new URLSearchParams({
    refresh_token: refresh,
    client_id: id,
    client_secret: secret,
    grant_type: "refresh_token",
  });
  const r = await fetch(`${ACCOUNTS}/oauth/v2/token?${params}`, { method: "POST" });
  const j = await r.json();
  if (!j.access_token) throw new Error("No se pudo renovar el token de Zoho: " + JSON.stringify(j));
  return j.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const org = Deno.env.get("ZOHO_ORG_ID");
    if (!org) throw new Error("Falta el secreto ZOHO_ORG_ID");

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list_purchase_orders";
    const params = body.params || {};

    const token = await getAccessToken();

    const { purchaseorder_id, ...restParams } = params;
    let path, qsParams;
    if (action === "list_purchase_orders") { path = "/purchaseorders"; qsParams = params; }
    else if (action === "get_purchase_order") { path = `/purchaseorders/${purchaseorder_id}`; qsParams = restParams; } // trae line_items (SKU + cantidad)
    else if (action === "ping") { path = "/organizations"; qsParams = {}; } // prueba de conexión
    else throw new Error("Acción no soportada: " + action);

    const qs = new URLSearchParams({ organization_id: org, ...qsParams });
    const r = await fetch(`${API}${path}?${qs}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    const data = await r.json();
    return new Response(JSON.stringify(data), {
      status: r.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
