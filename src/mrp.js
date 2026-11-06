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

// `apartado`: { [SKU]: piezas que la orden de venta TODAVIA debe } = cantidad
// menos entregado, leido de la OV de Zoho. Todo SKU que este en la orden
// aparece, aunque sea con 0: un 0 significa «ya se entrego completo», y eso es
// distinto de «no esta en la orden».  [6-nov-2026]
export function lineasDeProyecto(p, apartado) {
  const D = Dde(p)
  const lineas = (p.materiales || []).map((m) => {
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
      // Se resuelven abajo, contra la orden de venta.
      //   planear   lo que el MRP va a comprar (sale de Zoho)
      //   falta     lo diseñado que la orden no cubre
      //   estadoOV  pendiente · parcial · entregado · fuera
      enOrden: true, planear: reqDe(m), falta: 0, estadoOV: 'pendiente',
    }
  })

  // LA ORDEN DE VENTA MANDA — Y LA ORDEN ES ZOHO.  [6-nov-2026]
  //
  // Fran: «se quita entonces PIDE OBRA, porque solo vemos Zoho. Si ya se
  // entregaron equipos y materiales ya no deben salir en el MRP y se quitan de
  // lo pendiente de compra. No hay cantidad apartada: o esta en la orden, o
  // esta empaquetado, o esta empaquetado y surtido».
  //
  // La version anterior preguntaba `zoho_line_id` de IS-PMT. Ese campo no dice
  // si la linea esta en la orden: dice si IS-PMT la empujo. LA NORIA 100 tiene
  // 96 m de CC3/0NEG en SO-01072 y los ocho renglones de IS-PMT traian el campo
  // vacio, porque IS-PMT partio 96 en ocho de 12 y Zoho tiene una sola linea.
  // Preguntarle a Zoho directamente no tiene ese problema.
  if (apartado) {
    const resto = Object.create(null)
    for (const k of Object.keys(apartado)) resto[k] = num(apartado[k])
    // Se reparte empezando por el renglon que se necesita PRIMERO: si la orden
    // ya no alcanza para todos, el que se queda descubierto es el mas lejano,
    // que es el que todavia da tiempo de corregir.
    const porFecha = [...lineas].sort((a, b) =>
      String(a.fechaCompra || '9999-99-99').localeCompare(String(b.fechaCompra || '9999-99-99')))
    for (const l of porFecha) {
      const k = String(l.sku || '').trim().toUpperCase()
      const tenia = k ? apartado[k] : undefined
      const hay = k ? resto[k] : undefined
      const toma = hay === undefined ? 0 : Math.max(0, Math.min(l.requerido, hay))
      if (k && hay !== undefined) resto[k] = hay - toma
      l.planear = toma
      l.falta = Math.max(0, l.requerido - toma)
      l.enOrden = toma > 0
      // 'entregado' NO es hueco: la orden traía el renglón y ya salió. Por eso
      // se mide contra lo que la orden tenía al principio, no contra lo que
      // quedó después de repartir.
      l.estadoOV = tenia === undefined ? 'fuera'
        : num(tenia) <= 0 ? 'entregado'
        : l.falta > 0 ? 'parcial' : 'pendiente'
    }
  }
  return lineas
}

// LA ORDEN DE VENTA MANDA.  [6-nov-2026]
//
// Fran: «el MRP debe mostrar y calcular en función de lo que esté dado de
// alta en la orden de venta, punto. Si no han dado de alta los materiales
// porque ingeniería no ha hecho su trabajo, será algo que deberemos corregir
// internamente en nuestros procesos... así es la única manera de que lo que
// se pida y compre tenga un sustento de ingeniería».
//
// Es una regla de negocio, no un filtro técnico: comprar contra un diseño
// que nadie subió a la orden es comprar sin respaldo comercial.
//
// `sinOrden` existe para que el hueco se vea. Una regla que esconde datos en
// silencio deja de ser regla y se vuelve fuga — es el mismo error del folio
// que no se escribía durante tres semanas.
export function conOrden(p, apartado) { return lineasDeProyecto(p, apartado).filter((l) => l.enOrden) }
// El hueco de verdad: lo que la orden NO trae ('fuera') y lo que trae corto
// ('parcial'). Lo ya entregado no es hueco y no sale: por eso 'entregado' se
// queda afuera de esta lista y tambien del MRP.
export function sinOrden(p, apartado) {
  return lineasDeProyecto(p, apartado).filter((l) => l.estadoOV === 'fuera' || l.estadoOV === 'parcial')
}

export function bomPorHito(p, hitosDelFeed, apartado) {
  // Solo lo que la orden de venta todavía debe. Lo entregado desaparece y lo
  // que no está en la orden sale aparte, en «falta subir a la orden».
  const lineas = lineasDeProyecto(p, apartado).filter((l) => l.enOrden)
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
      // `piezas` es lo que se va a COMPRAR: lo que la orden todavía debe.
      // `disenado` es lo que ingeniería puso. Donde no coinciden, ya se entregó
      // parte o la orden se quedó corta.
      piezas: mats.reduce((a, m) => a + m.planear, 0),
      disenado: mats.reduce((a, m) => a + m.requerido, 0),
    }
  }).filter((g) => g.materiales.length)
}

export { HITOS, hitoById }
