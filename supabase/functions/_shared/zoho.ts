// Cliente directo de Zoho Books para las sincronías de madrugada.
//
// POR QUÉ NO PASAN POR `zoho-books`
// Las sincronías hacen cientos de llamadas seguidas. Cuando las hacían a través
// del Edge Function `zoho-books`, Supabase las frenaba con "Rate limit exceeded
// for trace ..." — ese límite es de Supabase, de una función llamando a otra, y
// no tiene nada que ver con la cuota de Zoho. Peor: el error lo lanza el `fetch`
// mismo, así que no venía en el cuerpo de la respuesta y era invisible.
//
// Aquí se le habla a Zoho directo. Las llamadas salientes a un dominio externo
// no pasan por ese límite. `zoho-books` sigue siendo el proxy del navegador —
// la app nunca ve un token — y esto es el camino de las sincronías.
//
// EL TOKEN ES EL MISMO
// Se lee y se guarda en la MISMA fila de adm_kv que usa `zoho-books`
// (`zoho_access_token`). Zoho bloquea a quien renueva de más, así que el token
// tiene que ser uno solo para toda la casa, no uno por función.

const ACCOUNTS = "https://accounts.zoho.com";
const API = "https://www.zohoapis.com/books/v3";
const TOKEN_KEY = "zoho_access_token";

type Tok = { token: string; exp: number };

export class Zoho {
  frenadas = 0;
  esperadoMs = 0;
  llamadas = 0;

  private tok: Tok | null = null;

  constructor(
    private sb: string,
    private key: string,
    private org: string,
    private esperaMaxMs = 30000,
  ) {}

  private async leerTokenDB(): Promise<Tok | null> {
    try {
      const r = await fetch(`${this.sb}/rest/v1/adm_kv?key=eq.${TOKEN_KEY}&select=value`, {
        headers: { apikey: this.key, Authorization: `Bearer ${this.key}` },
      });
      if (!r.ok) return null;
      const rows = await r.json();
      const raw = rows?.[0]?.value;
      if (!raw) return null;
      const v = typeof raw === "string" ? JSON.parse(raw) : raw;
      return v?.token && v?.exp ? v as Tok : null;
    } catch { return null; }
  }

  private async guardarTokenDB(v: Tok) {
    try {
      await fetch(`${this.sb}/rest/v1/adm_kv`, {
        method: "POST",
        headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: TOKEN_KEY, value: JSON.stringify(v), updated_at: new Date().toISOString() }),
      });
    } catch { /* si no se guarda, seguimos con el de memoria */ }
  }

  private vigente(t: Tok | null) { return !!t && t.exp > Date.now() + 120_000; }

  async token(): Promise<string> {
    if (this.vigente(this.tok)) return this.tok!.token;

    const db = await this.leerTokenDB();
    if (this.vigente(db)) { this.tok = db; return db!.token; }

    const id = Deno.env.get("ZOHO_CLIENT_ID");
    const secret = Deno.env.get("ZOHO_CLIENT_SECRET");
    const refresh = Deno.env.get("ZOHO_REFRESH_TOKEN");
    if (!id || !secret || !refresh) {
      throw new Error("Faltan secretos ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN");
    }
    const qs = new URLSearchParams({ refresh_token: refresh, client_id: id, client_secret: secret, grant_type: "refresh_token" });
    const r = await fetch(`${ACCOUNTS}/oauth/v2/token?${qs}`, { method: "POST" });
    const j = await r.json();
    if (!j.access_token) {
      // Antes de rendirse: otra instancia pudo haberlo renovado en estos segundos.
      const otra = await this.leerTokenDB();
      if (this.vigente(otra)) { this.tok = otra; return otra!.token; }
      throw new Error("No se pudo renovar el token de Zoho: " + JSON.stringify(j).slice(0, 200));
    }
    const v: Tok = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    this.tok = v;
    await this.guardarTokenDB(v);
    return v.token;
  }

  // GET a Zoho. Si Zoho frena, lee cuánto pide esperar y lo respeta.
  async get(path: string, params: Record<string, string> = {}): Promise<any> {
    for (let intento = 0; intento < 3; intento++) {
      const token = await this.token();
      const qs = new URLSearchParams({ organization_id: this.org, ...params });
      const r = await fetch(`${API}${path}?${qs}`, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      this.llamadas++;

      if (r.status === 401) {
        // Token vencido antes de tiempo: se tira el de memoria y se reintenta.
        this.tok = null;
        if (intento < 2) continue;
      }

      const txt = await r.text();
      let j: any = null;
      try { j = JSON.parse(txt); } catch { /* respuesta no-JSON */ }

      const frena = r.status === 429 || /rate limit|too many/i.test(txt);
      if (frena && intento < 2) {
        const cab = Number(r.headers.get("retry-after") || 0) * 1000;
        const enTexto = Number(txt.match(/retry after (\d+)\s*ms/i)?.[1] || 0);
        const espera = Math.min(cab || enTexto || 5000, this.esperaMaxMs);
        this.frenadas++; this.esperadoMs += espera;
        await new Promise((res) => setTimeout(res, espera));
        continue;
      }

      if (!r.ok || !j) {
        throw new Error(`Zoho ${path} (${r.status}): ${txt.slice(0, 180)}`);
      }
      return j;
    }
    throw new Error(`Zoho ${path}: sin respuesta tras 3 intentos`);
  }
}
