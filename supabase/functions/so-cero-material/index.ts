// Edge Function: so-cero-material
//
// Pone en CERO el material y el equipo de las ordenes de venta que lo traen con
// precio, que es la regla de la casa. Dos modos, porque el arreglo correcto no
// es el mismo en todas las ordenes:
//
//   modo "cero"       El INST de la orden YA es el contrato: la factura se
//                     emitio por INST + su IVA. El material es inflado puro.
//                     Se pone en cero y el TOTAL DE LA ORDEN BAJA al contrato.
//
//   modo "restituir"  Innobyte le quito al INST lo que le puso al material.
//                     Comprobado en SO-00836: el INST de la orden decia
//                     79,599.93, el de la FACTURA 202,893.10, y
//                     79,599.93 + 123,293.17 de material = 202,893.10 exacto.
//                     Se le REGRESA al INST el importe del material y luego el
//                     material se pone en cero. El TOTAL NO CAMBIA. Poner el
//                     material en cero sin restituir dejaria la orden por
//                     debajo de una factura ya emitida.
//
//   modo "contrato"   El contrato lo dice Fran, orden por orden, en la llamada:
//                     ov: [{ ov, total }]. Se mueve el INST lo necesario para
//                     que el TOTAL DE LA ORDEN QUEDE EXACTO en ese importe, y
//                     el material se deja en cero. Es para las ordenes que
//                     quedaron por debajo del contrato porque Innobyte le
//                     siguio restando al INST de mas.
//
// El modo NO se adivina aqui. Viene en la llamada, decidido con la prueba de
// cuanto se facturo por orden. Una funcion que clasifica sola es una funcion
// que un dia clasifica mal y escribe en Zoho.
//
// GUARDAS
// - Zoho BORRA el renglon que no venga en el PUT: se manda el arreglo completo.
// - Orden sin concepto INST: se salta. Ahi el material ES la venta (POSTVENTA).
// - Renglon de material ya facturado: se salta la orden completa.
// - Se calcula el total esperado ANTES de escribir, se relee la orden despues y
//   si no cuadra al peso se marca como fallo. Dos fallos seguidos abortan.
// - dryRun: true calcula todo y NO escribe. Es el valor por omision.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Zoho } from "../_shared/zoho.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const KEY = "iso3-so-cero-material";
const GAP_MS = 500;
const TOPE_SEG = 100;          // corte limpio antes del limite de la funcion
const TOLERANCIA = 1.0;        // pesos/dolares de redondeo que se perdonan
const FALLOS_SEGUIDOS = 2;     // aborta el barrido

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const n0 = (v: unknown) => +(v ?? 0) || 0;
const up = (s: unknown) => String(s ?? "").trim().toUpperCase();
const r2 = (n: number) => Math.round(n * 100) / 100;

const esInst = (li: any) =>
  up(li?.sku) === "INST" ||
  ((li?.line_item_type === "service" || li?.product_type === "service") &&
    /SUMINISTRO\s+E?\s*INSTALACI/i.test(String(li?.name || li?.description || "")));

const esBien = (li: any) => li?.line_item_type === "goods" || li?.product_type === "goods";

const ivaDe = (li: any) =>
  (li?.line_item_taxes || []).reduce((a: number, t: any) => a + n0(t?.tax_amount), 0);

// Lo que se le manda de vuelta a Zoho de cada renglon. Se conserva
// line_item_id (asi Zoho ACTUALIZA el renglon en vez de crear otro) y todo lo
// que el equipo captura a mano: etiquetas, campos personalizados, almacen,
// claves del SAT. Lo calculado (importes, impuestos, existencias) lo rehace
// Zoho y mandarlo de vuelta solo invita a que lo rechace.
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
  o.quantity = n0(li?.quantity);
  o.rate = rate;
  return o;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const SB = Deno.env.get("SUPABASE_URL");
  const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ORG = Deno.env.get("ZOHO_ORG_ID");
  if (!SB || !SRV) return json({ ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY." }, 500);
  if (!ORG) return json({ ok: false, error: "Falta el secreto ZOHO_ORG_ID." }, 500);

  const z = new Zoho(SB, SRV, ORG);
  const t0 = Date.now();

  let cuerpo: any = {};
  try { cuerpo = await req.json(); } catch { /* sin cuerpo */ }
  const dryRun = cuerpo?.dryRun !== false;              // escribir es explicito
  const modo = String(cuerpo?.modo || "");
  const crudo: any[] = Array.isArray(cuerpo?.ov) ? cuerpo.ov : [];
  const ovs: string[] = crudo.map((x) => String(typeof x === "object" ? x?.ov : x));
  // modo "contrato": el total objetivo de cada orden, dado por Fran.
  const meta: Record<string, number> = {};
  // El id de una orden que NO esta en el barrido. El barrido de so-contratado
  // excluye las CERRADAS, asi que una orden cerrada que se nos barrio no se
  // puede corregir por numero: se le pasa el salesorder_id a mano,
  // ov: [{ ov: "SO-01098", id: "4053294000032633298" }].
  const idDado: Record<string, string> = {};
  for (const x of crudo) {
    if (x && typeof x === "object" && x.ov != null) {
      meta[String(x.ov)] = n0(x.total);
      if (x.id) idDado[String(x.ov)] = String(x.id);
    }
  }

  if (modo !== "cero" && modo !== "restituir" && modo !== "contrato") {
    return json({ ok: false, error: 'modo debe ser "cero", "restituir" o "contrato".' }, 400);
  }
  if (!ovs.length) return json({ ok: false, error: "Falta la lista ov[]." }, 400);
  if (modo === "contrato") {
    const sinTotal = ovs.filter((ov) => !(meta[ov] > 0));
    if (sinTotal.length) {
      return json({ ok: false, error: `modo "contrato" necesita ov: [{ov, total}]. Sin total: ${sinTotal.join(", ")}` }, 400);
    }
  }

  // El id de cada orden sale del barrido de so-contratado, no de una busqueda
  // por numero: ese blob ya se verifico y evita una llamada por orden.
  const leerBlob = async (k: string) => {
    const r = await fetch(`${SB}/rest/v1/adm_kv?key=eq.${k}&select=value`, {
      headers: { apikey: SRV, Authorization: `Bearer ${SRV}` },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    try { return rows?.[0]?.value ? JSON.parse(rows[0].value) : null; } catch { return null; }
  };

  const contratado = await leerBlob("iso3-so-contratado");
  const porOv = contratado?.porOv || null;
  if (!porOv) return json({ ok: false, error: "Falta iso3-so-contratado; corre so-contratado primero." }, 409);

  const hechas: any[] = [];
  const saltadas: any[] = [];
  const falladas: any[] = [];
  const pendientes: string[] = [];
  let seguidos = 0;
  let abortado = "";

  for (let i = 0; i < ovs.length; i++) {
    const ov = ovs[i];
    if (abortado) { pendientes.push(ov); continue; }
    if ((Date.now() - t0) / 1000 > TOPE_SEG) { pendientes.push(ov); continue; }

    const id = porOv?.[ov]?.id || idDado[ov] || "";
    if (!id) { saltadas.push({ ov, por: "no esta en el barrido de so-contratado (si esta cerrada, pasa su id)" }); continue; }

    try {
      const d = await z.get(`/salesorders/${id}`);
      const so = d.salesorder;
      const lineas = so?.line_items || [];
      const totalAntes = n0(so?.total);
      const subAntes = n0(so?.sub_total);

      const inst = lineas.find(esInst) || null;
      if (!inst) { saltadas.push({ ov, por: "sin concepto INST: el material es la venta" }); await dormir(GAP_MS); continue; }

      const conPrecio = lineas.filter((li: any) => !esInst(li) && esBien(li) && n0(li.rate) > 0);
      if (!conPrecio.length && modo !== "contrato") {
        saltadas.push({ ov, por: "ya esta en cero" }); await dormir(GAP_MS); continue;
      }

      const facturado = conPrecio.find((li: any) => n0(li.quantity_invoiced) > 0);
      if (facturado) {
        saltadas.push({ ov, por: `renglon de material ya facturado (${up(facturado.sku)})` });
        await dormir(GAP_MS); continue;
      }
      if (n0(inst.discount) > 0) {
        saltadas.push({ ov, por: "el INST trae descuento: se revisa a mano" });
        await dormir(GAP_MS); continue;
      }
      const qInst = n0(inst.quantity) || 1;

      const absorber = r2(conPrecio.reduce((a: number, li: any) => a + n0(li.item_total), 0));
      const ivaMaterial = r2(conPrecio.reduce((a: number, li: any) => a + ivaDe(li), 0));

      // El INST nuevo y el total que DEBE quedar, calculados antes de escribir.
      const instAntes = r2(n0(inst.item_total));

      // Cuanto sube el total por cada peso que se le agrega al INST. Sale de los
      // impuestos del PROPIO renglon: hay ordenes con el INST exento y material
      // gravado, y dar por hecho el 16% ahi deja la orden descuadrada.
      const factorInst = instAntes > 0 ? 1 + ivaDe(inst) / instAntes : 1;

      let instDespues = instAntes;
      let esperado = totalAntes;
      if (modo === "restituir") {
        instDespues = r2(instAntes + absorber);
        esperado = totalAntes;                              // el total no se mueve
      } else if (modo === "cero") {
        esperado = r2(totalAntes - absorber - ivaMaterial); // baja al contrato
      } else {                                             // "contrato"
        esperado = r2(meta[ov]);
        // El material que siga con precio se va a cero, y lo que falte para
        // llegar al contrato se le pone al INST.
        const sinMaterial = r2(totalAntes - absorber - ivaMaterial);
        instDespues = r2(instAntes + (esperado - sinMaterial) / factorInst);
        if (!(instDespues > 0)) {
          saltadas.push({ ov, por: `el contrato ${esperado} deja el INST en ${instDespues}: se revisa a mano` });
          await dormir(GAP_MS); continue;
        }
      }

      const plan = {
        ov, id, cliente: so?.customer_name, moneda: so?.currency_code,
        renglones: lineas.length, materialRenglones: conPrecio.length,
        absorber, ivaMaterial, factorInst: r2(factorInst),
        instAntes, instDespues,
        totalAntes, totalEsperado: esperado,
      };

      if (dryRun) { hechas.push({ ...plan, escrito: false }); await dormir(GAP_MS); continue; }

      const aCero = new Set(conPrecio.map((li: any) => li.line_item_id));
      const payload = lineas.map((li: any) => {
        if (aCero.has(li.line_item_id)) return aPayload(li, 0);
        if (li.line_item_id === inst.line_item_id && modo !== "cero") {
          return aPayload(li, r2(instDespues / qInst));
        }
        return aPayload(li, n0(li.rate));
      });

      await z.put(`/salesorders/${id}`, { line_items: payload });
      await dormir(GAP_MS);

      // Releer: lo que importa es lo que quedo en Zoho, no lo que contesto el PUT.
      const v = await z.get(`/salesorders/${id}`);
      const vso = v.salesorder;
      const vlineas = vso?.line_items || [];
      const vinst = vlineas.find(esInst) || null;
      const vconPrecio = vlineas.filter((li: any) => !esInst(li) && esBien(li) && n0(li.rate) > 0);
      const vtotal = n0(vso?.total);

      const mal: string[] = [];
      if (vlineas.length !== lineas.length) mal.push(`renglones ${lineas.length} -> ${vlineas.length}`);
      if (vconPrecio.length) mal.push(`${vconPrecio.length} renglones de material siguen con precio`);
      if (!vinst) mal.push("se perdio el concepto INST");
      else if (Math.abs(n0(vinst.item_total) - instDespues) > TOLERANCIA) mal.push(`INST ${n0(vinst.item_total)} != ${instDespues}`);
      if (Math.abs(vtotal - esperado) > TOLERANCIA) mal.push(`total ${vtotal} != ${esperado}`);

      if (mal.length) {
        falladas.push({ ...plan, totalQuedo: vtotal, subAntes, mal });
        seguidos++;
        if (seguidos >= FALLOS_SEGUIDOS) abortado = `${seguidos} fallos seguidos; se detiene el barrido`;
      } else {
        hechas.push({ ...plan, escrito: true, totalQuedo: vtotal });
        seguidos = 0;
      }
    } catch (e) {
      falladas.push({ ov, mal: [String((e as Error)?.message || e).slice(0, 200)] });
      seguidos++;
      if (seguidos >= FALLOS_SEGUIDOS) abortado = `${seguidos} fallos seguidos; se detiene el barrido`;
    }
    await dormir(GAP_MS);
  }

  // Bitacora acumulada: cada corrida se agrega, no se pisa.
  const previo = (await leerBlob(KEY)) || { corridas: [] };
  const corrida = {
    cuando: new Date().toISOString(), modo, dryRun,
    pedidas: ovs.length, hechas: hechas.length, saltadas: saltadas.length,
    falladas: falladas.length, pendientes: pendientes.length, abortado,
    detalle: { hechas, saltadas, falladas, pendientes },
  };
  const valor = { corridas: [...(previo.corridas || []).slice(-9), corrida] };
  await fetch(`${SB}/rest/v1/adm_kv`, {
    method: "POST",
    headers: { apikey: SRV, Authorization: `Bearer ${SRV}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: KEY, value: JSON.stringify(valor), updated_at: new Date().toISOString() }),
  });

  return json({
    ok: !abortado && !falladas.length,
    dryRun, modo, abortado,
    resumen: {
      pedidas: ovs.length, hechas: hechas.length, saltadas: saltadas.length,
      falladas: falladas.length, pendientes: pendientes.length,
      bajaDeTotal: r2(hechas.reduce((a, h) => a + (h.totalAntes - h.totalEsperado), 0)),
      materialACero: r2(hechas.reduce((a, h) => a + h.absorber, 0)),
    },
    hechas, saltadas, falladas, pendientes,
    segundos: Math.round((Date.now() - t0) / 1000),
    frenadas: z.frenadas, llamadas: z.llamadas,
  });
});
