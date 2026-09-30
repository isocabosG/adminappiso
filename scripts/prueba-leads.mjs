// Compara el lead time ANTES y DESPUÉS del cambio de hitos (30-sep-2026).
//   node scripts/prueba-leads.mjs
//
// Existe por la advertencia de IS-PMT: hoy dos migraciones reportaron "Success"
// sin haber hecho nada. Un "Success" no es una verificación. Esto guarda el
// estado anterior (scripts/_hitos-antes.js es la copia literal del hitos.js que
// había antes) y compara partida por partida.
import * as VIEJO from './_hitos-antes.js'
import * as NUEVO from '../src/hitos.js'

// Partidas con la forma real del feed: las tres trampas que IS-PMT documentó,
// más el caso que motivó todo (batería RENON reclasificada al hito 4).
const CASOS = [
  { n: 'Batería RENON al hito 4 (EL CASO URGENTE)',
    m: { descripcion: 'BATERIA RENON XTREME HV 5KWH', seccion: 'EQUIPOS', sistema: 'SOLAR', milestone_id: 4 },
    espera: 150 },
  { n: 'Batería RENON donde estaba antes (hito 3)',
    m: { descripcion: 'BATERIA RENON XTREME HV 5KWH', seccion: 'EQUIPOS', sistema: 'SOLAR', milestone_id: 3 },
    espera: 150 },
  { n: 'Unidad de control MC050',
    m: { descripcion: 'UNIDAD DE CONTROL MC050 RENON', seccion: 'EQUIPOS', sistema: 'SOLAR', milestone_id: 4 },
    espera: 150 },
  { n: 'Inversor Sol-Ark al hito 4',
    m: { descripcion: 'INVERSOR SOL-ARK 15K-2P', seccion: 'EQUIPOS', sistema: 'SOLAR', milestone_id: 4 },
    espera: 65 },

  { n: 'TRAMPA 1 · cable con nota de contexto',
    m: { descripcion: 'Cable 4/0 AWG flex PORTAELECTRODOS (inversores → baterías)', seccion: 'CABLEADO', sistema: 'SOLAR', milestone_id: 3 },
    espera: 10 },
  { n: 'TRAMPA 2 · Controlador Stellar Edge (monitoreo, no equipo)',
    m: { descripcion: 'CONTROLADOR STELLAR EDGE', seccion: 'MONITOREO', sistema: 'SOLAR', milestone_id: 4 },
    espera: 25 },
  { n: 'TRAMPA 3a · tornillería de ESTRUCTURA',
    m: { descripcion: 'TUERCA SERRADA 5/16', seccion: 'ESTRUCTURA', sistema: 'SOLAR', milestone_id: 2 },
    espera: 20 },
  { n: 'TRAMPA 3b · la misma tuerca, comprada local',
    m: { descripcion: 'TUERCA SERRADA 5/16', seccion: 'INSTALACIÓN DE EQUIPOS', sistema: 'SOLAR', milestone_id: 4 },
    espera: 10 },

  { n: 'Panel de yeso (tablaroca gana sobre "panel")',
    m: { descripcion: 'PANEL DE YESO 1/2"', seccion: 'TABLAROCA', sistema: 'SOLAR', milestone_id: 1 },
    espera: 10 },
  { n: 'Módulo fotovoltaico',
    m: { descripcion: 'MODULO SOLAR 550W TOPX', seccion: 'ESTRUCTURA', sistema: 'SOLAR', milestone_id: 2 },
    espera: 20 },
  { n: 'Generador Kohler (sistema GEN)',
    m: { descripcion: 'GENERADOR KOHLER 38RCL', seccion: 'EQUIPOS', sistema: 'GEN', milestone_id: 2 },
    espera: 65 },
  { n: 'Smart meter',
    m: { descripcion: 'SMART METER TRIFASICO', seccion: 'MONITOREO', sistema: 'SOLAR', milestone_id: 4 },
    espera: 25 },
  { n: 'Cable normal (todo lo demás)',
    m: { descripcion: 'CABLE THHN 12 AWG NEGRO', seccion: 'CABLEADO', sistema: 'SOLAR', milestone_id: 3 },
    espera: 10 },
  { n: 'Red de seguridad: batería sin descripción, solo SKU',
    m: { descripcion: '', sku: 'BREHV5K', seccion: 'EQUIPOS', sistema: 'SOLAR', milestone_id: 4 },
    espera: 150 },
]

let fallos = 0, cambios = 0
console.log('\n  LEAD TIME — ANTES vs DESPUÉS\n')
console.log('  ' + 'partida'.padEnd(48) + 'antes'.padStart(7) + 'ahora'.padStart(8) + '   veredicto')
console.log('  ' + '─'.repeat(88))
for (const c of CASOS) {
  const antes = VIEJO.leadDe(c.m)
  const ahora = NUEVO.leadDe(c.m)
  const ok = ahora === c.espera
  if (!ok) fallos++
  if (antes !== ahora) cambios++
  const marca = !ok ? '✗ ESPERABA ' + c.espera : antes !== ahora ? '✓ corregido (' + NUEVO.porqueLead(c.m) + ')' : '· sin cambio'
  console.log('  ' + c.n.padEnd(48) + String(antes + 'd').padStart(7) + String(ahora + 'd').padStart(8) + '   ' + marca)
}

// Agrupación: SOLAR:4 y GEN:4 NO se pueden mezclar.
const a = { sistema: 'SOLAR', milestone_id: 4 }, b = { sistema: 'GEN', milestone_id: 4 }
const separan = NUEVO.claveHito(a) !== NUEVO.claveHito(b)
if (!separan) fallos++
console.log('\n  Agrupación  SOLAR:4 vs GEN:4 →', NUEVO.claveHito(a), '/', NUEVO.claveHito(b), separan ? '✓ separados' : '✗ SE MEZCLAN')

const nulo = NUEVO.sistemaDe({ sistema: null })
if (nulo !== 'SOLAR') fallos++
console.log('  sistema null → ' + nulo, nulo === 'SOLAR' ? '✓' : '✗ debía ser SOLAR')

// La propiedad de fondo: renumerar el hito ya no mueve ninguna fecha de compra.
const bat = { descripcion: 'BATERIA RENON XTREME HV 5KWH', seccion: 'EQUIPOS' }
const porHito = [1, 2, 3, 4].map((id) => NUEVO.leadDe({ ...bat, milestone_id: id }))
const inmune = new Set(porHito).size === 1
if (!inmune) fallos++
console.log('  Misma batería en los 4 hitos →', porHito.join('d, ') + 'd', inmune ? '✓ el hito ya no manda sobre la fecha' : '✗ el hito todavía la mueve')

console.log('\n  ' + cambios + ' de ' + CASOS.length + ' partidas cambiaron de lead · ' +
  (fallos === 0 ? 'TODAS las pruebas pasaron\n' : fallos + ' PRUEBA(S) FALLARON\n'))
process.exit(fallos ? 1 : 0)
