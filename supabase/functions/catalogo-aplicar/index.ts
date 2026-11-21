// Edge Function: catalogo-aplicar
//
// APLICA el catálogo de Zoho al catálogo de la app. Sin tocar a Zoho: lee dos
// blobs de adm_kv y escribe un tercero, así que no puede fallar por cuota ni
// frenarse por límite de nadie.
//
// POR QUÉ EXISTE
// Fran: «asegura que se estén actualizando en el cron de todos los días».
// `catalogo-sync` baja la foto de Zoho a las 5:00 y ahí se quedaba: dar de alta
// los artículos nuevos, adoptar costos y marcar bajas sólo pasaba cuando
// alguien se acordaba de picar el botón en Catálogo. Así se juntaron 99
// artículos sin dar de alta y 1,073 costos sin adoptar. Un dato que sólo se
// actualiza si alguien se acuerda no es un dato actualizado.
//
// LAS REGLAS SON LAS MISMAS DEL BOTÓN
// Ver `sincronizarCatalogo` en App.jsx. Correrlo a mano y correrlo de madrugada
// tienen que dar lo mismo:
//   · SKU que no está en el catálogo → se da de alta.
//   · SKU que está pero que ESTA APP nunca costeó → adopta el costo de Zoho.
//     Zoho es la fuente de verdad del costo mientras aquí no se mida.
//   · SKU que esta app SÍ costeó —trae historia, pendiente o envío previo— →
//     no se le toca el costo. Ése viaja al revés, con el botón de empujar,
//     cuando se cierra una importación.
//
// Y LA EXISTENCIA SE TRAE DE ZOHO
// El campo `existencia` del catálogo era un contador: la semilla del
// 31-jul-2026 escrita a mano en el código, más lo que cada cierre le sumaba. No
// restaba ventas, no sumaba compras nacionales y nunca le volvía a preguntar a
// Zoho — decía 82 SARK30K donde el almacén tiene 1. Desde que el costo dejó de
// ponderarse con él (`docs/costeo-importaciones.md`, sección 13), ese campo
// sólo tiene un trabajo: decir cuánto hay. Así que se lo pregunta a quien sabe,
// el inventario físico que deja `inventario-sync`.
//
// ORDEN DE LAS SINCRONÍAS: catálogo 5:00 → inventario 5:40-5:58 → esto 6:05.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY_ZOHO = "iso3-catalogo-zoho";
const KEY_CAT = "iso3-catalogo";
const KEY_FIS = "iso3-inventario-fisico";

// La misma de la app, portada tal cual: un SKU nuevo tiene que nacer con
// categoría, aunque sea aproximada, o no se puede filtrar por nada.
const adivinaCategoria = (desc = "") => {
  const d = String(desc).toLowerCase();
  if (/(inversor|inverter|sol-?ark|sol ark)/.test(d)) return "Inversor";
  if (/(panel|m[oó]dulo fotovolt|fotovoltaico)/.test(d)) return "Panel";
  if (/(bater|battery|litio|lithium|ecube|xcellent|xtreme|extreme|acumulaci[oó]n|almacenamiento)/.test(d)) return "Batería";
  return "Otro";
};

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);

  const leer = async (k: string) => {
    const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${k}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows?.[0]?.value) return null;
    try { return JSON.parse(rows[0].value); } catch { return null; }
  };

  try {
    const z = await leer(KEY_ZOHO);
    const items = z?.items || null;
    // Sin foto de Zoho no se aplica nada: mejor dejar el catálogo como está que
    // decidir con un blob a medias.
    if (!items || !Object.keys(items).length) return json({ ok: false, error: "No hay catálogo de Zoho descargado todavía." }, 409);

    const cat = await leer(KEY_CAT);
    if (!cat || typeof cat !== "object") return json({ ok: false, error: "No hay catálogo de la app que actualizar." }, 409);

    const fis = (await leer(KEY_FIS))?.items || {};
    const hayFisico = Object.keys(fis).length > 0;

    const c: Record<string, any> = { ...cat };
    const nuevosSkus: string[] = [];
    let adoptados = 0, marcados = 0, existActualizada = 0;

    for (const [skuRaw, x] of Object.entries(items as Record<string, any>)) {
      const sku = String(skuRaw).toUpperCase();
      const prev = c[sku];
      const aMano = hayFisico && fis[sku] ? Math.max(0, +fis[sku].aMano || 0) : null;

      if (!prev) {
        c[sku] = {
          descripcion: x.desc || sku,
          categoria: adivinaCategoria(x.desc || ""),
          existencia: aMano ?? 0,
          costoVigente: +x.rate || 0,
          itemId: x.itemId,
          bajaZoho: !x.activo,
        };
        nuevosSkus.push(sku);
        continue;
      }

      const upd = { ...prev };
      let cambio = false;
      if (!upd.itemId && x.itemId) { upd.itemId = x.itemId; cambio = true; }
      if (!!upd.bajaZoho !== !x.activo) { upd.bajaZoho = !x.activo; cambio = true; marcados++; }
      if (aMano != null && (+upd.existencia || 0) !== aMano) { upd.existencia = aMano; cambio = true; existActualizada++; }

      // Se mira `prev`, no `upd`: lo que importa es si la app llegó a costear
      // este SKU alguna vez, no lo que acabamos de completar.
      const loCosteoLaApp = (prev.historia?.length || 0) > 0 || prev.promedioPendiente != null || !!prev.ultimoEnvio;
      const suyo = +x.rate || 0;
      if (!loCosteoLaApp && suyo > 0 && Math.abs((+prev.costoVigente || 0) - suyo) > 0.01) {
        upd.costoVigente = suyo; cambio = true; adoptados++;
      }
      if (cambio) c[sku] = upd;
    }

    const cambios = nuevosSkus.length + adoptados + marcados + existActualizada;
    if (cambios) {
      const w = await fetch(`${SB}/rest/v1/adm_kv`, {
        method: "POST",
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: KEY_CAT, value: JSON.stringify(c), updated_at: new Date().toISOString() }),
      });
      if (!w.ok) throw new Error("No se pudo guardar el catálogo: " + (await w.text()).slice(0, 200));
    }

    return json({
      ok: true,
      fechaZoho: z?.fecha || null,
      skusEnZoho: Object.keys(items).length,
      nuevos: nuevosSkus.length,
      nuevosSkus: nuevosSkus.slice(0, 50),
      adoptados, marcados, existActualizada,
      inventarioFisico: hayFisico ? "sí" : "no — la existencia no se tocó",
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
