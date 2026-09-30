// src/hitos.js
// Alineado con is-pmt build HITO-POR-SISTEMA (30-sep-2026). Se mantiene idéntico
// en IS-PMT, Quote Creator y adminappISO para que las tres apps no diverjan.
// Si algo cambia, cambia en IS-PMT y se vuelve a copiar.
//
// ── QUÉ CAMBIÓ Y POR QUÉ IMPORTA ───────────────────────────────────────────
// Antes: el lead time de compra colgaba del HITO. Las baterías RENON valían
// 150 días porque caían en el hito 3.
//
// Con la estructura nueva las baterías y el inversor pasan al hito 4, que en la
// tabla vieja valía 10 días. Es decir: el mismo código, sin tocarlo, habría
// empezado a pedir baterías importadas con diez días de anticipación en vez de
// ciento cincuenta. Son 18 partidas en 13 obras.
//
// Ahora: el lead sale del MATERIAL, no del hito. Esto no es solo cambiar una
// tabla — es quitarle al número de hito el poder de decidir una fecha de compra.
// Si mañana IS-PMT vuelve a renumerar los hitos, las fechas de pedido no se
// mueven. El error que nos pasó hoy ya no se puede repetir por esa vía.
//
// ── LOS HITOS AHORA SON TRES JUEGOS DE CUATRO ──────────────────────────────
// Ya no son 1-5 universales. Cada sistema tiene su propio juego que reinicia en
// 1, así que la llave es el PAR sistema + milestone_id. SOLAR:4, GEN:4 y
// BOMBA:4 son tres hitos distintos que pueden convivir en la misma obra.

export const SISTEMAS = ['SOLAR', 'GEN', 'BOMBA']

export const HITOS_POR_SISTEMA = {
  SOLAR: [
    { id: 1, nombre: 'Preparaciones' },
    { id: 2, nombre: 'Inst. de estructura' },
    { id: 3, nombre: 'Instalación general' },
    { id: 4, nombre: 'Inst. de equipos' },
  ],
  GEN: [
    { id: 1, nombre: 'Preparaciones' },
    { id: 2, nombre: 'Generador' },
    { id: 3, nombre: 'Inst. general (gas)' },
    { id: 4, nombre: 'Inst. de equipos' },
  ],
  BOMBA: [
    { id: 1, nombre: 'Preparaciones' },
    { id: 2, nombre: 'Bomba' },
    { id: 3, nombre: 'Inst. general (hidráulica)' },
    { id: 4, nombre: 'Inst. de equipos' },
  ],
}

// `sistema` puede venir null en partidas que nadie ha tocado: se trata como SOLAR.
export const sistemaDe = (m) => {
  const s = String(m?.sistema || '').trim().toUpperCase()
  return SISTEMAS.includes(s) ? s : 'SOLAR'
}

// El número del hito dentro de su sistema. Ya solo sirve para AGRUPAR y
// ETIQUETAR: no interviene en ninguna fecha de compra.
export function hitoDe(m) {
  const id = Number(m?.milestone_id)
  return id >= 1 && id <= 4 ? id : 1
}

// La llave de verdad. Agrupar por número solo mezclaría SOLAR:4 con GEN:4.
export const claveHito = (m) => `${sistemaDe(m)}:${hitoDe(m)}`

export const hitoById = (id, sistema = 'SOLAR') =>
  (HITOS_POR_SISTEMA[String(sistema || 'SOLAR').toUpperCase()] || HITOS_POR_SISTEMA.SOLAR)
    .find((h) => h.id === Number(id)) || null

// ── LEAD TIME POR MATERIAL ─────────────────────────────────────────────────
// Los números son los mismos de siempre: p90 sobre 1,200 órdenes de compra de
// Books (jun-2025 a ago-2026), midiendo `date` → `delivery_date`. Se usa p90 y
// no la mediana porque en obra cuesta mucho más que falte una pieza que tenerla
// una semana en almacén. Lo que cambió es CÓMO se eligen.
//
// Ojo: delivery_date en Books es la fecha PROMETIDA, no la recepción
// verificada (los `receives` vienen vacíos, eso vive en Inventory).

// TRAMPA 1 — Se recorta la nota de contexto antes de comparar.
// "Cable 4/0 AWG flex PORTAELECTRODOS (inversores → baterías)": sin recortar el
// paréntesis, la palabra "baterías" le daba 150 días a un cable e "inversor" le
// daba 65 a otros noventa. Eran 103 partidas de cable comprándose como equipo
// importado.
export const recortaNota = (s) => String(s || '').replace(/\s*[(·•].*$/, '')

const sinAcentos = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()

// Gana el PRIMERO que empata. El orden es la regla, no una preferencia de
// estilo: "panel de yeso" tiene que caer en tablaroca (10) antes de que la
// palabra "panel" lo mande a estructura (20).
export const REGLAS_LEAD = [
  { dias: 10, que: 'tablaroca y plafón',
    re: /TABLAROCA|PANEL DE YESO|PANEL DE CEMENTO|DUROCK|PLAFON/ },

  { dias: 150, que: 'RENON importado — camino crítico',
    re: /RENON|BATERIA|BATERIAS|ECUBE|UNIDAD DE CONTROL|CEREBRO|MC050|MC300/ },

  // TRAMPA 2 — El monitoreo va ANTES que el equipo importado.
  // "Controlador Stellar Edge" trae la palabra CONTROLADOR y se iba a 65; lo
  // hace New Sun Road, que es el proveedor con el que se midieron los 25 días.
  { dias: 25, que: 'red y monitoreo',
    re: /CAT6|RJ45|SFTP|DONGLE|SPLITTER|TP-?LINK|WA850|DECO|SWITCH DE RED|EXTENSOR DE RANGO|ROUTER|GATEWAY|STELLAR|NSR-|TARJETA ADAPTADORA|SMART METER/ },

  { dias: 65, que: 'equipo importado',
    re: /INVERSOR|SOL-?ARK|SYMO|FRONIUS|ENPHASE|IQ8|BMU|CONTROLADOR|GABINETE|FUENTE DE PODER|RACK BPE|TRANSFORMADOR DE CORRIENTE|GENERADOR|KOHLER|BOMBA DE CALOR|TRANSFERENCIA AUTOMATICA/ },

  { dias: 20, que: 'estructura y paneles',
    re: /PANEL|MODULO|ESTRUCTURA|RACKING|TOPX|CLAMP|LARGUERO|SOLERA|COLUMNA|HULE SELLO|GRAPA DE ORILLA|GRAPA INTERMEDIA|MC4|LP-EC/ },
]

export const LEAD_DEFAULT = 10          // cable, canalización, herraje, consumibles
export const LEAD_ESTRUCTURA = 20
export const LEAD_EQUIPO_CRITICO = 150

// Red de seguridad propia de adminappISO (NO viene en la tabla de IS-PMT):
// si la descripción viene vacía, el SKU todavía delata una batería RENON. Sin
// esto, una partida sin descripción se iría a 10 días. Conviene que IS-PMT lo
// incorpore a su tabla para no divergir.
const SKU_CRITICO = /^(BRELV|BREHV|BREP16|BRCHV)/

// Días de anticipación de una partida.
export function leadDe(m) {
  const texto = sinAcentos(recortaNota(m?.descripcion))
  for (const r of REGLAS_LEAD) if (r.re.test(texto)) return r.dias

  // TRAMPA 3 — La tornillería de la sección ESTRUCTURA conserva 20 días.
  // No se compra local: viene en el mismo pedido que el racking, de Diseño
  // Eólico. La misma tuerca comprada local para montar el inversor sí se
  // consigue en 10 — por eso la regla mira la SECCIÓN, no la palabra.
  if (sinAcentos(m?.seccion) === 'ESTRUCTURA') return LEAD_ESTRUCTURA

  if (SKU_CRITICO.test(sinAcentos(m?.sku))) return LEAD_EQUIPO_CRITICO
  return LEAD_DEFAULT
}

// Qué regla ganó — para poder explicar un número en pantalla o en una revisión.
export function porqueLead(m) {
  const texto = sinAcentos(recortaNota(m?.descripcion))
  for (const r of REGLAS_LEAD) if (r.re.test(texto)) return r.que
  if (sinAcentos(m?.seccion) === 'ESTRUCTURA') return 'sección ESTRUCTURA'
  if (SKU_CRITICO.test(sinAcentos(m?.sku))) return 'SKU RENON (sin descripción)'
  return 'material local'
}

// Lead de un grupo: manda la partida más lenta.
export function leadHito(clave, mats) {
  return (mats || []).filter((m) => claveHito(m) === clave)
    .reduce((n, m) => Math.max(n, leadDe(m)), LEAD_DEFAULT)
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

// ── Compatibilidad ─────────────────────────────────────────────────────────
// `HITOS` y `LEAD_DIAS` siguen exportados porque mrp.js los importa. LEAD_DIAS
// ya NO es fuente de verdad de nada: es un piso de 10 días por hito, y el lead
// real siempre lo manda el material. Se deja para no romper la firma mientras
// se limpia el motor viejo.
export const HITOS = HITOS_POR_SISTEMA.SOLAR
export const LEAD_DIAS = { 1: 10, 2: 10, 3: 10, 4: 10 }
