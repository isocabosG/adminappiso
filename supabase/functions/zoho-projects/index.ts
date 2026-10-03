// Edge Function: zoho-projects
// Proxy de SOLO LECTURA a Zoho Projects (DC US). La app lo usa para leer el
// CALENDARIO de cada obra (proyectos, milestones, tareas con start_date) y de
// ahí derivar las fechas de los 5 hitos de compra para el MRP.
//
// Requiere que el refresh token de Zoho incluya los scopes de Projects:
//   ZohoProjects.portals.READ, ZohoProjects.projects.READ,
//   ZohoProjects.milestones.READ, ZohoProjects.tasks.READ
// (además de los de Books que ya tenía). Comparte el MISMO token con
// zoho-books vía la tabla adm_kv, así no se piden tokens de más.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ACCOUNTS = "https://accounts.zoho.com";
const API = "https://projectsapi.zoho.com"; // Zoho Projects, DC US
const PORTAL_DEFAULT = "812643722";          // portal innovacionsolar (se puede override por params.portal_id)

// --- Token compartido en adm_kv (mismo esquema que zoho-books) ---
type Tok = { token: string; exp: number };
let tokenCache: Tok | null = null;
let refreshing: Promise<string> | null = null;
const SB_URL = Deno.env.get("SUPABASE_URL");
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TOKEN_KEY = "zoho_access_token"; // MISMA llave que zoho-books → un solo token para todo

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
  } catch { /* seguimos con el token en memoria */ }
}

async function pedirTokenAZoho(): Promise<string> {
  const id = Deno.env.get("ZOHO_CLIENT_ID");
  const secret = Deno.env.get("ZOHO_CLIENT_SECRET");
  const refresh = Deno.env.get("ZOHO_REFRESH_TOKEN");
  if (!id || !secret || !refresh) throw new Error("Faltan secretos: ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN");
  const params = new URLSearchParams({ refresh_token: refresh, client_id: id, client_secret: secret, grant_type: "refresh_token" });
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
    if (String(j.error_description || "").toLowerCase().includes("too many")) {
      const db = await leerTokenDB();
      if (db && db.exp > Date.now() + 120_000) { tokenCache = db; return db.token; }
      await new Promise((res) => setTimeout(res, 1500 * (intento + 1)));
      continue;
    }
    break;
  }
  throw new Error("No se pudo renovar el token de Zoho: " + JSON.stringify(ultimo));
}

async function getAccessToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 120_000) return tokenCache.token;
  const db = await leerTokenDB();
  if (db && db.exp > Date.now() + 120_000) { tokenCache = db; return db.token; }
  if (refreshing) return refreshing;
  refreshing = pedirTokenAZoho().finally(() => { refreshing = null; });
  return refreshing;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action || "list_projects";
    const params = body.params || {};
    const portal = params.portal_id || Deno.env.get("ZOHO_PROJECTS_PORTAL") || PORTAL_DEFAULT;
    const { project_id, path: rawPath, ...restParams } = params;

    // Construye el path. Se usan los endpoints REST v2 (/restapi), estables y
    // documentados: proyectos, milestones y tareas con start_date/end_date.
    // 'get' es un escape hatch: la app manda un path exacto si hace falta.
    let path: string, qsParams: Record<string, unknown> = restParams;
    if (action === "list_projects") { path = `/restapi/portal/${portal}/projects/`; }
    else if (action === "get_milestones") { path = `/restapi/portal/${portal}/projects/${project_id}/milestones/`; }
    else if (action === "get_tasks") { path = `/restapi/portal/${portal}/projects/${project_id}/tasks/`; }
    else if (action === "list_portals") { path = `/restapi/portals/`; qsParams = {}; }
    else if (action === "get") { // paso directo, solo-lectura
      if (!rawPath || typeof rawPath !== "string" || !rawPath.startsWith("/")) throw new Error("Falta 'path' válido (debe iniciar con /).");
      path = rawPath;
    }
    else throw new Error("Acción no soportada: " + action);

    const token = await getAccessToken();
    // Limpia params undefined/null antes de armar el query string.
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(qsParams)) { if (v !== undefined && v !== null) clean[k] = String(v); }
    const qs = new URLSearchParams(clean);
    const url = `${API}${path}${qs.toString() ? "?" + qs : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
    const text = await r.text();
    // Zoho Projects responde JSON; lo reenviamos tal cual (con su status).
    return new Response(text, { status: r.status, headers: { ...CORS, "Content-Type": r.headers.get("content-type") || "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
