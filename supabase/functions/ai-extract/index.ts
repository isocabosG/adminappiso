// Edge Function: ai-extract
// Proxy seguro a la API de Anthropic. La app la llama en vez de llamar a
// Anthropic directo, para que la API key nunca viva en el frontend.
// La key se lee del secreto ANTHROPIC_API_KEY (Supabase → Edge Functions → Secrets).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Falta ANTHROPIC_API_KEY" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // La app manda el mismo body que mandaría a Anthropic (model, max_tokens, messages)
    const body = await req.json();

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    return new Response(JSON.stringify(data), {
      status: resp.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
