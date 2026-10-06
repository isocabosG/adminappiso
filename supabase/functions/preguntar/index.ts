// Edge Function: preguntar
// ---------------------------------------------------------------------------
// El buscador con IA de la app. Recibe una pregunta en español y la contesta
// con los datos que ya sincronizan los crones de la madrugada.
//
// LA REGLA QUE DEFINE ESTE ARCHIVO:
//   El modelo NO ve los datos crudos ni hace cuentas. Solo ELIGE qué consultar.
//   Las herramientas de abajo leen los blobs, hacen la aritmética en TypeScript
//   y devuelven números ya calculados. El modelo únicamente los redacta.
//
// Por qué: con 2,307 SKU, 124 órdenes de venta abiertas y cientos de partidas,
// un modelo al que se le avienta todo el contexto contesta con fechas y montos
// que suenan bien y no existen. Una fecha inventada que alguien le promete a un
// cliente es peor que no tener buscador. Aquí el modelo no puede inventar un
// número porque nunca tiene de dónde sacarlo: o se lo dio una herramienta, o no
// lo tiene y debe decir que no lo sabe.
//
// Secretos que ya existen en Supabase (no hay que crear ninguno):
//   ANTHROPIC_API_KEY, IS_PMT_URL, MRP_FEED_TOKEN,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SB = Deno.env.get("SUPABASE_URL")!;
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODELO = Deno.env.get("PREGUNTAR_MODELO") || "claude-sonnet-5";
const VUELTAS_MAX = 6;   // tope de idas y vueltas modelo↔herramientas
const LOG_KEY = "iso3-preguntas";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

// ── Utilidades ──────────────────────────────────────────────────────────────
const up = (s: unknown) => String(s ?? "").trim().toUpperCase();
const n0 = (v: unknown) => +(v ?? 0) || 0;
const norm = (s: unknown) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const casa = (aguja: string, pajar: unknown) => norm(pajar).includes(aguja);
const mx = (v: number) => Math.round(v * 100) / 100;

// ── Lectura de los blobs ────────────────────────────────────────────────────
const LLAVES = [
  "iso3-catalogo-zoho",       // catálogo de Zoho: sku -> {itemId, desc, activo, rate}
  "iso3-inventario-fisico",   // sku -> {aMano, comprometido, disponible, cost, dispZoho}
  "iso3-mrp-oc-cache-v2",     // transito, lotes, proveedor, hist, provZoho
  "iso3-comprometido-ov",     // porSku -> {total, ovs:[{ov, proyecto, cant}]}
  "iso3-proyectos-cache",     // sos, fact, pagos, pagosSinOV
  "iso3-pagos-zoho",          // lista plana de pagos recibidos
  "iso3-bancos-zoho",         // saldos de cuentas según Zoho
  "iso3-cuentas",             // cuentas capturadas en la app
  "iso3-pedimentos",          // importaciones
  "iso3-catalogo",            // catálogo de la app: costoVigente, promedioPendiente, historia
];

async function leerBlobs(): Promise<Record<string, any>> {
  const r = await fetch(
    `${SB}/rest/v1/adm_kv?key=in.(${LLAVES.join(",")})&select=key,value,updated_at`,
    { headers: { apikey: SRV, Authorization: `Bearer ${SRV}` } },
  );
  if (!r.ok) throw new Error("No se pudieron leer los datos: " + (await r.text()).slice(0, 200));
  const filas = await r.json();
  const out: Record<string, any> = {};
  for (const f of filas) {
    try { out[f.key] = JSON.parse(f.value); } catch { out[f.key] = null; }
    if (out[f.key] && typeof out[f.key] === "object" && !Array.isArray(out[f.key])) {
      out[f.key].__updated = f.updated_at;
    }
  }
  return out;
}

// El feed de IS-PMT se pide DIRECTO, no a través de la función mrp-feed. Una
// Edge Function llamando a otra choca con el límite de función-a-función de
// Supabase, que ya nos costó tres fallas aparentemente sin relación.
async function leerPmt(): Promise<any> {
  const base = (Deno.env.get("IS_PMT_URL") || "").replace(/\/+$/, "");
  const token = Deno.env.get("MRP_FEED_TOKEN");
  if (!base || !token) return { proyectos: [], error: "IS-PMT no está configurado" };
  try {
    const r = await fetch(`${base}/api/mrp`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { proyectos: [], error: `IS-PMT respondió ${r.status}` };
    return await r.json();
  } catch (e) {
    return { proyectos: [], error: String((e as Error)?.message || e) };
  }
}

// ── El índice: una sola pasada sobre todo, misma fórmula que el MRP ─────────
type Lote = { oc: string; qty: number; eta: string | null };
type Ctx = ReturnType<typeof armar>;

function armar(d: Record<string, any>, pmt: any) {
  const cat: Record<string, any> = d["iso3-catalogo-zoho"]?.items || {};
  const inv: Record<string, any> = d["iso3-inventario-fisico"]?.items || {};
  const oc = d["iso3-mrp-oc-cache-v2"] || {};
  const comp: Record<string, any> = d["iso3-comprometido-ov"]?.porSku || {};
  const pc = d["iso3-proyectos-cache"] || {};
  const appCat: Record<string, any> = d["iso3-catalogo"] || {};

  // IS-PMT: qué obra pide qué material, y cuándo se instala.
  const obrasPorSku: Record<string, any[]> = {};
  const fechaOv: Record<string, string | null> = {};
  const proyectos: any[] = [];
  for (const p of (pmt?.proyectos || [])) {
    const ov = up(p.ov);
    if (ov) fechaOv[ov] = p.fecha_instalacion || null;
    const mats: any[] = [];
    for (const m of (p.materiales || [])) {
      const sku = up(m.sku);
      if (!sku) continue;
      const pide = n0(m.cant_disenada ?? m.qty);
      if (pide <= 0) continue;
      const entregado = n0(m.cant_entregada);
      const linea = { sku, pide, entregado, falta: Math.max(0, pide - entregado) };
      mats.push(linea);
      (obrasPorSku[sku] = obrasPorSku[sku] || []).push({
        proyecto: p.name || "(sin nombre)", ov, fechaInstalacion: p.fecha_instalacion || null, ...linea,
      });
    }
    proyectos.push({
      id: p.id, nombre: p.name || "(sin nombre)", ov,
      fechaInstalacion: p.fecha_instalacion || null, status: p.status || "",
      materiales: mats,
    });
  }

  // Cabeceras de órdenes de venta de Zoho, indexadas por número.
  const ovZoho: Record<string, any> = {};
  for (const s of (pc.sos || [])) {
    const k = up(s.salesorder_number);
    if (k) ovZoho[k] = s;
  }

  return {
    cat, inv, oc, comp, appCat, pc, obrasPorSku, fechaOv, proyectos, ovZoho,
    lotes: (oc.lotes || {}) as Record<string, Lote[]>,
    transito: (oc.transito || {}) as Record<string, number>,
    provDe: (oc.proveedor || {}) as Record<string, string>,
    pagos: d["iso3-pagos-zoho"]?.pagos || [],
    bancos: d["iso3-bancos-zoho"] || null,
    cuentas: d["iso3-cuentas"] || [],
    pedimentos: Array.isArray(d["iso3-pedimentos"]) ? d["iso3-pedimentos"] : [],
    cortes: {
      catalogo: d["iso3-catalogo-zoho"]?.fecha || null,
      inventario: d["iso3-inventario-fisico"]?.fecha || null,
      ordenesCompra: oc.fecha || null,
      transitoAlDia: oc.transitoFecha || null,
      apartados: d["iso3-comprometido-ov"]?.fecha || null,
      proyectosZoho: pc.fecha || null,
      isPmt: pmt?.generated_at || null,
      isPmtError: pmt?.error || null,
    },
  };
}

// La misma fórmula del MRP, en un solo lugar: back order + stock − apartado.
function fila(c: Ctx, sku: string) {
  const x = c.cat[sku];
  const i = c.inv[sku] || {};
  const lotes = (c.lotes[sku] || []).slice()
    .sort((a, b) => String(a.eta || "9999").localeCompare(String(b.eta || "9999")));
  const backOrder = n0(c.transito[sku]);
  const stock = n0(i.aMano);
  const porSurtir = n0(c.comp[sku]?.total);
  return {
    sku,
    descripcion: x?.desc || i.desc || sku,
    activoEnZoho: x ? x.activo !== false : null,
    enAlmacenCentral: stock,
    apartadoEnOrdenesDeVenta: porSurtir,
    enCamino: backOrder,
    lotesEnCamino: lotes.map((l) => ({ ordenCompra: l.oc, piezas: l.qty, llegadaEstimada: l.eta || "sin fecha" })),
    proximaLlegada: lotes.find((l) => l.eta)?.eta || null,
    stockFinal: backOrder + stock - porSurtir,
    costoCompraZoho: n0(x?.rate ?? i.cost),
    proveedorHabitual: c.provDe[sku] || null,
  };
}

// Estado de una pieza para una obra: la pregunta de verdad es "¿llega o no?".
function estadoParaObra(c: Ctx, sku: string, necesita: number) {
  const f = fila(c, sku);
  if (f.enAlmacenCentral >= necesita) return { estado: "en almacén", detalle: `${f.enAlmacenCentral} pza en Almacén Central` };
  if (f.enCamino > 0) {
    const l = f.lotesEnCamino.find((x) => x.llegadaEstimada !== "sin fecha") || f.lotesEnCamino[0];
    return {
      estado: l?.llegadaEstimada && l.llegadaEstimada !== "sin fecha" ? `en camino, llega ${l.llegadaEstimada}` : "en camino, sin fecha de llegada",
      detalle: `${f.enCamino} pza en ${f.lotesEnCamino.map((x) => x.ordenCompra).join(", ")}`,
    };
  }
  return { estado: "no hay y no está pedido", detalle: `${f.enAlmacenCentral} en almacén, nada en camino` };
}

// ── Las herramientas ────────────────────────────────────────────────────────
// Cada una devuelve { fuente, corte, ... }. El prompt obliga a citar esos dos
// campos, para que cualquier respuesta se pueda verificar en la pantalla que
// la sustenta.
const HERRAMIENTAS: Record<string, { esquema: any; corre: (c: Ctx, a: any) => any }> = {

  buscar: {
    esquema: {
      name: "buscar",
      description: "Punto de entrada. Busca un texto (SKU, número de orden de venta, nombre de obra o cliente, número de pedimento) y devuelve los identificadores exactos que usan las demás herramientas. Úsala SIEMPRE primero cuando el usuario menciona algo por nombre y no por clave exacta.",
      input_schema: { type: "object", properties: { texto: { type: "string", description: "Lo que el usuario mencionó" } }, required: ["texto"] },
    },
    corre: (c, a) => {
      const q = norm(a.texto);
      if (!q) return { error: "texto vacío" };
      const arts = Object.entries(c.cat)
        .filter(([sku, x]: any) => casa(q, sku) || casa(q, x.desc))
        .slice(0, 12).map(([sku, x]: any) => ({ tipo: "sku", clave: sku, nombre: x.desc, activo: x.activo !== false }));
      const ovs = Object.entries(c.ovZoho)
        .filter(([ov, s]: any) => casa(q, ov) || casa(q, s.customer_name) || casa(q, s.reference_number) || casa(q, s.company_name))
        .slice(0, 12).map(([ov, s]: any) => ({ tipo: "orden_de_venta", clave: ov, cliente: s.customer_name, fecha: s.date, estado: s.order_status }));
      const obras = c.proyectos
        .filter((p) => casa(q, p.nombre) || casa(q, p.ov))
        .slice(0, 12).map((p) => ({ tipo: "obra_is_pmt", clave: p.ov || p.nombre, nombre: p.nombre, ov: p.ov, fechaInstalacion: p.fechaInstalacion }));
      const peds = c.pedimentos
        .filter((p: any) => casa(q, p.numero) || casa(q, p.proveedorExt) || (p.partidas || []).some((x: any) => casa(q, x.desc) || casa(q, x.sku)))
        .slice(0, 8).map((p: any) => ({ tipo: "importacion", clave: p.numero || p.id, fecha: p.fecha, proveedor: p.proveedorExt, cerrado: !!p.cerrado }));
      const total = arts.length + ovs.length + obras.length + peds.length;
      return {
        fuente: "catálogo de Zoho, órdenes de venta, obras de IS-PMT y pedimentos",
        corte: c.cortes,
        encontrado: total,
        articulos: arts, ordenesDeVenta: ovs, obras, importaciones: peds,
        nota: total === 0 ? "No hay nada con ese texto. No inventes una clave: dile al usuario que no lo encontraste y pídele el número exacto." : undefined,
      };
    },
  },

  articulo: {
    esquema: {
      name: "articulo",
      description: "Todo sobre un SKU: cuánto hay en Almacén Central, cuánto está apartado en órdenes de venta, cuánto viene en camino y en qué orden de compra, con su fecha estimada de llegada, el costo y qué obras lo piden.",
      input_schema: { type: "object", properties: { sku: { type: "string", description: "SKU exacto, como lo devolvió buscar" } }, required: ["sku"] },
    },
    corre: (c, a) => {
      const sku = up(a.sku);
      if (!c.cat[sku] && !c.inv[sku]) return { error: `El SKU ${sku} no existe en el catálogo de Zoho.` };
      const f = fila(c, sku);
      const app = c.appCat[sku] || {};
      return {
        fuente: "catálogo + inventario + órdenes de compra + apartados de Zoho",
        corte: c.cortes,
        ...f,
        apartadoPorOrden: (c.comp[sku]?.ovs || []).map((o: any) => ({ ordenVenta: o.ov, proyecto: o.proyecto, piezas: o.cant })),
        loPidenEstasObras: (c.obrasPorSku[sku] || []).map((o) => ({
          obra: o.proyecto, ordenVenta: o.ov, fechaInstalacion: o.fechaInstalacion || "sin calendarizar",
          pide: o.pide, yaEntregado: o.entregado, falta: o.falta,
        })),
        costoPromedioApp: app.promedioPendiente ?? app.costoVigente ?? null,
        ultimasImportaciones: (app.historia || []).slice(-3).map((h: any) => ({
          fecha: h.fecha, pedimento: h.pedimento, piezas: h.qty, costoUnitario: mx(n0(h.unitCost)),
        })),
        comoLeerlo: "stockFinal = enCamino + enAlmacenCentral − apartadoEnOrdenesDeVenta. Negativo significa que falta comprar esa cantidad.",
      };
    },
  },

  orden_de_venta: {
    esquema: {
      name: "orden_de_venta",
      description: "El estado completo de una orden de venta (OV/SO): cliente, fecha de instalación, y renglón por renglón qué material está en almacén, cuál viene en camino y con qué fecha, y cuál falta comprar. También trae lo facturado y lo cobrado. Es la herramienta para '¿cuándo llega X de la obra Y?'.",
      input_schema: { type: "object", properties: { ov: { type: "string", description: "Número de orden de venta, ej. SO-01090" }, filtroMaterial: { type: "string", description: "Opcional: para acotar a un material, ej. 'generador'" } }, required: ["ov"] },
    },
    corre: (c, a) => {
      const ov = up(a.ov).replace(/\s+/g, "");
      const cab = c.ovZoho[ov] || Object.entries(c.ovZoho).find(([k]) => k.replace(/\D/g, "") === ov.replace(/\D/g, ""))?.[1];
      const obra = c.proyectos.find((p) => up(p.ov) === ov);
      // Apartado en Zoho: hay que recorrer los SKU porque el índice va por SKU.
      const apartado: Record<string, number> = {};
      for (const [sku, e] of Object.entries(c.comp)) {
        for (const o of ((e as any).ovs || [])) if (up(o.ov) === ov) apartado[sku] = (apartado[sku] || 0) + n0(o.cant);
      }
      const pide: Record<string, any> = {};
      for (const m of (obra?.materiales || [])) pide[m.sku] = m;
      const skus = [...new Set([...Object.keys(apartado), ...Object.keys(pide)])];
      if (!skus.length && !cab) return { error: `No encontré la orden de venta ${a.ov}. Pide el número exacto; no lo adivines.` };
      const q = norm(a.filtroMaterial || "");
      const lineas = skus
        .map((sku) => {
          const f = fila(c, sku);
          const nec = Math.max(pide[sku]?.falta ?? 0, apartado[sku] || 0);
          return {
            sku, descripcion: f.descripcion,
            apartadoEnZoho: apartado[sku] || 0,
            pideLaObra: pide[sku]?.pide ?? 0,
            yaEntregado: pide[sku]?.entregado ?? 0,
            falta: pide[sku]?.falta ?? 0,
            ...estadoParaObra(c, sku, nec || 1),
            enAlmacen: f.enAlmacenCentral, enCamino: f.enCamino,
            lotes: f.lotesEnCamino,
            alerta: (pide[sku]?.pide ?? 0) > 0 && !(apartado[sku] > 0)
              ? "La obra lo pide y no está apartado en la orden de venta" : undefined,
          };
        })
        .filter((l) => !q || casa(q, l.sku) || casa(q, l.descripcion))
        .sort((x, y) => x.descripcion.localeCompare(y.descripcion, "es"))
        .slice(0, 40);
      const fact = c.pc.fact?.[ov];
      const pag = c.pc.pagos?.[ov];
      return {
        fuente: "apartados de Zoho + lista de materiales de IS-PMT + órdenes de compra",
        corte: c.cortes,
        ordenVenta: ov,
        cliente: cab?.customer_name || null,
        obra: obra?.nombre || cab?.reference_number || null,
        fechaInstalacion: obra?.fechaInstalacion || c.fechaOv[ov] || "sin calendarizar",
        estadoZoho: cab?.order_status || null,
        materiales: lineas,
        materialesOmitidos: Math.max(0, skus.length - lineas.length),
        facturado: fact ? Object.fromEntries(Object.entries(fact).filter(([k]) => k === "MXN" || k === "USD")) : null,
        cobrado: pag ? { MXN: mx(n0(pag.MXN)), USD: mx(n0(pag.USD)), pagos: pag.n } : null,
        facturaMasViejaConSaldo: fact?.fdoc || null,
      };
    },
  },

  obra: {
    esquema: {
      name: "obra",
      description: "Una obra de IS-PMT por nombre: su fecha de instalación, su orden de venta y el avance de material (qué falta entregar y si ese faltante existe o hay que comprarlo).",
      input_schema: { type: "object", properties: { nombre: { type: "string" } }, required: ["nombre"] },
    },
    corre: (c, a) => {
      const q = norm(a.nombre);
      const p = c.proyectos.find((x) => norm(x.nombre) === q) || c.proyectos.find((x) => casa(q, x.nombre) || casa(q, x.ov));
      if (!p) return { error: `No encontré una obra que se llame "${a.nombre}" en IS-PMT.`, obrasDisponibles: c.proyectos.slice(0, 15).map((x) => x.nombre) };
      const mats = p.materiales.map((m: any) => {
        const f = fila(c, m.sku);
        return {
          sku: m.sku, descripcion: f.descripcion, pide: m.pide, entregado: m.entregado, falta: m.falta,
          ...(m.falta > 0 ? estadoParaObra(c, m.sku, m.falta) : { estado: "entregado completo", detalle: "" }),
        };
      }).sort((x: any, y: any) => y.falta - x.falta).slice(0, 40);
      return {
        fuente: "IS-PMT + inventario y órdenes de compra de Zoho",
        corte: c.cortes,
        obra: p.nombre, ordenVenta: p.ov || null, fechaInstalacion: p.fechaInstalacion || "sin calendarizar",
        status: p.status,
        renglones: p.materiales.length,
        conFaltante: p.materiales.filter((m: any) => m.falta > 0).length,
        materiales: mats,
      };
    },
  },

  ordenes_de_compra: {
    esquema: {
      name: "ordenes_de_compra",
      description: "Qué viene en camino: órdenes de compra abiertas con su fecha estimada de llegada y qué material trae cada una. Sin filtro devuelve las próximas por llegar.",
      input_schema: { type: "object", properties: { texto: { type: "string", description: "Opcional: número de OC, SKU o descripción" } } },
    },
    corre: (c, a) => {
      const q = norm(a.texto || "");
      const porOc: Record<string, any> = {};
      for (const [sku, ls] of Object.entries(c.lotes)) {
        for (const l of (ls || [])) {
          if (q && !(casa(q, l.oc) || casa(q, sku) || casa(q, c.cat[sku]?.desc))) continue;
          const e = (porOc[l.oc] = porOc[l.oc] || { ordenCompra: l.oc, llegadaEstimada: l.eta || "sin fecha", material: [] });
          e.material.push({ sku, descripcion: c.cat[sku]?.desc || sku, piezas: l.qty });
          if (l.eta && (e.llegadaEstimada === "sin fecha" || l.eta < e.llegadaEstimada)) e.llegadaEstimada = l.eta;
        }
      }
      const lista = Object.values(porOc)
        .sort((x: any, y: any) => String(x.llegadaEstimada).localeCompare(String(y.llegadaEstimada))).slice(0, 25);

      // QUE OC ALCANZA ESTA FUENTE, no solo de que fecha es.
      //
      // El 5-oct Jesus pregunto por la PO-02015 y la PO-02055 y la barra
      // contesto que no existian, con tres hipotesis inventadas: que estarian
      // cerradas, que el numero seria de otro sistema, o que habria un error de
      // captura. Ninguna era cierta. La verdad era que el cache iba de la
      // PO-02711 a la PO-02933 y esos numeros quedaban ~700 ordenes atras.
      //
      // "No lo encuentro" y "no existe" no son lo mismo, y confundirlos le
      // quita a compras la razon para creerle a la app. Si el numero que
      // preguntan cae fuera del rango, se dice el rango.
      const todosLosNumeros: string[] = [];
      for (const ls of Object.values(c.lotes)) {
        for (const l of (ls || [])) if (l.oc) todosLosNumeros.push(String(l.oc));
      }
      const alcance = todosLosNumeros.length
        ? { deLaOrden: todosLosNumeros.reduce((a2, b) => (b < a2 ? b : a2)),
            aLaOrden: todosLosNumeros.reduce((a2, b) => (b > a2 ? b : a2)),
            ordenesAbiertas: new Set(todosLosNumeros).size }
        : null;

      // Preguntaron por un numero de OC concreto y no salio en el rango.
      const pidioOc = /^\s*(po[- ]?)?\d{3,6}\s*$/i.test(a.texto || "");
      const fuera = pidioOc && !lista.length && alcance;

      return {
        fuente: "órdenes de compra abiertas de Zoho",
        corte: c.cortes,
        alcanceDeEstaFuente: alcance,
        advertencia: c.cortes.transitoAlDia && c.cortes.transitoAlDia !== c.cortes.ordenesCompra
          ? `El tránsito es del ${c.cortes.transitoAlDia}: la última sincronía no pudo leer todas las OC y se conservó el dato anterior.` : undefined,
        sinResultado: fuera
          ? `No la tengo: esta fuente solo cubre de la ${alcance!.deLaOrden} a la ${alcance!.aLaOrden}. Que no aparezca aquí NO significa que no exista en Zoho — significa que está fuera de lo que esta fuente alcanza. No inventes explicaciones: dilo así.`
          : undefined,
        ordenes: lista,
      };
    },
  },

  que_falta_comprar: {
    esquema: {
      name: "que_falta_comprar",
      description: "Los artículos cuyo stock final sale negativo: lo apartado en órdenes de venta supera lo que hay más lo que viene en camino. Es la lista de compra del MRP.",
      input_schema: { type: "object", properties: { soloObrasCalendarizadas: { type: "boolean", description: "true = solo material de obras de IS-PMT con fecha de instalación" } } },
    },
    corre: (c, a) => {
      const filas = Object.keys(c.cat).map((s) => fila(c, s))
        .filter((f) => f.stockFinal < 0)
        .filter((f) => !a.soloObrasCalendarizadas || (c.obrasPorSku[f.sku] || []).some((o) => !!o.fechaInstalacion))
        .sort((x, y) => x.stockFinal - y.stockFinal);
      return {
        fuente: "MRP: catálogo + inventario + órdenes de compra + apartados",
        corte: c.cortes,
        articulosConFaltante: filas.length,
        piezasFaltantes: filas.reduce((a2, f) => a2 + Math.abs(f.stockFinal), 0),
        lista: filas.slice(0, 30).map((f) => ({
          sku: f.sku, descripcion: f.descripcion, faltan: Math.abs(f.stockFinal),
          enAlmacen: f.enAlmacenCentral, apartado: f.apartadoEnOrdenesDeVenta, enCamino: f.enCamino,
          proveedorHabitual: f.proveedorHabitual,
          obras: (c.obrasPorSku[f.sku] || []).map((o) => o.proyecto).slice(0, 4),
        })),
      };
    },
  },
};

// ── Dinero e importaciones ──────────────────────────────────────────────────
HERRAMIENTAS.dinero = {
  esquema: {
    name: "dinero",
    description: "Tesorería y cobranza. modo='saldos' da el saldo de cada cuenta bancaria; modo='cobranza' da lo facturado, cobrado y por cobrar por obra, con la antigüedad de la factura más vieja; modo='pagos' da los pagos recibidos más recientes.",
    input_schema: {
      type: "object",
      properties: {
        modo: { type: "string", enum: ["saldos", "cobranza", "pagos"] },
        texto: { type: "string", description: "Opcional: obra, cliente u orden de venta para acotar" },
      },
      required: ["modo"],
    },
  },
  corre: (c, a) => {
    const q = norm(a.texto || "");
    if (a.modo === "saldos") {
      const deZoho = (c.bancos?.cuentas || []).map((b: any) => ({
        cuenta: b.nombre || b.name, moneda: b.moneda || b.currency_code, saldo: mx(n0(b.saldo ?? b.balance)), fuente: "Zoho",
      }));
      const deApp = (c.cuentas || []).map((x: any) => ({ cuenta: x.nombre, moneda: x.moneda, saldo: mx(n0(x.saldo)), fuente: "capturado en la app" }));
      return {
        fuente: deZoho.length ? "saldos de Zoho Books" : "saldos capturados a mano en la app",
        corte: { ...c.cortes, saldosZoho: c.bancos?.fecha || null },
        cuentas: deZoho.length ? deZoho : deApp,
        advertencia: deZoho.length
          ? "Son los saldos que reporta Zoho. No hay feeds bancarios conectados, así que dependen de cuándo se concilió por última vez."
          : "Estos saldos se capturaron a mano en la app; no vienen de Zoho ni del banco.",
      };
    }
    if (a.modo === "pagos") {
      const lista = (c.pagos || [])
        .filter((p: any) => !q || casa(q, p.cliente) || casa(q, p.ov) || casa(q, p.num))
        .sort((x: any, y: any) => String(y.fecha).localeCompare(String(x.fecha))).slice(0, 20);
      return { fuente: "pagos recibidos en Zoho Books", corte: c.cortes, pagos: lista };
    }
    // cobranza
    const fact = c.pc.fact || {};
    const pagos = c.pc.pagos || {};
    const filas = Object.entries(fact).map(([ov, f]: any) => {
      const cab = c.ovZoho[ov];
      const pg = pagos[ov] || {};
      const por = (cur: string) => mx(n0(f?.[cur]?.b));
      return {
        ordenVenta: ov, cliente: cab?.customer_name || null,
        facturadoMXN: mx(n0(f?.MXN?.t)), facturadoUSD: mx(n0(f?.USD?.t)),
        porCobrarMXN: por("MXN"), porCobrarUSD: por("USD"),
        cobradoMXN: mx(n0(pg.MXN)), cobradoUSD: mx(n0(pg.USD)),
        facturaMasViejaConSaldo: f?.fdoc || null, vencimientoMasViejo: f?.venc || null,
      };
    })
      .filter((r) => !q || casa(q, r.ordenVenta) || casa(q, r.cliente))
      .filter((r) => r.porCobrarMXN > 0.5 || r.porCobrarUSD > 0.5 || q)
      .sort((x, y) => String(x.facturaMasViejaConSaldo || "9999").localeCompare(String(y.facturaMasViejaConSaldo || "9999")));
    return {
      fuente: "facturas y pagos de Zoho Books, cruzados por número de orden de venta",
      corte: c.cortes,
      obrasConSaldo: filas.length,
      totalPorCobrarMXN: mx(filas.reduce((a2, r) => a2 + r.porCobrarMXN, 0)),
      totalPorCobrarUSD: mx(filas.reduce((a2, r) => a2 + r.porCobrarUSD, 0)),
      detalle: filas.slice(0, 25),
      advertencia: (c.pc.pagosSinOV || []).length
        ? `${c.pc.pagosSinOV.length} pago(s) no se pudieron amarrar a una sola obra y NO están contados en lo cobrado.` : undefined,
      ordenadoPor: "antigüedad de la factura más vieja con saldo",
    };
  },
};

HERRAMIENTAS.importacion = {
  esquema: {
    name: "importacion",
    description: "Pedimentos e importaciones: número, fecha, tipo de cambio, proveedor, si ya está cerrado, y el costo landed por artículo que quedó de esa importación.",
    input_schema: { type: "object", properties: { texto: { type: "string", description: "Número de pedimento, proveedor, SKU o descripción. Vacío = las más recientes." } } },
  },
  corre: (c, a) => {
    const q = norm(a.texto || "");
    const peds = c.pedimentos
      .filter((p: any) => !q || casa(q, p.numero) || casa(q, p.proveedorExt) || (p.partidas || []).some((x: any) => casa(q, x.desc) || casa(q, x.sku)))
      .sort((x: any, y: any) => String(y.fecha).localeCompare(String(x.fecha))).slice(0, 6);
    // El costo landed final no vive en el pedimento: queda en la historia del
    // catálogo de la app al cerrarlo. De ahí se lee, no se recalcula.
    const costos: any[] = [];
    for (const [sku, art] of Object.entries(c.appCat)) {
      for (const h of ((art as any).historia || [])) {
        if (q && !(casa(q, h.pedimento) || casa(q, sku) || casa(q, (art as any).descripcion))) continue;
        costos.push({ sku, descripcion: (art as any).descripcion, pedimento: h.pedimento, fecha: h.fecha, piezas: h.qty, costoUnitarioLanded: mx(n0(h.unitCost)), promedioResultante: mx(n0(h.avgResult)) });
      }
    }
    return {
      fuente: "pedimentos capturados en la app y la historia de costos del catálogo",
      corte: c.cortes,
      importaciones: peds.map((p: any) => ({
        numero: p.numero, fecha: p.fecha, tipoDeCambio: p.tc, proveedor: p.proveedorExt,
        estado: p.cerrado ? "cerrada (costos finales aplicados)" : "provisional (aún no se cierra)",
        partidas: (p.partidas || []).slice(0, 20).map((x: any) => ({ sku: x.sku || null, descripcion: x.desc, cantidad: x.cantidad, fobUnitarioUSD: x.fobUnit })),
      })),
      costosLanded: costos.sort((x, y) => String(y.fecha).localeCompare(String(x.fecha))).slice(0, 20),
    };
  },
};

HERRAMIENTAS.estado_de_los_datos = {
  esquema: {
    name: "estado_de_los_datos",
    description: "Con qué fecha está cada fuente. Úsala cuando el usuario pregunte si un dato está actualizado, o cuando una sincronía se vea atrasada y convenga avisarlo.",
    input_schema: { type: "object", properties: {} },
  },
  corre: (c) => ({
    fuente: "fechas de corte de cada sincronía",
    corte: c.cortes,
    explicacion: "Los crones corren de madrugada: catálogo 5:00, órdenes de compra 5:10, apartados 5:15, IS-PMT 5:30, inventario 5:40 (hora de Los Cabos).",
  }),
};

// ── El prompt: aquí es donde se le prohíbe inventar ─────────────────────────
const SISTEMA = `Eres el buscador interno de AdminAppISO, la app de operaciones de Innovación Solar (Los Cabos). Contestas preguntas del equipo: Fran, Jesús y Constanza.

REGLAS QUE NO SE NEGOCIAN:
1. Todo número, fecha, SKU, monto o nombre que escribas tiene que venir de una herramienta que acabas de llamar en esta conversación. Si no lo tienes, di que no lo tienes. Nunca estimes, nunca redondees "más o menos", nunca completes con lo que parezca razonable.
2. Si una herramienta no encuentra algo, dilo y pide el dato exacto. No propongas una clave parecida como si fuera la buena.
2b. "No lo encuentro" NO es "no existe", y nunca los confundas. Cuando algo no aparece, la respuesta es que TU fuente no lo tiene, no que el dato no exista. Prohibido ofrecer hipótesis de por qué falta — que si ya se cerró, que si el número es de otro sistema, que si fue un error de captura. Eso es inventar con otra cara. Si la herramienta te dio "alcanceDeEstaFuente" o "sinResultado", di exactamente qué alcanza tu fuente y para ahí. Quien pregunta conoce su operación mejor que tú: si te asegura que existe, lo más probable es que tengas razón los dos y el dato esté fuera de tu alcance.
3. Cierra SIEMPRE con la fuente y la fecha de corte del dato, en una línea corta. Ejemplo: "Fuente: órdenes de compra de Zoho, corte del 27-sep."
4. Si el corte de la fuente que usaste es de hace más de dos días, o si la respuesta trae una advertencia, dilo antes de la respuesta.
5. Una fecha de llegada estimada es estimada: escríbela como "llegada estimada", nunca como una promesa. Si el usuario parece ir a comprometerla con un cliente, señálalo.
6. No hagas aritmética tú. Los totales que reportes tienen que ser campos que te devolvió una herramienta. Si hace falta una cuenta que ninguna herramienta hizo, dilo en vez de calcularla.

CÓMO TRABAJAS:
- Si el usuario menciona algo por nombre (una obra, un cliente, un equipo), llama primero a "buscar" para obtener la clave exacta, y luego la herramienta específica.
- Para "¿cuándo llega X de la obra Y?" el camino es: buscar → orden_de_venta (con filtroMaterial) u obra.
- Encadena las herramientas que necesites; no te quedes con la primera si no contestó la pregunta.

CÓMO ESCRIBES:
- Español de México, directo, como le hablarías a un colega. Sin preámbulos ni "claro, con gusto".
- Corto: la respuesta primero, en una o dos frases. El detalle después, y solo si ayuda a decidir.
- Los números con su unidad (pza, MXN, USD) y las fechas en formato 14-oct-2026.
- Si detectas algo que el equipo debería saber aunque no lo preguntó (la obra pide material que nadie apartó, una factura vencida hace meses), dilo en una línea al final.`;

// ── El ciclo: modelo → herramienta → modelo ─────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const t0 = Date.now();
  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ ok: false, error: "Falta el secreto ANTHROPIC_API_KEY en Supabase." }, 500);

    const cuerpo = await req.json().catch(() => ({}));
    const pregunta = String(cuerpo?.pregunta || "").trim();
    if (!pregunta) return json({ ok: false, error: "Escribe una pregunta." }, 400);
    if (pregunta.length > 1000) return json({ ok: false, error: "La pregunta es muy larga." }, 400);

    // Quién pregunta sale del JWT, no del navegador: un actor que manda el
    // cliente es un campo, no una firma.
    let actor = "";
    try {
      const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SRV, Authorization: `Bearer ${jwt}` } });
      if (u.ok) actor = String((await u.json())?.email || "");
    } catch { /* sin actor, la respuesta igual sale */ }

    const [blobs, pmt] = await Promise.all([leerBlobs(), leerPmt()]);
    const ctx = armar(blobs, pmt);

    const tools = Object.values(HERRAMIENTAS).map((h) => h.esquema);
    const mensajes: any[] = [
      ...(Array.isArray(cuerpo?.historial) ? cuerpo.historial.slice(-6) : []),
      { role: "user", content: pregunta },
    ];
    const pasos: any[] = [];
    let respuesta = "";

    for (let vuelta = 0; vuelta < VUELTAS_MAX; vuelta++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODELO, max_tokens: 2000, system: SISTEMA, tools,
          messages: mensajes,
        }),
      });
      const d = await r.json();
      if (!r.ok || d?.type === "error") {
        throw new Error(`La IA respondió ${r.status}: ${String(d?.error?.message || JSON.stringify(d)).slice(0, 300)}`);
      }

      mensajes.push({ role: "assistant", content: d.content });
      const usos = (d.content || []).filter((b: any) => b.type === "tool_use");
      const texto = (d.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();

      if (!usos.length) { respuesta = texto; break; }

      const resultados = usos.map((u: any) => {
        const h = HERRAMIENTAS[u.name];
        let salida: any;
        try {
          salida = h ? h.corre(ctx, u.input || {}) : { error: `Herramienta desconocida: ${u.name}` };
        } catch (e) {
          // Una herramienta que truena no puede tumbar la respuesta: se le dice
          // al modelo qué falló y que lo reporte, no que lo rellene.
          salida = { error: `La consulta falló: ${String((e as Error)?.message || e).slice(0, 200)}. Dile al usuario que ese dato no se pudo leer.` };
        }
        pasos.push({ herramienta: u.name, entrada: u.input, encontrado: salida?.error ? "error" : "ok" });
        return { type: "tool_result", tool_use_id: u.id, content: JSON.stringify(salida).slice(0, 60000) };
      });
      mensajes.push({ role: "user", content: resultados });

      if (vuelta === VUELTAS_MAX - 1) respuesta = texto || "No pude terminar de consultar los datos para esta pregunta. Intenta preguntarla más acotada.";
    }

    // Bitácora: sirve para ver qué pregunta el equipo de verdad, y para revisar
    // una respuesta que alguien reporte como equivocada.
    try {
      const prev = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${LOG_KEY}&select=value`, {
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
      }).then((x) => x.ok ? x.json() : []).then((f) => { try { return JSON.parse(f?.[0]?.value || "[]"); } catch { return []; } });
      const reg = [{ ts: new Date().toISOString(), actor, pregunta, pasos: pasos.map((p) => p.herramienta), ms: Date.now() - t0 }, ...(Array.isArray(prev) ? prev : [])].slice(0, 200);
      await fetch(`${SB}/rest/v1/adm_kv`, {
        method: "POST",
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: LOG_KEY, value: JSON.stringify(reg), updated_at: new Date().toISOString() }),
      });
    } catch { /* la bitácora nunca vale una respuesta */ }

    return json({ ok: true, respuesta, pasos, cortes: ctx.cortes, ms: Date.now() - t0 });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
