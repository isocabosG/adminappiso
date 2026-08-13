// Edge Function: zoho-books
// Proxy de SOLO LECTURA a Zoho Books (org DC US). La app la llama para
// auto-buscar órdenes de compra que cuadren con cada factura.
// Credenciales OAuth guardadas como secretos de Supabase:
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, ZOHO_ORG_ID
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Data Center US. Si algún día la org migra de DC, cambiar estos dos dominios.
const ACCOUNTS = "https://accounts.zoho.com";
const API = "https://www.zohoapis.com/books/v3";

// Caché del access token. El token de Zoho dura ~1h; renovarlo muchas veces
// dispara el bloqueo "too many requests" de Zoho. Por eso lo guardamos en la
// tabla adm_kv (COMPARTIDO entre TODAS las instancias del Edge Function): así,
// aunque haya ráfagas de llamadas (proyectos + facturas + almacenes), el token
// se renueva ~1 vez por hora en total, no una vez por instancia.
type Tok = { token: string; exp: number };
let tokenCache: Tok | null = null;          // caché en memoria de esta instancia
let refreshing: Promise<string> | null = null;

// Supabase inyecta estas dos variables automáticamente en los Edge Functions.
const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TOKEN_KEY = "zoho_access_token";

async function leerTokenDB(): Promise<Tok | null> {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/adm_kv?key=eq.${TOKEN_KEY}&select=value`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const raw = rows?.[0]?.value;
    if (!raw) return null;
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return v?.token && v?.exp ? v as Tok : null;
  } catch { return null; }
}

async function guardarTokenDB(v: Tok) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key: TOKEN_KEY, value: JSON.stringify(v), updated_at: new Date().toISOString() }),
    });
  } catch { /* si falla el guardado seguimos con el token en memoria */ }
}

async function pedirTokenAZoho(): Promise<string> {
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
  let ultimo: unknown = null;
  for (let intento = 0; intento < 3; intento++) {
    const r = await fetch(`${ACCOUNTS}/oauth/v2/token?${params}`, { method: "POST" });
    const j = await r.json();
    if (j.access_token) {
      const durMs = (j.expires_in ? Number(j.expires_in) : 3600) * 1000;
      const v: Tok = { token: j.access_token, exp: Date.now() + durMs };
      tokenCache = v;
      await guardarTokenDB(v);
      return j.access_token;
    }
    ultimo = j;
    // Si Zoho frena por "demasiadas solicitudes", esperamos y reintentamos.
    // Entre reintentos revisamos la BD: otra instancia pudo haber renovado ya.
    if (String(j.error_description || "").toLowerCase().includes("too many")) {
      const db = await leerTokenDB();
      if (db && db.exp > Date.now() + 120_000) { tokenCache = db; return db.token; }
      await new Promise((res) => setTimeout(res, 1500 * (intento + 1)));
      continue;
    }
    break; // otro tipo de error: no tiene caso reintentar
  }
  throw new Error("No se pudo renovar el token de Zoho: " + JSON.stringify(ultimo));
}

async function getAccessToken() {
  // 1) token en memoria de esta instancia (si le queda >2 min).
  if (tokenCache && tokenCache.exp > Date.now() + 120_000) return tokenCache.token;
  // 2) token compartido en la BD (otra instancia ya lo renovó).
  const db = await leerTokenDB();
  if (db && db.exp > Date.now() + 120_000) { tokenCache = db; return db.token; }
  // 3) hay que renovarlo: una sola renovación en curso a la vez.
  if (refreshing) return refreshing;
  refreshing = pedirTokenAZoho().finally(() => { refreshing = null; });
  return refreshing;
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

    const { purchaseorder_id, salesorder_id, invoice_id, document_id, ...restParams } = params;
    let path, qsParams = params, binary = false;
    if (action === "list_purchase_orders") { path = "/purchaseorders"; }
    else if (action === "get_purchase_order") { path = `/purchaseorders/${purchaseorder_id}`; qsParams = restParams; } // trae line_items (SKU + cantidad)
    else if (action === "list_sales_orders") { path = "/salesorders"; } // proyectos
    else if (action === "get_sales_order") { path = `/salesorders/${salesorder_id}`; qsParams = restParams; } // trae line_items, payments[], invoices[], cf_proyecto
    else if (action === "list_items") { path = "/items"; } // inventario: stock_on_hand + purchase_rate por SKU
    else if (action === "list_invoices") { path = "/invoices"; } // facturas: balance real por OV (reference_number = número de OV)
    else if (action === "get_so_attachment") { path = `/salesorders/${salesorder_id}/attachment`; qsParams = document_id ? { document_id } : {}; binary = true; } // contrato/adjunto del proyecto
    else if (action === "get_so_pdf") { path = `/salesorders/${salesorder_id}`; qsParams = { accept: "pdf" }; binary = true; }        // OV en PDF
    else if (action === "get_invoice_pdf") { path = `/invoices/${invoice_id}`; qsParams = { accept: "pdf" }; binary = true; }         // factura en PDF
    else if (action === "ping") { path = "/organizations"; qsParams = {}; } // prueba de conexión
    else throw new Error("Acción no soportada: " + action);

    const qs = new URLSearchParams({ organization_id: org, ...qsParams });
    const r = await fetch(`${API}${path}?${qs}`, {
      headers: { Authorization: `Zoho-oauthtoken ${token}` },
    });
    if (binary) {
      // Zoho devuelve el archivo binario; lo mandamos en base64 para que el frontend lo abra/descargue.
      if (!r.ok) {
        const t = await r.text();
        return new Response(JSON.stringify({ error: "Zoho no devolvió el archivo (" + r.status + "): " + t.slice(0, 180) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      return new Response(JSON.stringify({ base64: encodeBase64(buf), contentType: r.headers.get("content-type") || "application/octet-stream" }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
    }
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
