// Edge Function: so-limpieza
//
// Quita un SKU de varias ordenes de venta de Zoho, o lo sustituye por otro, en
// lote y con vista previa obligatoria.
//
// DE DONDE VIENE
// El 26-sep hubo que quitar NDR12024 de 15 ordenes: la fuente se dejo de usar,
// el motor de cotizacion siguio metiendo las dos, y quedaron 15 piezas
// comprometidas de algo que no hay en almacen. Se hizo pegando JavaScript en la
// consola del navegador. Salio bien, pero la red de seguridad no fue el codigo:
// fue que alguien reviso las 15 ordenes renglon por renglon antes de tocar nada.
// Esta funcion existe para que esa revision sea parte del proceso y no un favor.
//
// EL UNIVERSO SALE DE ZOHO, NO DE LA BASE LOCAL
// Armarlo con los proyectos de la app deja huecos: una obra marcada terminada
// aqui puede tener su orden abierta alla, y hay ordenes que la app no tiene
// amarradas a ningun proyecto. En IS-PMT eso daba 91 ordenes cuando Zoho tiene
// 104 o mas abiertas. Para una herramienta de limpieza, no ver una orden
// significa que el material sigue comprometido Y que crees que ya terminaste.
//
// PRIMERO MUESTRA, DESPUES ESCRIBE
// Aplicar exige el `lineId` que devolvio la vista previa. Si la orden cambio en
// Zoho mientras tanto, ese id ya no empata y la llamada se niega. Asi nunca se
// escribe sobre algo que nadie vio. Es el freno mas importante y es barato.
//
// LO QUE NO HACE, Y NO DEBE APRENDER A HACER
//   · Agregar partidas que no estaban.
//   · Tocar mas de una orden por llamada. El lote se arma en la pantalla: asi un
//     error se queda en una orden y no en ciento cuatro.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const LOTE = 12;
// Un renglon que ya se facturo, empaco o surtio NO se toca desde aqui: la app
// no sabe arreglar una factura. Eso se cancela en Zoho, a mano, por una persona.
const MOVIMIENTOS = ["quantity_invoiced", "quantity_packed", "quantity_shipped", "quantity_delivered"];

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const norm = (v: unknown) => String(v ?? "").trim().toUpperCase();
const num = (v: unknown) => Number(v || 0);

// La forma EXACTA en que Zoho quiere los renglones de vuelta.
//
// DOS TRAMPAS, LAS DOS VERIFICADAS Y LAS DOS CARAS:
// 1. Hay que mandar el arreglo COMPLETO. Los renglones que omitas se BORRAN. El
//    24-sep estuvimos a un clic de reemplazar 57 partidas comerciales por 147 de
//    ferreteria.
// 2. Hay que conservar `line_item_id`, o Zoho trata el renglon como nuevo y
//    pierde historial y ligas.
const lineasParaGuardar = (so: any) =>
  (so.line_items || []).map((l: any) => ({
    line_item_id: l.line_item_id,
    item_id: l.item_id,
    name: l.name,
    description: l.description,
    rate: l.rate,
    quantity: l.quantity,
    unit: l.unit,
    tax_id: l.tax_id,
  }));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  // Quien hace el cambio, sacado del JWT del lado servidor. Un actor que manda
  // el navegador no es una firma, es un campo que cualquiera escribe.
  let actor = "";
  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const u = await fetch(`${SB}/auth/v1/user`, { headers: { apikey: SRV, Authorization: `Bearer ${jwt}` } });
    if (u.ok) actor = String((await u.json())?.email || "");
  } catch { /* sin correo se registra vacio */ }

  const z = new Zoho(SB, SRV, ORG);

  const anota = async (fila: Record<string, unknown>) => {
    try {
      await fetch(`${SB}/rest/v1/zoho_so_log`, {
        method: "POST",
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(fila),
      });
    } catch { /* la bitacora no debe tumbar la operacion */ }
  };

  const buscarPorSku = async (sku: string) => {
    const s = String(sku || "").trim();
    if (!s) return null;
    const d = await z.get("/items", { search_text: s, per_page: "50", filter_by: "Status.All" });
    const iguales = (d.items || []).filter((i: any) => norm(i.sku) === norm(s));
    return iguales.find((i: any) => String(i.status || "").toLowerCase() === "active") || iguales[0] || null;
  };

  // Lo que la pantalla necesita saber de UNA orden. Devuelve null si el SKU no
  // aparece: las ordenes que no lo traen no ensucian la lista.
  const revisarOrden = (so: any, sku: string, itemNuevo: any) => {
    if (!so) return null;
    const lineas = so.line_items || [];
    const objetivo = lineas.filter((l: any) => norm(l.sku) === norm(sku));
    if (!objetivo.length) return null;

    const frenos: string[] = [];
    const avisos: string[] = [];

    const est = String(so.status || "").toLowerCase();
    const oest = String(so.order_status || "").toLowerCase();
    if (est === "void" || oest === "void") frenos.push("La orden está anulada en Zoho.");
    if (est === "closed" || oest === "closed") frenos.push("La orden ya está cerrada en Zoho.");
    if (objetivo.length > 1) frenos.push(`${sku} aparece ${objetivo.length} veces. No adivino cuál tocar.`);

    const l = objetivo[0];

    const movida = MOVIMIENTOS.map((k) => [k, num(l[k])] as [string, number]).filter(([, v]) => v > 0);
    if (movida.length) {
      frenos.push("Ese renglón ya tiene " + movida.map(([k, v]) => k.replace("quantity_", "") + " " + v).join(", ") +
        ". Primero se cancela la factura o el surtido, en Zoho.");
    }

    const rate = num(l.rate);
    const cant = num(l.quantity);
    // El precio va todo en el renglon comercial y el resto va en $0. Por eso un
    // renglon CON precio es justo el que nadie debe quitar sin pensarlo.
    if (rate !== 0) avisos.push(`El renglón tiene precio: $${rate.toFixed(2)} × ${cant}.`);
    if (itemNuevo && lineas.some((x: any) => norm(x.sku) === norm(itemNuevo.sku))) {
      avisos.push(`La orden YA trae ${itemNuevo.sku}: sustituir dejaría dos renglones del mismo artículo.`);
    }

    const total = l.item_total != null ? num(l.item_total) : rate * cant;
    return {
      soId: so.salesorder_id, numero: so.salesorder_number, cliente: so.customer_name,
      estado: so.status, facturada: so.invoiced_status, partidas: lineas.length,
      linea: { lineId: l.line_item_id, sku: l.sku, descripcion: l.name, cantidad: cant, unidad: l.unit, precio: rate, total },
      deltaQuitar: -total,
      deltaSustituir: 0,   // la sustitucion conserva cantidad y precio
      conPrecio: rate !== 0,
      frenos, avisos, sePuede: frenos.length === 0,
    };
  };

  try {
    const body = await req.json().catch(() => ({}));
    const accion = String(body.accion || "");

    // ── INDICE ──────────────────────────────────────────────────────────
    if (accion === "indice") {
      const vivas: any[] = [];
      for (let page = 1; page <= 20; page++) {
        const d = await z.get("/salesorders", {
          page: String(page), per_page: "200", filter_by: "Status.All", sort_column: "salesorder_number",
        });
        for (const o of (d.salesorders || [])) {
          const oe = String(o.order_status || "").toLowerCase();
          const st = String(o.status || "").toLowerCase();
          // `order_status` (open/closed) dice si sigue comprometiendo material.
          // `status` es otra cosa (open, invoiced, partially_invoiced, overdue).
          if (oe === "closed" || st === "void") continue;
          vivas.push({
            id: o.salesorder_id, numero: o.salesorder_number, cliente: o.customer_name,
            estado: o.status, facturada: o.invoiced_status,
          });
        }
        if (!d.page_context?.has_more_page) break;
      }
      return json({ ok: true, total: vivas.length, ordenes: vivas, llamadas: z.llamadas });
    }

    const sku = String(body.sku || "").trim();
    if (!sku) return json({ ok: false, error: "Falta el SKU." }, 400);

    // ── REVISAR ─────────────────────────────────────────────────────────
    if (accion === "revisar") {
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, LOTE) : [];
      const sustituto = String(body.sustituto || "").trim();
      if (!ids.length) return json({ ok: true, hallazgos: [], fallas: [] });

      let itemNuevo = null;
      if (sustituto) {
        if (norm(sustituto) === norm(sku)) return json({ ok: false, error: "El SKU nuevo es el mismo que el viejo." }, 400);
        itemNuevo = await buscarPorSku(sustituto);
        if (!itemNuevo) return json({ ok: false, error: `${sustituto} no existe en el catálogo de Zoho.` }, 400);
        if (String(itemNuevo.status || "").toLowerCase() !== "active") {
          return json({ ok: false, error: `${sustituto} está dado de baja en Zoho.` }, 400);
        }
      }

      const hallazgos: any[] = [];
      const fallas: any[] = [];
      // En serie a proposito: las peticiones en paralelo fueron lo que hizo que
      // Zoho cortara por exceso el 26-sep.
      for (const id of ids) {
        try {
          const d = await z.get(`/salesorders/${encodeURIComponent(String(id))}`);
          const r = revisarOrden(d.salesorder, sku, itemNuevo);
          if (r) hallazgos.push(r);
        } catch (e) {
          fallas.push({ soId: id, error: String((e as Error)?.message || e).slice(0, 200) });
        }
      }
      return json({
        ok: true, hallazgos, fallas,
        articuloNuevo: itemNuevo ? { sku: itemNuevo.sku, nombre: itemNuevo.name, precio: num(itemNuevo.rate), unidad: itemNuevo.unit } : null,
      });
    }

    // ── APLICAR ─────────────────────────────────────────────────────────
    if (accion === "aplicar") {
      const soId = String(body.soId || "").trim();
      const numero = String(body.numero || soId);
      const lineId = String(body.lineId || "").trim();
      const operacion = String(body.operacion || "");
      const sustituto = String(body.sustituto || "").trim();
      const aceptoPrecio = body.aceptoPrecio === true;

      if (!soId || !lineId) return json({ ok: false, error: "Faltan soId y lineId." }, 400);
      if (operacion !== "quitar" && operacion !== "sustituir") return json({ ok: false, error: 'La operación es "quitar" o "sustituir".' }, 400);
      if (operacion === "sustituir" && !sustituto) return json({ ok: false, error: "Falta el SKU sustituto." }, 400);

      try {
        const d = await z.get(`/salesorders/${encodeURIComponent(soId)}`);
        const so = d.salesorder;
        if (!so) return json({ ok: false, error: `${numero}: la orden no existe en Zoho.` }, 409);

        const est = String(so.status || "").toLowerCase();
        const oest = String(so.order_status || "").toLowerCase();
        if (est === "void" || oest === "void") return json({ ok: false, error: `${numero}: la orden está anulada en Zoho.` }, 409);
        if (est === "closed" || oest === "closed") return json({ ok: false, error: `${numero}: la orden ya está cerrada en Zoho.` }, 409);

        const lineas = so.line_items || [];

        // El renglon EXACTO que mostro la vista previa.
        const l = lineas.find((x: any) => String(x.line_item_id) === lineId);
        if (!l) return json({ ok: false, error: `${numero}: ese renglón ya no está en la orden. Alguien la cambió en Zoho — vuelve a revisar.` }, 409);
        if (norm(l.sku) !== norm(sku)) return json({ ok: false, error: `${numero}: ese renglón ahora es ${l.sku}, no ${sku}. La orden cambió — vuelve a revisar.` }, 409);
        if (lineas.filter((x: any) => norm(x.sku) === norm(sku)).length > 1) {
          return json({ ok: false, error: `${numero}: ${sku} aparece más de una vez. No adivino cuál tocar — revísalo en Zoho.` }, 409);
        }

        const movida = MOVIMIENTOS.map((k) => [k, num(l[k])] as [string, number]).filter(([, v]) => v > 0);
        if (movida.length) {
          return json({ ok: false, error: `${numero}: ese renglón ya tiene ${movida.map(([k, v]) => k.replace("quantity_", "") + " " + v).join(", ")}. No se toca desde aquí: primero se cancela la factura o el surtido, en Zoho.` }, 409);
        }

        const rateViejo = num(l.rate);
        let itemNuevo: any = null;
        if (operacion === "sustituir") {
          itemNuevo = await buscarPorSku(sustituto);
          if (!itemNuevo) return json({ ok: false, error: `${sustituto} no existe en el catálogo de Zoho.` }, 400);
          if (String(itemNuevo.status || "").toLowerCase() !== "active") return json({ ok: false, error: `${sustituto} está dado de baja en Zoho.` }, 400);
        }

        // Sustituir conserva el precio, asi que nunca mueve el monto. Quitar si:
        // se lleva lo que ese renglon valia, que aqui es $0 salvo el comercial.
        const delta = operacion === "quitar" ? -(l.item_total != null ? num(l.item_total) : rateViejo * num(l.quantity)) : 0;
        if (delta !== 0 && !aceptoPrecio) {
          return json({ ok: false, error: `${numero}: esto movería el total de la orden en $${delta.toFixed(2)} y no viene marcado. Márcalo en la lista si de verdad quieres cambiar el monto.` }, 409);
        }

        const antes = lineasParaGuardar(so);
        let despues: any[], motivo: string, detalle: any, campos: any;

        if (operacion === "quitar") {
          despues = antes.filter((x: any) => String(x.line_item_id) !== lineId);
          // Conteo antes de mandar: si la cuenta no da, no se manda nada.
          if (despues.length !== antes.length - 1) {
            return json({ ok: false, error: `${numero}: esperaba pasar de ${antes.length} a ${antes.length - 1} partidas y me dio ${despues.length}. No mandé nada.` }, 500);
          }
          motivo = `Limpieza: se quitó ${sku}. ${antes.length} → ${despues.length} partidas.`;
          detalle = { operacion, sku, quitada: { descripcion: l.name, cantidad: l.quantity, precio: rateViejo } };
          campos = { altas: 0, bajas: 1, cambios: 0 };
        } else {
          const i = antes.findIndex((x: any) => String(x.line_item_id) === lineId);
          despues = antes.slice();
          despues[i] = {
            ...despues[i],
            item_id: itemNuevo.item_id,
            name: itemNuevo.name,
            description: itemNuevo.description ?? despues[i].description,
            unit: itemNuevo.unit ?? despues[i].unit,
            // El precio NO se toca: viene del renglon, no del catalogo. Un
            // articulo de $19,000 en catalogo vale $0 en la orden, y adoptar el
            // precio de catalogo inflaria el total con dinero que nadie vendio.
            rate: despues[i].rate,
          };
          if (despues.length !== antes.length) {
            return json({ ok: false, error: `${numero}: sustituir no debe cambiar el número de partidas y pasó de ${antes.length} a ${despues.length}. No mandé nada.` }, 500);
          }
          motivo = `Sustitución: ${sku} → ${sustituto}, cantidad ${l.quantity} y precio $${rateViejo.toFixed(2)} sin cambio.`;
          detalle = { operacion, de: sku, a: sustituto, cantidad: l.quantity, precio: rateViejo };
          campos = { altas: 0, bajas: 0, cambios: 1 };
        }

        await z.put(`/salesorders/${encodeURIComponent(soId)}`, { line_items: despues });

        // Se relee de Zoho: el resultado que vale es el que quedo, no el que
        // la llamada dijo que iba a quedar.
        const v = await z.get(`/salesorders/${encodeURIComponent(soId)}`);
        const lineasFin = v.salesorder?.line_items || [];
        const sigueViejo = lineasFin.some((x: any) => norm(x.sku) === norm(sku));
        const estaNuevo = operacion === "sustituir" ? lineasFin.some((x: any) => norm(x.sku) === norm(sustituto)) : true;
        const bien = operacion === "quitar" ? !sigueViejo : (!sigueViejo && estaNuevo);

        await anota({
          zoho_so_id: soId, ov: numero, quien: actor, estado: bien ? "aplicado" : "error", ...campos, motivo,
          detalle: { ...detalle, partidas_antes: antes.length, partidas_despues: lineasFin.length },
          error: bien ? null : `${sku} sigue en la orden después de guardar.`,
        });

        return json({
          ok: bien, numero, operacion, sku, sustituto: sustituto || null,
          partidas_antes: antes.length, partidas_despues: lineasFin.length,
          renglon: { descripcion: l.name, cantidad: l.quantity },
          ...(bien ? {} : { error: "Zoho aceptó la llamada pero el renglón no quedó como debía." }),
        });
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        await anota({ zoho_so_id: soId, ov: numero, quien: actor, estado: "error", altas: 0, bajas: 0, cambios: 0, motivo: `${operacion} ${sku}`, error: msg.slice(0, 400) });
        return json({ ok: false, error: msg }, 500);
      }
    }

    return json({ ok: false, error: "Acción desconocida." }, 400);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e) }, 500);
  }
});
