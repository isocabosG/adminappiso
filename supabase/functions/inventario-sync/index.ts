// Edge Function: inventario-sync
//
// Deja en `iso3-inventario-fisico` las existencias FÍSICAS de Zoho: a mano,
// comprometidas y disponible para venta. Corre de madrugada, por pg_cron, en
// vez de que se calcule cuando alguien abre la pestaña Inventario.
//
// POR QUÉ HAY QUE PEDIR ARTÍCULO POR ARTÍCULO
// Las comprometidas físicas (`actual_committed_stock`) NO vienen en la lista de
// artículos — solo pidiendo cada uno por separado.
//
// POR QUÉ NO SE PIDEN LOS 2,300
// Zoho tiene un límite de llamadas por minuto por organización, y lo comparten
// esta app, IS-PMT y los demás crons. Pedir el catálogo entero todos los días
// nos tumba a nosotros y a los demás. Pero un artículo sin existencia, sin
// comprometido y sin disponible en la contabilidad tampoco puede tener nada
// comprometido en físico: no hay nada que comprometer. Así que sólo se pregunta
// por los que se mueven. Los quietos se registran en ceros con lo que ya trae
// la lista, gratis. La respuesta dice cuántos fueron, para poder medirlo.
//
// POR QUÉ VA EN PEDAZOS
// Una Edge Function tiene un tope de tiempo por invocación. Ésta trabaja ~100
// segundos, guarda el avance y se sale. La siguiente mira dónde se quedó y
// sigue. El cron la dispara varias veces; cuando no hay pendientes, no hace nada.
//
// POR QUÉ NO PISA EL BLOB BUENO HASTA EL FINAL
// El blob de trabajo es `iso3-inventario-parcial`. El bueno sólo se escribe
// cuando el recorrido termina completo Y con pocos huecos. Si una corrida se
// corta, o si Zoho nos frenó tanto que quedaron artículos sin leer, el
// inventario que ve la app sigue siendo el de ayer — viejo pero íntegro, en vez
// de nuevo y lleno de blancos. Un blanco en un MRP se lee como "no hay".
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY_FINAL = "iso3-inventario-fisico";
const KEY_PARCIAL = "iso3-inventario-parcial";

const LIMITE_MS = 100000;     // cuánto trabaja cada invocación
const EN_PARALELO = 3;
const GAP_MS = 250;
const ESPERA_MAX_MS = 30000;  // lo más que aceptamos esperar cuando Zoho frena
const INTENTOS_MAX = 2;
const FORMATO = 2;             // sube si cambia la forma del parcial
const HUECOS_TOLERADOS = 0.02; // 2% de artículos sin leer y ya no se publica

type Pend = { sku: string; itemId: string; desc: string; activo: boolean; aMano: number; cost: number; pregunta: boolean; intentos?: number };

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const arranque = Date.now();
  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);

  let frenadas = 0, esperado = 0;

  // zoho-books espera { action, params } — todo lo específico de cada endpoint
  // (item_id incluido) viaja dentro de `params`. Y cuando Zoho dice "espérate",
  // se espera: lee los milisegundos que pide y los respeta.
  const zoho = async (action: string, params: Record<string, string>): Promise<any> => {
    for (let intento = 0; intento < 3; intento++) {
      const r = await fetch(`${SB}/functions/v1/zoho-books`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SRV}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action, params }),
      });
      const j = await r.json();
      if (!j?.error) return j;
      const msg = String(j.error);
      if (!/rate limit/i.test(msg) || intento === 2) throw new Error(`zoho-books ${action}: ${msg}`);
      const pedido = Number(msg.match(/retry after (\d+)\s*ms/i)?.[1] || 0);
      const espera = Math.min(pedido || 5000, ESPERA_MAX_MS);
      frenadas++; esperado += espera;
      await dormir(espera);
    }
    throw new Error(`zoho-books ${action}: sin respuesta`);
  };

  const leerBlob = async (key: string) => {
    const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${key}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!rows?.[0]?.value) return null;
    try { return JSON.parse(rows[0].value); } catch { return null; }
  };

  const guardarBlob = async (key: string, valor: unknown) => {
    const r = await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ key, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
    });
    if (!r.ok) throw new Error(`No se pudo guardar ${key}: ${(await r.text()).slice(0, 200)}`);
  };

  // Fecha local de Los Cabos (UTC-7): a las 5 am allá, en UTC ya es el día siguiente.
  const hoyLocal = () => new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);

  try {
    let parcial = await leerBlob(KEY_PARCIAL);

    // El cron dispara varias veces seguidas a propósito, por si el recorrido
    // necesita más de una. Las sobrantes no deben costar ni una llamada.
    if (parcial?.hecho && parcial.v === FORMATO && parcial.fecha === hoyLocal()) {
      return json({ ok: true, terminado: true, yaEstaba: true, fecha: parcial.fecha });
    }

    // ── Arranque: la lista de artículos, que sí viene paginada y barata ──────
    if (!parcial || parcial.v !== FORMATO || parcial.fecha !== hoyLocal()) {
      const pendientes: Pend[] = [];
      let page = 1, more = true, quietos = 0;
      while (more && page <= 40) {
        // Status.All a propósito: un SKU de baja que sigue en un BOM viejo
        // manda a comprar algo que ya no existe, y hay que poder distinguir
        // "no hay" de "ese código ya murió".
        const d = await zoho("list_items", { per_page: "200", page: String(page), filter_by: "Status.All" });
        for (const it of (d.items || [])) {
          const sku = String(it.sku || "").trim().toUpperCase();
          if (!sku) continue;
          const activo = String(it.status || "").toLowerCase() === "active";
          const sh = +it.stock_on_hand || 0;
          const cs = +it.committed_stock || 0;
          const as = +it.available_stock || 0;
          const aas = +it.actual_available_stock || 0;
          // Se pregunta sólo por los que se mueven. Un artículo en ceros por
          // todos lados no puede tener comprometido físico.
          const pregunta = activo && (sh !== 0 || cs !== 0 || as !== 0 || aas !== 0);
          if (!pregunta) quietos++;
          pendientes.push({
            sku, itemId: String(it.item_id),
            desc: it.name || sku,
            activo,
            aMano: Math.max(0, aas),
            cost: +it.purchase_rate || 0,
            pregunta,
          });
        }
        more = !!d.page_context?.has_more_page;
        page++;
      }
      if (!pendientes.length) throw new Error("Zoho no devolvió artículos; no se toca el inventario.");
      // Primero los que hay que preguntar: si la corrida se corta, se cortó en
      // lo que no cuesta llamadas.
      pendientes.sort((a, b) => Number(b.pregunta) - Number(a.pregunta));
      parcial = {
        v: FORMATO, fecha: hoyLocal(), i: 0, total: pendientes.length, quietos,
        porPreguntar: pendientes.filter((p) => p.pregunta).length,
        preguntados: 0, huecos: 0, lista: pendientes, items: {},
      };
      await guardarBlob(KEY_PARCIAL, parcial);
    }

    // ── El tramo de esta invocación: por tiempo, no por cuenta ──────────────
    const lista = parcial.lista as Pend[];
    let i = parcial.i as number;
    let corte: string | null = null;

    while (i < lista.length) {
      if (Date.now() - arranque > LIMITE_MS) { corte = "tiempo"; break; }
      const grupo = lista.slice(i, Math.min(i + EN_PARALELO, lista.length));
      await Promise.all(grupo.map(async (x) => {
        // Un artículo de baja, o uno en ceros por todos lados, se registra con
        // lo que ya trae la lista y se ahorra la llamada.
        if (!x.pregunta) {
          parcial.items[x.sku] = { itemId: x.itemId, desc: x.desc, activo: x.activo, aMano: x.aMano, comprometido: 0, disponible: x.aMano, cost: x.cost };
          return;
        }
        try {
          const d = await zoho("get_item", { item_id: x.itemId });
          const it = d.item || {};
          const comp = Math.max(0, +it.actual_committed_stock || 0);
          // El disponible NO se aplasta a cero: un negativo significa que hay
          // más comprometido que existencia, y esa es justo la señal que
          // interesa. Taparla convierte un problema en un cero tranquilo.
          const disp = it.actual_available_for_sale_stock != null
            ? +it.actual_available_for_sale_stock
            : (x.aMano - comp);
          parcial.items[x.sku] = { itemId: x.itemId, desc: x.desc, activo: true, aMano: x.aMano, comprometido: comp, disponible: disp, cost: x.cost };
          parcial.preguntados = (parcial.preguntados || 0) + 1;
        } catch {
          // Un fallo casi siempre es el límite de Zoho, no un artículo roto.
          // Se manda al final de la fila para reintentarlo; sólo si vuelve a
          // fallar se acepta como hueco, y los huecos cuentan para decidir si
          // este inventario se puede publicar o no.
          const intentos = (x.intentos || 0) + 1;
          if (intentos <= INTENTOS_MAX) {
            lista.push({ ...x, intentos });
          } else {
            parcial.items[x.sku] = { itemId: x.itemId, desc: x.desc, activo: x.activo, aMano: x.aMano, comprometido: null, disponible: null, cost: x.cost };
            parcial.huecos = (parcial.huecos || 0) + 1;
          }
        }
      }));
      i += grupo.length;
      if (grupo.some((g) => g.pregunta)) await dormir(GAP_MS);
    }

    parcial.i = i;
    parcial.lista = lista;

    // ── ¿Terminamos? ────────────────────────────────────────────────────────
    if (i >= lista.length) {
      const listos = Object.keys(parcial.items).length;
      const huecos = parcial.huecos || 0;
      if (!listos) throw new Error("Recorrido vacío; no se toca el inventario bueno.");

      if (huecos / listos > HUECOS_TOLERADOS) {
        // Demasiados blancos. Se deja el inventario de ayer y se avisa: mañana
        // vuelve a intentar desde cero. Publicar esto sería peor que no publicar.
        await guardarBlob(KEY_PARCIAL, { v: FORMATO, fecha: hoyLocal(), hecho: true, i: 0, total: 0, lista: [], items: {} });
        return json({
          ok: false, terminado: true, publicado: false,
          error: `${huecos} de ${listos} artículos quedaron sin leer (${(100 * huecos / listos).toFixed(1)}%). Se conserva el inventario anterior.`,
          frenadas, esperadoSeg: Math.round(esperado / 1000),
        }, 200);
      }

      await guardarBlob(KEY_FINAL, { fecha: parcial.fecha, items: parcial.items });
      // Se marca el día como hecho. Sin esto, la siguiente corrida del cron no
      // encontraría trabajo pendiente y volvería a empezar el recorrido entero.
      await guardarBlob(KEY_PARCIAL, { v: FORMATO, fecha: hoyLocal(), hecho: true, i: 0, total: 0, lista: [], items: {} });
      return json({
        ok: true, terminado: true, publicado: true, fecha: parcial.fecha,
        skus: listos, preguntados: parcial.preguntados || 0, quietos: parcial.quietos || 0, huecos,
        frenadas, esperadoSeg: Math.round(esperado / 1000),
      });
    }

    await guardarBlob(KEY_PARCIAL, parcial);
    return json({
      ok: true, terminado: false, corte,
      avance: `${i} de ${lista.length}`,
      preguntados: parcial.preguntados || 0, porPreguntar: parcial.porPreguntar || 0, huecos: parcial.huecos || 0,
      frenadas, esperadoSeg: Math.round(esperado / 1000),
    });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), frenadas, esperadoSeg: Math.round(esperado / 1000) }, 500);
  }
});
