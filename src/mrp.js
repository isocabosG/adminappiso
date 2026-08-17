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
  HITOS, hitoById, hitoDe, leadDe, leadHito, fechaPedido,
  LEAD_DIAS, LEAD_EQUIPO_CRITICO,
} from './hitos.js'

const num = (v) => Number(v) || 0
const reqDe = (m) => num(m.cant_disenada != null ? m.cant_disenada : m.qty)
const Dde = (p) => (p.fecha_instalacion ? String(p.fecha_instalacion).slice(0, 10) : null)

// ¿La fecha de pedido cae dentro del rango [desde, hasta]? Sin fecha o sin rango, pasa.
function enRango(fCompra, desde, hasta) {
  if (!fCompra) return true
  if (desde && fCompra < desde) return false
  if (hasta && fCompra > hasta) return false
  return true
}

// Todas las partidas de un proyecto como líneas planas, con su hito, lead y fecha de pedido.
export function lineasDeProyecto(p) {
  const D = Dde(p)
  return (p.materiales || []).map((m) => {
    const hito = hitoDe(m)
    const lead = leadDe(m)
    return {
      ov: p.ov, proyecto: p.name, D,
      sku: m.sku || null, descripcion: m.descripcion || '', seccion: m.seccion || null,
      hito, lead, fechaCompra: fechaPedido(D, lead),
      critico: lead >= LEAD_EQUIPO_CRITICO,
      requerido: reqDe(m), pedido: num(m.cant_pedida), entregado: num(m.cant_entregada),
    }
  })
}

// MRP agrupado por hito, agregando material por SKU (o descripción) across proyectos.
// opts: { desde, hasta } filtra por fecha de pedido; { soloFaltante:true } deja solo lo no cubierto.
export function buildMRP(proyectos, invPorSku = {}, opts = {}) {
  const { desde = null, hasta = null, soloFaltante = false } = opts
  const porHito = {} // hito -> { materiales: { key -> celda } }

  for (const p of proyectos || []) {
    for (const l of lineasDeProyecto(p)) {
      if (!enRango(l.fechaCompra, desde, hasta)) continue
      const h = l.hito
      porHito[h] = porHito[h] || { hito: h, materiales: {} }
      const key = l.sku || '~' + l.descripcion.toLowerCase().trim()
      const inv = (l.sku && invPorSku[l.sku]) || {}
      const cel =
        porHito[h].materiales[key] ||
        (porHito[h].materiales[key] = {
          sku: l.sku, desc: l.descripcion || inv.desc || '', hito: h, seccion: l.seccion,
          lead: 0, critico: false,
          requerido: 0, pedido: 0,
          stock: num(inv.stock), comprometido: num(inv.comprometido), enTransito: num(inv.enTransito),
          proyectos: [],
        })
      cel.requerido += l.requerido
      cel.pedido += l.pedido
      cel.lead = Math.max(cel.lead, l.lead)
      cel.critico = cel.critico || l.critico
      cel.proyectos.push({ ov: l.ov, name: l.proyecto, qty: l.requerido, fechaCompra: l.fechaCompra, fechaInstalacion: l.D, lead: l.lead })
    }
  }

  const orden = [1, 2, 3, 4, 5]
  return orden
    .filter((h) => porHito[h])
    .map((h) => {
      let mats = Object.values(porHito[h].materiales).map((m) => {
        const disponible = m.stock // stock físico; comprometido se informa aparte
        const faltante = Math.max(0, m.requerido - disponible)
        return { ...m, faltante, cubierto: disponible >= m.requerido, porComprar: Math.max(0, faltante - m.enTransito) }
      })
      if (soloFaltante) mats = mats.filter((m) => m.faltante > 0)
      // dentro del hito, primero lo más lento y lo que falta comprar
      mats.sort((a, b) => b.lead - a.lead || b.porComprar - a.porComprar || b.requerido - a.requerido)
      const compras = mats.flatMap((m) => m.proyectos.map((pr) => pr.fechaCompra)).filter(Boolean).sort()
      const sitios = mats.flatMap((m) => m.proyectos.map((pr) => pr.fechaInstalacion)).filter(Boolean).sort()
      const leadHitoEfec = mats.reduce((n, m) => Math.max(n, m.lead), LEAD_DIAS[h] || 10)
      return {
        hito: h,
        meta: hitoById(h),
        leadHito: leadHitoEfec, // lo manda la partida más lenta del hito
        ventana: { fechaCompra: compras[0] || null, fechaInstalacion: sitios[sitios.length - 1] || null },
        materiales: mats,
        totRequerido: mats.reduce((a, m) => a + m.requerido, 0),
        totFaltante: mats.reduce((a, m) => a + m.faltante, 0),
        totPorComprar: mats.reduce((a, m) => a + m.porComprar, 0),
      }
    })
    .filter((g) => g.materiales.length)
}

// Calendario de compra plano: una línea por material, ordenado por lead descendente
// (lo que hay que pedir primero arriba), igual que el "Calendario de compra" de IS-PMT.
export function calendarioCompra(proyectos, invPorSku = {}, opts = {}) {
  const grupos = buildMRP(proyectos, invPorSku, opts)
  const filas = grupos.flatMap((g) => g.materiales.map((m) => ({
    hito: g.hito, hitoNombre: g.meta?.corto || '', sku: m.sku, desc: m.desc,
    lead: m.lead, critico: m.critico,
    fechaCompra: (m.proyectos.map((p) => p.fechaCompra).filter(Boolean).sort()[0]) || null,
    requerido: m.requerido, stock: m.stock, enTransito: m.enTransito,
    faltante: m.faltante, porComprar: m.porComprar,
  })))
  filas.sort((a, b) => b.lead - a.lead || (a.fechaCompra || '9999').localeCompare(b.fechaCompra || '9999'))
  return filas
}

export { HITOS, hitoById }
