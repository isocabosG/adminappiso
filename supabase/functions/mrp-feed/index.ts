// Edge Function: mrp-feed
// Proxy de SOLO LECTURA al feed del MRP de IS-PMT (GET /api/mrp). Mantiene el
// token del lado servidor: el navegador de adminappISO llama a esta función
// (con su sesión de Supabase), y la función pega a IS-PMT con el secreto.
//
// Secretos de Supabase (Edge Function → Settings → Secrets):
//   IS_PMT_URL      base del deploy de IS-PMT, sin slash final. Ej: https://is-pmt.vercel.app
//   MRP_FEED_TOKEN  el mismo secreto configurado en IS-PMT (env MRP_FEED_TOKEN)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const base = (Deno.env.get("IS_PMT_URL") || "").replace(/\/+$/, "");
    const token = Deno.env.get("MRP_FEED_TOKEN");
    if (!base) throw new Error("Falta el secreto IS_PMT_URL (base del deploy de IS-PMT).");
    if (!token) throw new Error("Falta el secreto MRP_FEED_TOKEN.");

    const r = await fetch(`${base}/api/mrp`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await r.text();
    if (!r.ok) {
      return new Response(
        JSON.stringify({ error: `IS-PMT respondió ${r.status}: ${text.slice(0, 200)}` }),
        { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
      );
    }
    // Se reenvía tal cual el JSON del feed (ok, generated_at, proyectos[]).
    return new Response(text, { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
