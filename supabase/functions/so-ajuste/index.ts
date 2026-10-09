// Edge Function: so-ajuste
//
// Aplica un AJUSTE POR CIERRE DE PROYECTO a una orden de venta y, si la tiene,
// a su factura. El ajuste es un RENGLON nuevo, no una edicion de los renglones
// que ya estan.
//
// POR QUE UN RENGLON Y NO EDITAR CANTIDADES
// Bajarle la cantidad a un renglon ya surtido arregla el importe y rompe el
// inventario: Zoho ya descontó esas piezas del almacen cuando salio el envio.
// Un renglon de servicio no mueve existencias, no edita nada de lo que ya hay,
// y el motivo viaja pegado al importe.
//
// POR QUE NO EL CAMPO NATIVO DE AJUSTE
// Zoho lo rechaza en Mexico, textual: "La funcion Ajuste no se admite en su
// pais. Agregue los cargos como articulo." Probado el 09-oct-2026.
//
// EL IMPUESTO SE HEREDA, NO SE SUPONE
// Los renglones van NETOS y Zoho suma el impuesto al final, renglon por renglon
// con el tax_id de cada uno. No es una tasa global sobre el subtotal: hay
// ordenes con el INST exento y material gravado (SO-00950, SO-01077). Por eso
// el ajuste copia el tax_id del INST de ESA orden. Suponer el 16% ahi deja la
// orden descuadrada, que es justo lo que paso el 08-oct.
//
// QUIEN PUEDE
// profiles.puede_ajustar, leido del JWT de quien llama. La app escondera el
// boton a quien no lo tenga, pero esconder un boton no es seguridad.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-ajustes";          // bitacora
const SKU_AJUSTE = "AJUSTE";
const ITEM_AJUSTE = "4053294000034013002";
const TOLERANCIA = 1.0;              // redondeo que se perdona al verificar

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const n0 = (v: unknown) => +(v ?? 0) || 0;
const up = (s: unknown) => String(s ?? "").trim().toUpperCase();
const r2 = (n: number) => Math.round(n * 100) / 100;

const esInst = (li: any) =>
  up(li?.sku) === "INST" ||
  ((li?.line_item_type === "service" || li?.product_type === "service") &&
    /SUMINISTRO\s+E?\s*INSTALACI/i.test(String(li?.name || li?.description || "")));

const esAjuste = (li: any) => up(li?.sku) === SKU_AJUSTE;

// Lo que se le regresa a Zoho de cada renglon. Se conserva line_item_id (asi
// Zoho ACTUALIZA el renglon en vez de crear otro) y todo lo que el equipo
// captura a mano. Lo calculado lo rehace Zoho.
const COPIAR = [
  "line_item_id", "item_id", "item_order", "name", "description", "sku", "unit",
  "discount", "tax_id", "tax_exemption_id", "tax_exemption_code", "tags",
  "item_custom_fields", "warehouse_id", "location_id", "header_id", "project_id",
  "sat_item_key_code", "unitkey_code", "product_type", "item_type", "pricebook_id",
];

const aPayload = (li: any) => {
  const o: Record<string, unknown> = {};
  for (const k of COPIAR) {
    const v = li?.[k];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    o[k] = v;
  }
  o.quantity = n0(li?.quantity);
  o.rate = n0(li?.rate);
  return o;
};

// El impuesto que le toca al ajuste: el del INST de esa orden. Si no hay INST
// (POSTVENTA y ventas de suministro), el del primer renglon que traiga uno. Si
// nadie trae, va sin impuesto.
const impuestoDe = (lineas: any[]) => {
  const inst = lineas.find(esInst);
  const ref = inst || lineas.find((li: any) => li?.tax_id) || null;
  return {
    tax_id: ref?.tax_id || "",
    pct: n0(ref?.tax_percentage),
    de: inst ? "INST" : (ref ? `renglon ${up(ref.sku) || ref.name}` : "ninguno: va sin impuesto"),
  };
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
  const importe = r2(n0(cuerpo?.importe));
  const motivo = String(cuerpo?.motivo || "").trim();
  const tambienFactura = cuerpo?.tambienFactura !== false;

  if (!soId) return json({ ok: false, error: "Falta soId." }, 400);
  if (!importe) return json({ ok: false, error: "El importe no puede ser cero." }, 400);
  if (motivo.length < 5) return json({ ok: false, error: "El motivo es obligatorio: escribe por que se ajusta." }, 400);

  // ── Quien llama ─────────────────────────────────────────────────────────
  // El token de usuario se valida contra /auth/v1/user y el permiso se lee de
  // profiles con la llave de servicio. Nada de esto viene del navegador.
  const auth = req.headers.get("Authorization") || "";
  let quien = { id: "", correo: "", nombre: "" };
  if (!dryRun) {
    const ru = await fetch(`${SB}/auth/v1/user`, { headers: { Authorization: auth, apikey: SRV } });
    const u = ru.ok ? await ru.json() : null;
    if (!u?.id) return json({ ok: false, error: "Sesion no valida. Vuelve a entrar a la app." }, 401);

    const rp = await fetch(`${SB}/rest/v1/profiles?id=eq.${u.id}&select=full_name,puede_ajustar,activo`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    const p = rp.ok ? (await rp.json())?.[0] : null;
    if (!p?.activo) return json({ ok: false, error: "Tu cuenta no esta activa." }, 403);
    if (!p?.puede_ajustar) {
      return json({ ok: false, error: "No tienes permiso para aplicar ajustes. Pideselo a Fran." }, 403);
    }
    quien = { id: u.id, correo: u.email || "", nombre: p.full_name || u.email || "" };
  }
  // dryRun calcula y NO escribe, asi que se puede correr sin sesion de usuario
  // (por ejemplo desde SQL para verificar). Escribir siempre exige usuario.

  const z = new Zoho(SB, SRV, ORG);
  const hoy = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
  const firma = `${motivo} · ${hoy}${quien.nombre ? " · " + quien.nombre : ""}`;

  const salida: any = { ok: true, dryRun, soId, importe, motivo, quien: quien.nombre || "(dryRun)" };

  try {
    // ── 1. La orden ───────────────────────────────────────────────────────
    // Se relee de Zoho a la hora de escribir. NO se usa la copia del navegador:
    // si alguien le movio algo mientras la pantalla estaba abierta, el PUT se
    // arma sobre lo que hay ahora. Zoho borra el renglon que no venga.
    const d = await z.get(`/salesorders/${soId}`);
    const so = d.salesorder;
    if (!so) throw new Error("Zoho no devolvio la orden.");
    const lineas = so.line_items || [];
    const imp = impuestoDe(lineas);
    const totalAntes = n0(so.total);
    const esperado = r2(totalAntes + importe * (1 + imp.pct / 100));

    salida.orden = {
      numero: so.salesorder_number, cliente: so.customer_name, moneda: so.currency_code,
      estado: so.order_status, renglones: lineas.length,
      impuesto: `${imp.pct}% (del ${imp.de})`,
      ajustesPrevios: lineas.filter(esAjuste).length,
      totalAntes, totalEsperado: esperado,
    };

    if (dryRun) {
      salida.factura = (so.invoices || []).map((f: any) => ({ num: f.invoice_number, total: f.total, saldo: f.balance }));
      return json(salida);
    }

    const payload = [
      ...lineas.map(aPayload),
      {
        item_id: ITEM_AJUSTE, item_order: lineas.length + 1,
        name: "AJUSTE POR CIERRE DE PROYECTO", description: firma,
        quantity: 1, rate: importe, ...(imp.tax_id ? { tax_id: imp.tax_id } : {}),
      },
    ];
    await z.put(`/salesorders/${soId}`, { customer_id: String(so.customer_id), line_items: payload });

    // Releer: lo que importa es lo que quedo en Zoho, no lo que contesto el PUT.
    const v = await z.get(`/salesorders/${soId}`);
    const vl = v.salesorder?.line_items || [];
    const vtotal = n0(v.salesorder?.total);
    const nuevo = vl.find((li: any) => esAjuste(li) && String(li.description || "") === firma) || null;

    const mal: string[] = [];
    if (vl.length !== lineas.length + 1) mal.push(`renglones ${lineas.length} -> ${vl.length}, esperaba ${lineas.length + 1}`);
    if (!nuevo) mal.push("no se encontro el renglon de ajuste despues de escribir");
    else if (Math.abs(n0(nuevo.item_total) - importe) > TOLERANCIA) mal.push(`el ajuste quedo en ${n0(nuevo.item_total)}, no en ${importe}`);
    if (Math.abs(vtotal - esperado) > TOLERANCIA) mal.push(`total ${vtotal} != ${esperado}`);
    if (mal.length) throw new Error("La orden no quedo como se calculo: " + mal.join(" · "));

    salida.orden.totalQuedo = vtotal;

    // ── 2. La factura ─────────────────────────────────────────────────────
    // El "por cobrar" de la app sale del saldo de la FACTURA cuando la hay, asi
    // que un ajuste solo en la orden no mueve la cobranza.
    //
    // Con mas de una factura no se adivina a cual va: se reporta y lo decide
    // una persona. Repartir un ajuste a ojo entre dos facturas se ve exacto y
    // no lo es.
    const facturas = so.invoices || [];
    if (!tambienFactura) salida.factura = { hecho: false, por: "no se pidio" };
    else if (!facturas.length) salida.factura = { hecho: false, por: "la orden no tiene factura" };
    else if (facturas.length > 1) salida.factura = { hecho: false, por: `la orden tiene ${facturas.length} facturas: se aplica a mano`, cuales: facturas.map((f: any) => f.invoice_number) };
    else {
      const fid = String(facturas[0].invoice_id);
      const fd = await z.get(`/invoices/${fid}`);
      const fac = fd.invoice;
      const fl = fac?.line_items || [];
      const fimp = impuestoDe(fl);
      const fAntes = n0(fac?.total);
      const fEsperado = r2(fAntes + importe * (1 + fimp.pct / 100));

      const fpayload = [
        ...fl.map(aPayload),
        {
          item_id: ITEM_AJUSTE, item_order: fl.length + 1,
          name: "AJUSTE POR CIERRE DE PROYECTO", description: firma,
          quantity: 1, rate: importe, ...(fimp.tax_id ? { tax_id: fimp.tax_id } : {}),
        },
      ];
      await z.put(`/invoices/${fid}`, { customer_id: String(fac.customer_id), line_items: fpayload });

      const fv = await z.get(`/invoices/${fid}`);
      const fvl = fv.invoice?.line_items || [];
      const fvtotal = n0(fv.invoice?.total);
      const fmal: string[] = [];
      if (fvl.length !== fl.length + 1) fmal.push(`renglones ${fl.length} -> ${fvl.length}`);
      if (Math.abs(fvtotal - fEsperado) > TOLERANCIA) fmal.push(`total ${fvtotal} != ${fEsperado}`);

      salida.factura = {
        hecho: !fmal.length, numero: fac.invoice_number,
        totalAntes: fAntes, totalEsperado: fEsperado, totalQuedo: fvtotal,
        saldo: n0(fv.invoice?.balance), mal: fmal.length ? fmal : undefined,
      };
      // La orden ya quedo bien. Si la factura fallo se reporta, no se tira todo:
      // deshacer la orden aqui dejaria dos escrituras a medias en vez de una.
      if (fmal.length) salida.ok = false;
    }

    // ── 3. Bitacora ───────────────────────────────────────────────────────
    // Quien, cuando, cuanto y por que. Sin esto, en seis meses nadie sabe de
    // donde salio un renglon de -18,400.
    const rb = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${KEY}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    let previo: any = { movimientos: [] };
    try { const rows = await rb.json(); if (rows?.[0]?.value) previo = JSON.parse(rows[0].value); } catch { /* arranca vacio */ }
    const mov = {
      cuando: new Date().toISOString(), quien: quien.nombre, correo: quien.correo,
      ov: so.salesorder_number, soId, moneda: so.currency_code, importe, motivo,
      ordenAntes: totalAntes, ordenDespues: salida.orden.totalQuedo,
      factura: salida.factura?.numero || null,
      facturaAntes: salida.factura?.totalAntes ?? null,
      facturaDespues: salida.factura?.totalQuedo ?? null,
      ok: salida.ok,
    };
    await fetch(`${SB}/rest/v1/adm_kv`, {
      method: "POST",
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        key: KEY,
        value: JSON.stringify({ movimientos: [...(previo.movimientos || []).slice(-499), mov] }),
        updated_at: new Date().toISOString(),
      }),
    });

    salida.llamadas = z.llamadas;
    return json(salida);
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message || e), llamadas: z.llamadas }, 500);
  }
});
