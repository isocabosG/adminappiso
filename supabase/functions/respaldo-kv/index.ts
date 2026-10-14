// Edge Function: respaldo-kv
//
// Vuelca adm_kv a Supabase Storage todas las noches.
//
// POR QUE EXISTE
// Hasta el 14-oct el unico respaldo era que alguien se acordara de apretar
// "Exportar respaldo" en la pestana Mas. Nadie se acordo: el catalogo de costos
// llevaba dos semanas y media sin tocarse y no habia copia de el en ningun
// lado. Un respaldo que depende de la memoria de una persona no es un respaldo.
//
// DE QUE PROTEGE Y DE QUE NO
// Protege del riesgo real: que una escritura valida deje mal los datos. El caso
// concreto es Importar respaldo, que escribe en adm_kv -que es de TODOS- y
// podia regresar el catalogo entero a la fecha de un archivo viejo. Los
// respaldos automaticos de la base no sirven para eso: una escritura valida no
// se distingue de cualquier otra y para cuando alguien lo nota ya corrieron las
// sincronias encima.
// NO protege de perder el proyecto de Supabase, porque este volcado vive en el
// mismo Supabase. Para eso hace falta bajar el archivo de vez en cuando y
// guardarlo afuera. Eso sigue siendo manual y a proposito: automatizar una
// salida de datos de la empresa es otra decision.
//
// QUE SE GUARDA Y QUE NO
// Lista NEGRA, no lista blanca: entra todo salvo lo que aqui se nombre. Asi una
// llave nueva queda respaldada por omision, que es como debe fallar esto.
// Fuera quedan:
//   - Los caches que se reconstruyen solos de Zoho (proyectos, catalogo-zoho,
//     comprometido, pagos, inventario, oc). Respaldarlos es pagar espacio por
//     algo que una sincronia regenera.
//   - `zoho_access_token`. Es una credencial viva. Un respaldo descargable que
//     la lleve adentro es una fuga, no un respaldo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const BUCKET = "respaldos";
const DIAS_QUE_SE_GUARDAN = 90;

// Se reconstruyen de Zoho, o no deben salir nunca.
const FUERA = new Set([
  "iso3-proyectos-cache",
  "iso3-catalogo-zoho",
  "iso3-comprometido-ov",
  "iso3-pagos-zoho",
  "iso3-inventario-cache",
  "iso3-inventario-cache-v2",
  "iso3-mrp-oc-cache",
  "iso3-mrp-oc-cache-v2",
  "iso3-bancos-zoho",
  "zoho_access_token",            // credencial viva: NUNCA
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  const h = { apikey: SRV, Authorization: `Bearer ${SRV}` };

  const t0 = Date.now();
  const fecha = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);   // dia en Los Cabos

  try {
    const r = await fetch(`${SB}/rest/v1/adm_kv?select=key,value,updated_at`, { headers: h });
    if (!r.ok) return json({ ok: false, error: `No se pudo leer adm_kv (${r.status}).` }, 502);
    const filas: any[] = await r.json();

    const datos: Record<string, unknown> = {};
    const omitidas: string[] = [];
    for (const f of filas) {
      if (FUERA.has(f.key)) { omitidas.push(f.key); continue; }
      datos[f.key] = f.value;
    }
    const llaves = Object.keys(datos).sort();
    // Un volcado vacio sobrescribiria el del dia anterior con nada.
    if (!llaves.length) return json({ ok: false, error: "adm_kv no devolvio ninguna llave respaldable." }, 502);

    const texto = JSON.stringify({ _app: "AdminAppISO", _tipo: "adm_kv", _fecha: new Date().toISOString(), _llaves: llaves, datos });
    const crudo = new TextEncoder().encode(texto).length;

    // Comprimido: ~2 MB de JSON bajan a unos cientos de kB, y asi 90 dias de
    // historia no se vuelven un problema de espacio.
    const gz = new Uint8Array(await new Response(
      new Blob([texto]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer());

    const ruta = `adm_kv/${fecha}.json.gz`;
    const sube = await fetch(`${SB}/storage/v1/object/${BUCKET}/${ruta}`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/gzip", "x-upsert": "true" },
      body: gz,
    });
    if (!sube.ok) return json({ ok: false, error: `Storage rechazo el archivo (${sube.status}): ${(await sube.text()).slice(0, 200)}` }, 502);

    // Limpieza. Los nombres son YYYY-MM-DD.json.gz, asi que comparar cadenas
    // basta y no hay que pedirle metadatos a Storage.
    let borrados: string[] = [];
    try {
      const corte = new Date(Date.now() - DIAS_QUE_SE_GUARDAN * 86400000).toISOString().slice(0, 10);
      const lr = await fetch(`${SB}/storage/v1/object/list/${BUCKET}`, {
        method: "POST",
        headers: { ...h, "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "adm_kv", limit: 1000, sortBy: { column: "name", order: "asc" } }),
      });
      if (lr.ok) {
        const viejos = (await lr.json() as any[])
          .map((o) => String(o?.name || ""))
          .filter((n) => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(n) && n.slice(0, 10) < corte)
          .map((n) => `adm_kv/${n}`);
        if (viejos.length) {
          const dr = await fetch(`${SB}/storage/v1/object/${BUCKET}`, {
            method: "DELETE",
            headers: { ...h, "Content-Type": "application/json" },
            body: JSON.stringify({ prefixes: viejos }),
          });
          if (dr.ok) borrados = viejos;
        }
      }
    } catch { /* la limpieza nunca tumba el respaldo del dia */ }

    return json({
      ok: true, ruta, llaves: llaves.length, omitidas,
      bytesCrudo: crudo, bytesGz: gz.length,
      borrados: borrados.length, segundos: Math.round((Date.now() - t0) / 1000),
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
