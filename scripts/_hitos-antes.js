// src/hitos.js
// COPIA LITERAL de is-pmt/lib/hitos.js (build HITO-OPERATIVO 17-ago-2026).
// No editar aquí el criterio ni los leads: esto se mantiene idéntico en IS-PMT,
// Quote Creator y adminappISO para que las tres apps no diverjan. Si algo cambia,
// cambia en IS-PMT y se vuelve a copiar. La solución de fondo es etiquetar cf_etapa
// a nivel catálogo en Zoho y retirar el clasificador de las tres.
//
// Los 5 hitos de entrega/compra de Innovación Solar.
//
// El hito de cada partida lo calcula la base de datos (trigger set_material_milestone
// → etapa_de(), misma lógica que etapaDe() en Quote Creator) y llega en la columna
// project_materials.milestone_id. Aquí NO se reclasifica: solo se agrupa para pintar.
//
// SECCION_HITO es únicamente el hito "de casa" de cada sección ERP, para poder mostrar
// una sección vacía en algún lado y que siga sirviendo el botón de subir. Ojo: una
// sección puede repartirse entre varios hitos, porque la clasificación es por partida.

export const HITOS = [
  { id: 1, nombre: 'Preparación e instalación general', corto: 'Preparación',  pctRef: 53, color: 'var(--eng)' },
  { id: 2, nombre: 'Estructura y paneles',              corto: 'Estructura',   pctRef: 25, color: 'var(--hoa)' },
  { id: 3, nombre: 'Equipos',                           corto: 'Equipos',      pctRef: 3,  color: 'var(--brand)' },
  { id: 4, nombre: 'Protecciones',                      corto: 'Protecciones', pctRef: 15, color: 'var(--inst)' },
  { id: 5, nombre: 'Puesta en marcha',                  corto: 'Puesta',       pctRef: 4,  color: 'var(--fin)' },
]

// Lead time de compra por hito, en días antes de la fecha de instalación.
// NO son supuestos: salen de 1,200 órdenes de compra de Books (jun-2025 a
// ago-2026), midiendo `date` → `delivery_date`. Se usa el p90 y no la mediana
// porque en obra cuesta mucho más que falte una pieza que tenerla una semana
// en almacén.
//
//   Hito 3  RENON (baterías)  mediana 82 · p90 148   ← camino crítico
//           resto importado   mediana 28-54 · p90 78
//   Hito 2  Diseño Eólico     mediana 10 · p90 18   (n=170)
//   Hito 1  eléctricas + Procables (cable)  mediana 2-4 · p90 8
//   Hito 5  Cyberpuerta / New Sun Road      mediana 6-12 · p90 25
//
// Ojo: delivery_date en Books es la fecha PROMETIDA, no la recepción
// verificada (los `receives` vienen vacíos, eso vive en Inventory).
export const LEAD_DIAS = { 1: 10, 2: 20, 3: 65, 4: 10, 5: 25 }

// El Hito 3 no es uniforme: las baterías importadas mandan sobre todo lo demás.
export const LEAD_EQUIPO_CRITICO = 150
const CRITICO = /RENON|BATERIA|BATER|BRELV|BREHV|BREP16|BRCHV/

// Días de anticipación reales de una partida.
export function leadDe(m) {
  const h = hitoDe(m)
  if (h === 3 && CRITICO.test(String(m?.descripcion || '').toUpperCase())) return LEAD_EQUIPO_CRITICO
  return LEAD_DIAS[h] || 10
}

// Lead del hito completo: manda la partida más lenta.
export function leadHito(hitoId, mats) {
  const items = mats.filter(m => hitoDe(m) === hitoId)
  return items.reduce((n, m) => Math.max(n, leadDe(m)), LEAD_DIAS[hitoId] || 10)
}

// Fecha límite para levantar la requisición: instalación − lead.
export function fechaPedido(fechaInstalacion, dias) {
  if (!fechaInstalacion) return null
  const [y, mo, d] = String(fechaInstalacion).slice(0, 10).split('-').map(Number)
  if (!y || !mo || !d) return null
  const f = new Date(Date.UTC(y, mo - 1, d))
  f.setUTCDate(f.getUTCDate() - Number(dias || 0))
  return f.toISOString().slice(0, 10)
}

export const SECCION_HITO = {
  'PREPARACIONES':          1,
  'INSTALACIÓN GENERAL':    1,
  'TABLAROCA':              1,
  'ESTRUCTURA':             2,
  'EQUIPOS':                3,
  'CABLEADO':               4,
  'PROTECCIONES Y BUSES':   4,
  'INSTALACIÓN DE EQUIPOS': 4,
  'MONITOREO':              5,
}

export const hitoById = id => HITOS.find(h => h.id === Number(id)) || null

// Hito de una partida: lo que dijo la base. Si por alguna razón viene vacío,
// cae al hito de casa de su sección, y si tampoco, al 1 (igual que el clasificador).
export function hitoDe(m) {
  const id = Number(m?.milestone_id)
  if (id >= 1 && id <= 5) return id
  return SECCION_HITO[m?.seccion] || 1
}

// Secciones que se muestran dentro de un hito:
//   · las que tienen partidas clasificadas en ese hito, y
//   · las que son "de casa" del hito y no tienen partidas en ningún lado
//     (para que siga apareciendo su botón de subir).
export function seccionesDelHito(hitoId, mats, todasLasSecciones) {
  const conPartidas = new Set(
    mats.filter(m => hitoDe(m) === hitoId).map(m => m.seccion)
  )
  const vacias = (todasLasSecciones || []).filter(sec =>
    SECCION_HITO[sec] === hitoId && !mats.some(m => m.seccion === sec)
  )
  return [...new Set([...conPartidas, ...vacias])]
}

// Resumen de un hito para la barra de avance.
export function resumenHito(hitoId, mats) {
  const items = mats.filter(m => hitoDe(m) === hitoId)
  const dis = items.reduce((n, m) => n + Number(m.cant_disenada || 0), 0)
  const ped = items.reduce((n, m) => n + Number(m.cant_pedida || 0), 0)
  const ent = items.reduce((n, m) => n + Number(m.cant_entregada || 0), 0)
  const pendientes = items.filter(m =>
    Math.max(0, Number(m.cant_disenada || 0) - Number(m.cant_entregada || 0)) > 0
  ).length
  return {
    lineas: items.length,
    dis, ped, ent, pendientes,
    pctPedido:    dis > 0 ? Math.round((ped / dis) * 100) : 0,
    pctEntregado: dis > 0 ? Math.round((ent / dis) * 100) : 0,
  }
}
