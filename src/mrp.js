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
      // id de project_materials: es el `materialId` que pide /api/mrp/material.
      id: m.id || null, projectId: p.id || null,
      ov: p.ov, proyecto: p.name, D,
      sku: m.sku || null, descripcion: m.descripcion || '', seccion: m.seccion || null,
      hito, lead, fechaCompra: fechaPedido(D, lead),
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
          lead: 0, critico: false, provisional: false,
          requerido: 0, pedido: 0,
          stock: num(inv.stock), comprometido: num(inv.comprometido), enTransito: num(inv.enTransito),
          proyectos: [],
        })
      cel.requerido += l.requerido
      cel.pedido += l.pedido
      cel.lead = Math.max(cel.lead, l.lead)
      cel.critico = cel.critico || l.critico
      cel.provisional = cel.provisional || l.provisional
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
    lead: m.lead, critico: m.critico, provisional: m.provisional,
    fechaCompra: (m.proyectos.map((p) => p.fechaCompra).filter(Boolean).sort()[0]) || null,
    obras: [...new Set(m.proyectos.map((p) => p.ov || p.name).filter(Boolean))],
    requerido: m.requerido, stock: m.stock, enTransito: m.enTransito,
    faltante: m.faltante, porComprar: m.porComprar,
  })))
  filas.sort((a, b) => b.lead - a.lead || (a.fechaCompra || '9999').localeCompare(b.fechaCompra || '9999'))
  return filas
}

// Días entre dos fechas ISO (b − a). Negativo = b ya pasó.
function diasEntreISO(a, b) {
  if (!a || !b) return null
  const A = Date.parse(String(a).slice(0, 10) + 'T00:00:00')
  const B = Date.parse(String(b).slice(0, 10) + 'T00:00:00')
  return isNaN(A) || isNaN(B) ? null : Math.round((B - A) / 86400000)
}

// MRP FECHADO: agrupa por la fecha en que el material se NECESITA EN OBRA
// (fecha_instalacion del proyecto), y dentro por hito. La fecha de pedido
// (D − lead) deja de ser el eje y pasa a ser una alerta por renglón.
//
// Diferencia de fondo con buildMRP(): el stock se asigna a la fecha más
// próxima primero. Si el mismo SKU se necesita en dos obras, las piezas que
// hay cubren la primera y la segunda queda descubierta. Sin esa asignación el
// mismo inventario se cuenta dos veces y el MRP manda comprar de menos.
export function buildMRPPorFecha(proyectos, invPorSku = {}, opts = {}) {
  const { soloFaltante = false, hoyISO = new Date().toISOString().slice(0, 10) } = opts
  const porFecha = {}

  for (const p of proyectos || []) {
    for (const l of lineasDeProyecto(p)) {
      if (!l.D) continue
      // Una obra cuya fecha ya pasó no puede generar una compra: o ya se instaló,
      // o nadie la cerró en IS-PMT. Se excluye ANTES de repartir el stock, porque
      // si no se lleva piezas que le tocan a una obra que sí viene.
      if (l.D < hoyISO) continue
      const f = (porFecha[l.D] = porFecha[l.D] || { fecha: l.D, hitos: {} })
      const g = (f.hitos[l.hito] = f.hitos[l.hito] || { hito: l.hito, materiales: {} })
      const key = l.sku || '~' + l.descripcion.toLowerCase().trim()
      const inv = (l.sku && invPorSku[l.sku]) || {}
      const cel = g.materiales[key] || (g.materiales[key] = {
        key, sku: l.sku, desc: l.descripcion || inv.desc || '', hito: l.hito,
        lead: 0, critico: false, provisional: false, fechaCompra: null,
        requerido: 0, pedido: 0, entregado: 0, proyectos: [],
      })
      cel.requerido += l.requerido
      cel.pedido += l.pedido
      cel.entregado += l.entregado
      // manda la partida más lenta: es la que fija cuándo hay que levantar el pedido
      if (l.lead > cel.lead) { cel.lead = l.lead; cel.fechaCompra = l.fechaCompra }
      cel.critico = cel.critico || l.critico
      cel.provisional = cel.provisional || l.provisional
      cel.proyectos.push({ ov: l.ov, name: l.proyecto, qty: l.requerido })
    }
  }

  const poolStock = {}, poolLotes = {}
  return Object.keys(porFecha).sort().map((fecha) => {
    const hitos = [1, 2, 3, 4, 5]
      .filter((h) => porFecha[fecha].hitos[h])
      .map((h) => {
        let mats = Object.values(porFecha[fecha].hitos[h].materiales)
          .sort((a, b) => b.lead - a.lead || b.requerido - a.requerido)
          .map((m) => {
            const k = m.sku || m.key
            const inv = (m.sku && invPorSku[m.sku]) || {}
            if (poolStock[k] == null) poolStock[k] = num(inv.stock)
            if (poolLotes[k] == null) {
              // Lotes de OC abiertas, del que llega primero al que llega después.
              poolLotes[k] = (inv.transitoLotes || [])
                .map((l) => ({ qty: num(l.qty), eta: l.eta ? String(l.eta).slice(0, 10) : null }))
                .filter((l) => l.qty > 0)
                .sort((a, b) => String(a.eta || '9999-12-31').localeCompare(String(b.eta || '9999-12-31')))
            }
            const deStock = Math.min(poolStock[k], m.requerido); poolStock[k] -= deStock
            let resto = m.requerido - deStock
            // Solo cuenta el material en tránsito que LLEGA ANTES de la obra.
            // Una OC que aterriza después no sirve para esa fecha: llegar tarde
            // es lo mismo que no llegar.
            let deTransito = 0, sinFecha = 0
            for (const lote of poolLotes[k]) {
              if (resto <= 0) break
              if (!lote.eta) { sinFecha += lote.qty; continue }
              if (lote.eta > fecha) continue
              const usa = Math.min(lote.qty, resto)
              lote.qty -= usa; resto -= usa; deTransito += usa
            }
            const porComprar = Math.max(0, resto)
            // De lo que falta, ¿cuánto YA ESTÁ PEDIDO pero en una OC que aterriza
            // después de la obra? Solo se mira, NO se consume del pool: esa OC
            // sigue sirviendo para una obra posterior y no hay que quemarla aquí.
            const enCaminoTarde = poolLotes[k].reduce((a, l) => a + ((l.eta && l.eta > fecha) ? l.qty : 0), 0)
            const pedidoTarde = Math.min(porComprar, enCaminoTarde)
            // Lo que de verdad nadie ha pedido. Es el único número que amerita rojo.
            const sinPedir = Math.max(0, porComprar - pedidoTarde - Math.min(sinFecha, porComprar - pedidoTarde))
            return {
              ...m, deStock, deTransito, sinFecha, porComprar, pedidoTarde, sinPedir,
              cubierto: porComprar === 0,
              // Rojo solo si se pasó la fecha de pedir Y no hay ninguna OC cubriéndolo.
              // Con OC en camino no es "pedido vencido", es "llega tarde": otro problema.
              tarde: !!(m.fechaCompra && m.fechaCompra < hoyISO && sinPedir > 0),
            }
          })
        if (soloFaltante) mats = mats.filter((m) => m.porComprar > 0)
        return { hito: h, meta: hitoById(h), materiales: mats, totPorComprar: mats.reduce((a, m) => a + m.porComprar, 0) }
      })
      .filter((g) => g.materiales.length)

    const mapObras = new Map()
    for (const g of hitos) for (const m of g.materiales) for (const pr of m.proyectos) {
      const k = pr.ov || pr.name
      if (k && !mapObras.has(k)) mapObras.set(k, { ov: pr.ov || null, name: pr.name || '' })
    }
    const obras = [...mapObras.values()]
    return {
      fecha, hitos, obras,
      dias: diasEntreISO(hoyISO, fecha),
      totPorComprar: hitos.reduce((a, g) => a + g.totPorComprar, 0),
      totSinPedir: hitos.reduce((a, g) => a + g.materiales.reduce((k, m) => k + (m.sinPedir || 0), 0), 0),
      totPedidoTarde: hitos.reduce((a, g) => a + g.materiales.reduce((k, m) => k + (m.pedidoTarde || 0), 0), 0),
      tarde: hitos.some((g) => g.materiales.some((m) => m.tarde)),
      // Con leads de hasta 150 d casi todo sale "vencido". Lo que informa no es
      // SI está tarde sino CUÁNTO: la partida más atrasada del grupo.
      diasTarde: hitos.reduce((n, g) => g.materiales.reduce((k, m) =>
        (m.tarde && m.fechaCompra) ? Math.max(k, -(diasEntreISO(hoyISO, m.fechaCompra) || 0)) : k, n), 0),
    }
  }).filter((f) => f.hitos.length)
}

// BOM de UN proyecto agrupado por hito — para la ficha del proyecto.
export function bomPorHito(p) {
  const lineas = lineasDeProyecto(p)
  return [1, 2, 3, 4, 5].map((h) => {
    const mats = lineas.filter((l) => l.hito === h).sort((a, b) => b.lead - a.lead)
    return {
      hito: h, meta: hitoById(h), materiales: mats,
      lead: mats.reduce((n, m) => Math.max(n, m.lead), 0),
      fechaCompra: mats.map((m) => m.fechaCompra).filter(Boolean).sort()[0] || null,
      piezas: mats.reduce((a, m) => a + m.requerido, 0),
    }
  }).filter((g) => g.materiales.length)
}

export { HITOS, hitoById }
