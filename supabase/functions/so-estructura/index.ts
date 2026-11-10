// Edge Function: so-estructura
//
// DEJA UNA ORDEN CON LA ESTRUCTURA DE LA CASA: material en $0 y el precio en
// el concepto de SUMINISTRO E INSTALACION.
//
// Fran, 10-nov-2026, sobre SO-00186 REMANSO 4: «ponlo en ceros todos los
// articulos y agrega el concepto de suministro e instalacion de generador por
// los 113,050».
//
// POR QUE EXISTE
// Las ordenes heredadas de Innobyte traen el precio repartido en el MATERIAL:
// SO-00186 tiene 94 renglones con importe que suman 162,684.80 MXN --el
// generador Kohler solo son 113,050-- y ningun concepto de instalacion. Eso
// rompe todo lo que lee una orden: el contratado del año, la utilidad, el
// flujo y el KPI de materiales del cotizador, porque el material se cuenta dos
// veces (como costo y como venta).
//
// El 9-nov se intento arreglar con un AJUSTE negativo de -118,078 y quedo
// peor: la obra valuada en 51,744 MXN, menos de la mitad de lo que cuesta el
// puro generador, y un margen de -253%. Un ajuste tapa el numero; no arregla
// la estructura. Esto si la arregla.
//
// QUE HACE, EN UN SOLO PUT
//   1. Todo renglon que no sea el INST se va a `rate: 0`. La CANTIDAD no se
//      toca: el material ya salio del almacen y Zoho ya lo descontio. Bajar
//      cantidades romperia los paquetes y los envios; bajar el precio no mueve
//      una sola pieza.
//   2. El concepto INST queda con el importe pedido. Si la orden ya tenia uno
//      se le cambia el rate; si no, se agrega con el item INST del catalogo y
//      el nombre que se pida («SUMINISTRO E INSTALACION DE GENERADOR»).
//   3. Los renglones AJUSTE se van. Existian para tapar justo esto, y dejarlos
//      sumaria el parche encima del arreglo.
//
// UN SOLO PUT y no tres: Zoho reescribe la lista completa de renglones en cada
// llamada, asi que tres pasos serian tres ventanas en las que la orden queda a
// medias. Y se relee despues para verificar contra lo que de verdad quedo, no
// contra lo que contesto el PUT.
//
// EL IMPUESTO SE HEREDA, NO SE SUPONE. Mismo criterio que `so-ajuste`: se copia
// el tax_id de un renglon que ya lo traiga. Hay ordenes con el INST exento y el
// material gravado; suponer 16% las deja descuadradas.
//
// QUIEN PUEDE: profiles.puede_ajustar, leido del JWT. Es la misma mano que
// aplica ajustes, y esto pesa mas que un ajuste.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-estructura";                 // bitacora
const ITEM_INST = "4053294000002653003";       // SKU INST del catalogo
const TOLERANCIA = 1.0;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const n0 = (v: unknown) => +(v ?? 0) || 0;
const up = (s: unknown) => String(s ?? "").trim().toUpperCase();
const r2 = (n: number) => Math.round(n * 100) / 100;

const esInst = (li: any) =>
  up(li?.sku) === "INST" ||
  ((li?.line_item_type === "service" || li?.product_type === "service") &&
    /SUMINISTRO\s+E?\s*INSTALACI/i.test(String(li?.name || li?.description || "")));

const esAjuste = (li: any) => up(li?.sku) === "AJUSTE";

// Igual que en `so-ajuste`: se conserva line_item_id para que Zoho ACTUALICE el
// renglon en vez de crear otro, y todo lo que el equipo captura a mano.
const COPIAR = [
  "line_item_id", "item_id", "item_order", "name", "description", "sku", "unit",
  "discount", "tax_id", "tax_exemption_id", "tax_exemption_code", "tags",
  "item_custom_fields", "warehouse_id", "location_id", "header_id", "project_id",
  "sat_item_key_code", "unitkey_code", "product_type", "item_type", "pricebook_id",
];

const aPayload = (li: any, rate: number) => {
  const o: Record<string, unknown> = {};
  for (const k of COPIAR) {
    const v = li?.[k];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    o[k] = v;
  }
  o.quantity = n0(li?.quantity);     // NO se toca: el material ya salio
  o.rate = r2(rate);
  return o;
};

const impuestoDe = (lineas: any[]) => {
  const inst = lineas.find(esInst);
  const ref = inst || lineas.find((li: any) => li?.tax_id) || null;
  return { tax_id: ref?.tax_id || "", pct: n0(ref?.tax_percentage),
           de: inst ? "INST" : (ref ? `renglon ${up(ref.sku) || ref.name}` : "ninguno: va sin impuesto") };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  let cuerpo: any = {};
  try { cuerpo = await req.json(); } catch { /* sin cuerpo */ }
  const dryRun = cuerpo?.dryRun === true;
  const soId = String(cuerpo?.soId || "").trim();
  const importeInst = r2(n0(cuerpo?.importeInst));
  const nombreInst = String(cuerpo?.nombreInst || "SUMINISTRO E INSTALACION").trim();
  const motivo = String(cuerpo?.motivo || "").trim();

  if (!soId) return json({ ok: false, error: "Falta soId." }, 400);
  if (importeInst <= 0) return json({ ok: false, error: "El importe del concepto tiene que ser mayor que cero." }, 400);
  if (motivo.length < 5) return json({ ok: false, error: "El motivo es obligatorio: escribe por que se reestructura." }, 400);

  const auth = req.headers.get("Authorization") || "";
  let quien = { correo: "", nombre: "" };
  if (!dryRun) {
    const ru = await fetch(`${SB}/auth/v1/user`, { headers: { Authorization: auth, apikey: SRV } });
    const u = ru.ok ? await ru.json() : null;
    if (!u?.id) return json({ ok: false, error: "Sesion no valida. Vuelve a entrar a la app." }, 401);
    const rp = await fetch(`${SB}/rest/v1/profiles?id=eq.${u.id}&select=full_name,puede_ajustar,activo`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` } });
    const p = rp.ok ? (await rp.json())?.[0] : null;
    if (!p?.activo) return json({ ok: false, error: "Tu cuenta no esta activa." }, 403);
    if (!p?.puede_ajustar) return json({ ok: false, error: "No tienes permiso para reestructurar ordenes. Pideselo a Fran." }, 403);
    quien = { correo: u.email || "", nombre: p.full_name || u.email || "" };
  }

  const z = new Zoho(SB, SRV, ORG);
  const hoy = new Date(Date.now() - 7 * 3600 * 1000).toISOString().slice(0, 10);
  const firma = `${motivo} · ${hoy}${quien.nombre ? " · " + quien.nombre : ""}`;
  const salida: any = { ok: true, dryRun, soId, importeInst, nombreInst };

  try {
    const d = await z.get(`/salesorders/${soId}`);
    const so = d.salesorder;
    if (!so) throw new Error("Zoho no devolvio la orden.");
    const lineas: any[] = so.line_items || [];
    const imp = impuestoDe(lineas);
    const instPrevio = lineas.find(esInst) || null;
    const ajustes = lineas.filter(esAjuste);
    const conPrecio = lineas.filter((li) => !esInst(li) && !esAjuste(li) && n0(li.rate) > 0);

    salida.orden = {
      numero: so.salesorder_number, referencia: so.reference_number, cliente: so.customer_name,
      moneda: so.currency_code, estado: so.order_status, facturado: so.invoiced_status,
      renglones: lineas.length,
      materialConPrecio: conPrecio.length,
      sumaMaterial: r2(conPrecio.reduce((a, li) => a + n0(li.item_total), 0)),
      ajustesQueSeVan: ajustes.map((a) => ({ importe: n0(a.rate), nota: String(a.description || "").slice(0, 120) })),
      instPrevio: instPrevio ? { nombre: instPrevio.name, rate: n0(instPrevio.rate) } : null,
      impuesto: `${imp.pct}% (del ${imp.de})`,
      totalAntes: n0(so.total),
      totalEsperado: r2(importeInst * (1 + imp.pct / 100)),
    };
    // Lo que no se toca aqui y hay que ver aparte: la factura va por su cuenta.
    salida.facturas = (so.invoices || []).map((f: any) => ({ num: f.invoice_number, estado: f.status, total: f.total, saldo: f.balance }));

    if (dryRun) return json(salida);

    // ── EL PAYLOAD ────────────────────────────────────────────────────────
    // Todo lo que no es INST ni AJUSTE se va a cero, con su cantidad intacta.
    // Los AJUSTE simplemente no se incluyen: Zoho borra el renglon que no venga.
    const payload: any[] = [];
    let orden = 1;
    for (const li of lineas) {
      if (esAjuste(li)) continue;
      if (esInst(li)) continue;                       // el INST se arma aparte, al final
      payload.push({ ...aPayload(li, 0), item_order: orden++ });
    }
    payload.push(
      instPrevio
        ? { ...aPayload(instPrevio, importeInst), name: nombreInst, description: firma, item_order: orden++ }
        : {
            item_id: ITEM_INST, item_order: orden++,
            name: nombreInst, description: firma,
            quantity: 1, rate: importeInst, ...(imp.tax_id ? { tax_id: imp.tax_id } : {}),
          },
    );

    await z.put(`/salesorders/${soId}`, { customer_id: String(so.customer_id), line_items: payload });

    // Lo que importa es lo que quedo en Zoho, no lo que contesto el PUT.
    const v = await z.get(`/salesorders/${soId}`);
    const vl: any[] = v.salesorder?.line_items || [];
    const vtotal = n0(v.salesorder?.total);
    const vinst = vl.find(esInst) || null;

    const mal: string[] = [];
    if (!vinst) mal.push("no quedo el concepto de suministro e instalacion");
    else if (Math.abs(n0(vinst.rate) - importeInst) > 0.01) mal.push(`el concepto quedo en ${n0(vinst.rate)} y no en ${importeInst}`);
    if (vl.some(esAjuste)) mal.push("quedo un renglon AJUSTE");
    const conPrecioDespues = vl.filter((li) => !esInst(li) && n0(li.rate) > 0);
    if (conPrecioDespues.length) mal.push(`${conPrecioDespues.length} renglon(es) de material siguen con precio`);
    if (Math.abs(vtotal - salida.orden.totalEsperado) > TOLERANCIA) {
      mal.push(`el total quedo en ${vtotal} y se esperaba ${salida.orden.totalEsperado}`);
    }
    if (vl.length !== payload.length) mal.push(`quedaron ${vl.length} renglones y se mandaron ${payload.length}`);

    salida.resultado = {
      renglonesDespues: vl.length, totalDespues: vtotal,
      conceptoEn: vinst ? n0(vinst.rate) : null,
      materialEnCero: vl.filter((li) => !esInst(li) && n0(li.rate) === 0).length,
      problemas: mal,
    };
    salida.ok = mal.length === 0;

    // Bitacora: que quedo escrito quien reestructuro que orden y por que.
    try {
      const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${KEY}&select=value`, {
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}` } });
      const prev = r.ok ? JSON.parse((await r.json())?.[0]?.value || "[]") : [];
      prev.unshift({ fecha: new Date().toISOString(), soId, ov: so.salesorder_number,
                     importeInst, nombreInst, motivo, quien: quien.nombre,
                     totalAntes: salida.orden.totalAntes, totalDespues: vtotal,
                     ajustesBorrados: salida.orden.ajustesQueSeVan, problemas: mal });
      await fetch(`${SB}/rest/v1/adm_kv`, {
        method: "POST",
        headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: KEY, value: JSON.stringify(prev.slice(0, 200)), updated_at: new Date().toISOString() }),
      });
    } catch { /* la bitacora no detiene el trabajo */ }

    return json(salida);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), llamadas: z.llamadas }, 500);
  }
});
