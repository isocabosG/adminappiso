// src/mrp.js — MRP de compras por hito para adminappISO.
//
// Fuente de verdad de clasificación y lead: src/hitos.js (copia literal de
// is-pmt/lib/hitos.js). adminappISO NO reclasifica material: consume el
// `milestone_id` que ya calculó la BD de IS-PMT (trigger etapa_de()), igual que
// hace IS-PMT en su runtime. Lo que este motor agrega sobre IS-PMT es: (a) cruzar
// contra el inventario de adminappISO y (b) agregar varios proyectos en un solo
// calendario de compra.
//
// Shape del FEED de IS-PMT (endpoint /api/mrp, por conectar) — refleja
// project_materials tal cual:
//   proyectos: [{
//     name, ov, so_id, fecha_instalacion: "YYYY-MM-DD",   // D = fecha de instalación
//     materiales: [{ sku, descripcion, seccion, milestone_id,
//                    cant_disenada, cant_pedida, cant_entregada }],
//   }]
// Inventario de adminappISO por SKU:
//   invPorSku: { [sku]: { stock, comprometido, enTransito, desc } }
//
// Regla del MRP (brief 17-ago): ventana de compra del hito H = [ D − lead(H), D ],
// donde lead(H) lo manda la partida más lenta del hito (leadHito). Cada partida
// tiene además su propia fecha de pedido = D − leadDe(partida). El número del hito
// es el orden en que LLEGA a obra, no en que se compra: baterías son Hito 3 pero se
// piden primero (150 d). Por eso el calendario se ordena por lead descendente.

import {
  HITOS, hitoById, hitoDe, sistemaDe, claveHito,
  leadDe, porqueLead, fechaPedido, mapaHitos, LEAD_EQUIPO_CRITICO,
} from './hitos.js'

const num = (v) => Number(v) || 0
const reqDe = (m) => num(m.cant_disenada != null ? m.cant_disenada : m.qty)
const Dde = (p) => (p.fecha_instalacion ? String(p.fecha_instalacion).slice(0, 10) : null)

export function lineasDeProyecto(p) {
  const D = Dde(p)
  return (p.materiales || []).map((m) => {
    const hito = hitoDe(m)
    const sistema = sistemaDe(m)
    const lead = leadDe(m)
    return {
      // id de project_materials: es el `materialId` que pide /api/mrp/material.
      id: m.id || null, projectId: p.id || null,
      ov: p.ov, proyecto: p.name, D,
      sku: m.sku || null, descripcion: m.descripcion || '', seccion: m.seccion || null,
      // `hito` solo agrupa y etiqueta. La fecha de compra la manda el MATERIAL:
      // si IS-PMT renumera los hitos, esta fecha no se mueve.
      hito, sistema, clave: claveHito(m),
      lead, leadPorque: porqueLead(m), fechaCompra: fechaPedido(D, lead),
      critico: lead >= LEAD_EQUIPO_CRITICO,
      provisional: !!m.provisional, // true = viene de la OV (sin BOM sincronizado)
      // Del feed de IS-PMT: true vigente · false dado de baja · null no se sabe.
      // null y false NO se mezclan: "no se sabe" no es "está de baja".
      skuActivo: m.sku_activo === undefined ? null : m.sku_activo,
      skuLocked: !!m.sku_locked, cantLocked: !!m.cant_locked,
      lockedAt: m.locked_at || null,
      // Última vez que ESTA obra se mandó a su orden de venta de Zoho.
      // Mandar a la OV es un acto manual de gerencia en IS-PMT, sin calendario:
      // una corrección posterior a esta fecha todavía no llegó al cliente.
      soEnviadoAt: p.zoho_so_enviado_at || null,
      requerido: reqDe(m), entregado: num(m.cant_entregada),
      // OJO: `cant_pedida` NO es material comprado. IS-PMT lo escribe cuando
      // alguien levanta una requisición de sección o de hito DENTRO de IS-PMT;
      // nunca mira Zoho. Significa "esta obra ya pidió esto", no "compras ya lo
      // ordenó". Se llamaba `pedido` y nadie lo pintaba, pero con ese nombre era
      // cuestión de tiempo que alguien lo sumara como cobertura de compra.
      solicitadoEnObra: num(m.cant_pedida),
      // Fecha de llegada a almacén, de IS-PMT. Ellos la arman en `sync-eta` y
      // una persona puede corregirla a mano; esa corrección vale más que la
      // promesa del PO, así que es la que se le enseña a Jesús.
      //   etaOrigen 'ov'     el PO nombraba esta obra — asignada y confiable
      //   etaOrigen 'sku'    el PO no decía para quién — puede ser material de
      //                      piso que NOSOTROS ya contamos como inventario
      //   etaOrigen 'manual' la capturó una persona — manda sobre las otras dos
      etaAlmacen: m.eta_almacen || null,
      etaOrigen: m.eta_origen || null,
      etaLocked: !!m.eta_locked,
    }
  })
}

export function bomPorHito(p, hitosDelFeed) {
  const lineas = lineasDeProyecto(p)
  // Se recorre sistema por sistema: SOLAR:4, GEN:4 y BOMBA:4 son tres hitos
  // distintos que pueden convivir en la misma obra. Agrupar por el numero solo
  // los fundiria en uno. El orden lo manda el feed (orden_sistema, num) y si no
  // hay feed, el de la tabla local.
  const mapa = mapaHitos(hitosDelFeed)
  const pares = Object.values(mapa)
    .sort((a, b) => a.ordenSistema - b.ordenSistema || a.num - b.num)
    .map((h) => [h.sistema, h.num])
  return pares.map(([s, h]) => {
    const clave = `${s}:${h}`
    const mats = lineas.filter((l) => l.clave === clave).sort((a, b) => b.lead - a.lead)
    return {
      hito: h, sistema: s, clave, meta: mapa[clave] || hitoById(h, s), materiales: mats,
      lead: mats.reduce((n, m) => Math.max(n, m.lead), 0),
      fechaCompra: mats.map((m) => m.fechaCompra).filter(Boolean).sort()[0] || null,
      piezas: mats.reduce((a, m) => a + m.requerido, 0),
    }
  }).filter((g) => g.materiales.length)
}

export { HITOS, hitoById }
