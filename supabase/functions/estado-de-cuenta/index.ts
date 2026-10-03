// Edge Function: estado-de-cuenta
// ---------------------------------------------------------------------------
// La pantalla de COBRANZA (client.care). Sirve solo proyectos, facturado,
// cobrado y saldo. Nada de costos, inventario, tesorería ni importaciones.
//
// POR QUÉ NO USA SUPABASE AUTH, que es la decisión de diseño de este archivo:
//   La app principal lee `adm_kv` DIRECTO desde el navegador
//   (`supabase.from('adm_kv').select(...)` en storageShim.js) y esa tabla no
//   tiene RLS. Entonces hoy **cualquier sesión válida de este proyecto equivale
//   a acceso total**: con una línea en la consola se leen todos los blobs, y
//   con otra se escriben. Darle a cobranza una cuenta de Supabase Auth y
//   esconderle pestañas sería una cortina, no una puerta con llave.
//
//   Por eso esta persona NO tiene cuenta en este proyecto de Supabase. La
//   función se despliega con --no-verify-jwt y trae su propia autenticación:
//   contraseña verificada contra un hash PBKDF2 del lado servidor, y un token
//   de sesión firmado con HMAC. El navegador de cobranza nunca toca adm_kv.
//
// Secretos que hay que dar de alta:
//   COBRANZA_SECRET   cadena larga y aleatoria; firma los tokens de sesión.
//
// Usuarios: en adm_kv, llave `iso3-cobranza-acceso`
//   { "usuarios": [ { "email": "...", "nombre": "...", "salt": "<hex>", "hash": "<hex>" } ] }
//   El hash es PBKDF2-SHA256(clave, salt, 120000 iteraciones, 32 bytes).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SB = Deno.env.get("SUPABASE_URL")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SECRETO = Deno.env.get("COBRANZA_SECRET") || "";
const HORAS_SESION = 12;
const ITERACIONES = 120000;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const n0 = (v: unknown) => +(v ?? 0) || 0;
const mx = (v: number) => Math.round(v * 100) / 100;
const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

// Comparación en tiempo constante: comparar con === deja filtrar el hash
// carácter por carácter midiendo cuánto tarda en fallar.
function igualSeguro(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function pbkdf2(clave: string, saltHex: string) {
  const salt = new Uint8Array((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERACIONES }, base, 256);
  return hex(bits);
}

async function firmar(texto: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRETO), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(texto)));
}

async function nuevoToken(email: string) {
  const carga = btoa(JSON.stringify({ e: email, x: Date.now() + HORAS_SESION * 3600_000 }));
  return `${carga}.${await firmar(carga)}`;
}

async function leeToken(token: string): Promise<string | null> {
  const [carga, firma] = String(token || "").split(".");
  if (!carga || !firma) return null;
  if (!igualSeguro(firma, await firmar(carga))) return null;
  try {
    const { e, x } = JSON.parse(atob(carga));
    if (!e || !x || Date.now() > x) return null;
    return String(e);
  } catch { return null; }
}

async function leerBlob(key: string) {
  const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${key}&select=value`, {
    headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
  });
  if (!r.ok) return null;
  const f = await r.json();
  try { return JSON.parse(f?.[0]?.value || "null"); } catch { return null; }
}

// ── La vista de cobranza ───────────────────────────────────────────────────
// Se arma del lado servidor a partir de dos blobs y se recorta a lo que
// cobranza necesita. Lo que no se incluye aquí, no existe para esa pantalla.
//
// Nota: `iso3-proyectos-cache` no contiene ningún costo — solo totales de venta,
// facturas y pagos. Eso hace el recorte más seguro: no hay costo que filtrar.
async function armarProyectos() {
  const pc = await leerBlob("iso3-proyectos-cache");
  const manual = (await leerBlob("iso3-proyectos")) || {};
  if (!pc) return { fecha: null, proyectos: [] };

  const fact = pc.fact || {};
  const pagos = pc.pagos || {};

  const filas = (pc.sos || [])
    .filter((s: any) => String(s.order_status || "").toLowerCase() !== "draft")
    .map((s: any) => {
      const ov = String(s.salesorder_number || "").trim().toUpperCase();
      const f = fact[ov] || {};
      const p = pagos[ov] || {};
      const d = manual[s.salesorder_id] || {};
      // Contratado: lo capturado a mano manda sobre el total de la OV, igual
      // que en la pantalla de proyectos.
      const contratadoSinIva = d.contratado != null && d.contratado !== "" ? n0(d.contratado) : null;
      const pagosManual = (d.pagos || []).map((x: any) => ({
        fecha: x.fecha || "", monto: n0(x.monto), moneda: x.moneda || "MXN",
        forma: x.forma || "", cuenta: x.cuenta || "", referencia: x.ref || x.referencia || "",
        origen: "Capturado en la app",
      }));
      const pagosZoho = (p.lista || []).map((x: any) => ({
        fecha: x.fecha || "", monto: n0(x.monto), moneda: x.cur || "MXN",
        forma: x.modo || "", cuenta: x.cuenta || "", referencia: x.num || "",
        origen: "Zoho",
      }));
      return {
        ov, salesorderId: s.salesorder_id,
        proyecto: s.reference_number || "", cliente: s.customer_name || "",
        fecha: s.date || "", moneda: s.currency_code || "MXN",
        estado: s.order_status || "", estadoPago: s.paid_status || "",
        totalOV: mx(n0(s.total)),
        contratadoConIva: contratadoSinIva != null ? mx(contratadoSinIva * 1.16) : mx(n0(s.total)),
        contratadoEsManual: contratadoSinIva != null,
        facturadoMXN: mx(n0(f?.MXN?.t)), facturadoUSD: mx(n0(f?.USD?.t)),
        saldoMXN: mx(n0(f?.MXN?.b)), saldoUSD: mx(n0(f?.USD?.b)),
        cobradoMXN: mx(n0(p.MXN)), cobradoUSD: mx(n0(p.USD)),
        facturas: n0(f.n),
        facturaMasViejaConSaldo: f.fdoc || null,
        vencimientoMasViejo: f.venc || null,
        pagos: [...pagosZoho, ...pagosManual].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))),
      };
    })
    .sort((a: any, b: any) =>
      String(a.facturaMasViejaConSaldo || "9999").localeCompare(String(b.facturaMasViejaConSaldo || "9999")));

  return {
    fecha: pc.fecha || null,
    pagosSinAsignar: (pc.pagosSinOV || []).length,
    proyectos: filas,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!SECRETO) return json({ ok: false, error: "Falta el secreto COBRANZA_SECRET." }, 500);
    const body = await req.json().catch(() => ({}));
    const accion = String(body?.accion || "");

    if (accion === "entrar") {
      const email = String(body?.email || "").trim().toLowerCase();
      const clave = String(body?.clave || "");
      const acceso = (await leerBlob("iso3-cobranza-acceso")) || { usuarios: [] };
      const u = (acceso.usuarios || []).find((x: any) => String(x.email || "").toLowerCase() === email);
      // Un fallo tarda lo mismo exista o no el usuario, y lleva freno para que
      // no se pueda probar contraseña tras contraseña a toda velocidad.
      if (!u) { await dormir(600); return json({ ok: false, error: "Correo o contraseña incorrectos." }, 401); }
      const calc = await pbkdf2(clave, String(u.salt || ""));
      if (!igualSeguro(calc, String(u.hash || ""))) { await dormir(600); return json({ ok: false, error: "Correo o contraseña incorrectos." }, 401); }
      return json({ ok: true, token: await nuevoToken(email), nombre: u.nombre || email, horas: HORAS_SESION });
    }

    const email = await leeToken(body?.token);
    if (!email) return json({ ok: false, error: "Tu sesión expiró. Vuelve a entrar.", expirado: true }, 401);

    if (accion === "proyectos") return json({ ok: true, ...(await armarProyectos()) });

    return json({ ok: false, error: "Acción no válida." }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
