// Los nombres de los hitos vienen de IS-PMT por el feed; hitos.js es el
// respaldo. Esto verifica las tres situaciones que importan: sin feed, con
// feed, y con feed sucio — porque lo que llega de otro sistema es dato, no
// verdad, y una etiqueta rota no puede tumbar la pantalla.
//   node scripts/prueba-hitos-feed.mjs
import * as H from '../src/hitos.js'
import * as M from '../src/mrp.js'

let fallos = 0
const chk = (n, c) => { if (!c) fallos++; console.log('  ' + (c ? '✓' : '✗') + ' ' + n) }

console.log('\n  SIN FEED (respaldo local)')
const a = H.mapaHitos(null)
chk('12 claves', Object.keys(a).length === 12)
chk('GEN:3 = Inst. general (gas)', a['GEN:3'].nombre === 'Inst. general (gas)')
chk('marcadas como locales', Object.values(a).every((x) => x.origen === 'local'))

console.log('\n  CON FEED (manda el feed)')
const feed = [
  { clave: 'SOLAR:4', sistema: 'SOLAR', num: 4, sistema_nombre: 'Solar', nombre: 'Instalación de equipos FV', encabezado: 'Equipos fotovoltaicos', orden_sistema: 0 },
  { clave: 'GEN:2', sistema: 'GEN', num: 2, sistema_nombre: 'Generador', nombre: 'Generador y base', encabezado: 'Generador', orden_sistema: 1 },
]
const b = H.mapaHitos(feed)
chk('SOLAR:4 toma el nombre del feed', b['SOLAR:4'].nombre === 'Instalación de equipos FV')
chk('marcado origen feed', b['SOLAR:4'].origen === 'feed')
chk('guarda encabezado', b['SOLAR:4'].encabezado === 'Equipos fotovoltaicos')
chk('lo que el feed no mandó sigue local', b['BOMBA:3'].nombre === 'Inst. general (hidráulica)' && b['BOMBA:3'].origen === 'local')
chk('siguen siendo 12', Object.keys(b).length === 12)

console.log('\n  FEED SUCIO (no se cree a ciegas)')
const sucio = [
  { sistema: 'SOLAR', num: 4, nombre: '' },
  { sistema: 'MARCIANO', num: 1, nombre: 'X' },
  { sistema: 'GEN', num: 5, nombre: 'Hito 5' },
  { sistema: 'gen', num: 2, nombre: 'Generador OK' },
  null, 'basura', {},
]
const d = H.mapaHitos(sucio)
chk('nombre vacío → conserva el local', d['SOLAR:4'].nombre === 'Inst. de equipos')
chk('sistema inexistente → ignorado', !Object.keys(d).some((k) => k.startsWith('MARCIANO')))
chk('num 5 → ignorado (ya no existe)', !d['GEN:5'])
chk('minúsculas normalizadas', d['GEN:2'].nombre === 'Generador OK')
chk('sigue en 12 claves', Object.keys(d).length === 12)

console.log('\n  ORDEN Y ETIQUETA EN LA PANTALLA')
const p = { name: 'X', fecha_instalacion: '2027-03-15', materiales: [
  { id: 1, sku: 'BREHV5K', descripcion: 'BATERIA RENON XTREME HV', seccion: 'EQUIPOS', sistema: 'SOLAR', milestone_id: 4, cant_disenada: 8 },
  { id: 2, sku: 'GEN38', descripcion: 'GENERADOR KOHLER', seccion: 'EQUIPOS', sistema: 'GEN', milestone_id: 2, cant_disenada: 1 },
] }
const g = M.bomPorHito(p, feed)
chk('SOLAR:4 usa el nombre del feed', g.find((x) => x.clave === 'SOLAR:4').meta.nombre === 'Instalación de equipos FV')
chk('SOLAR va antes que GEN (orden_sistema)', g[0].sistema === 'SOLAR')
chk('sin feed no se cae', M.bomPorHito(p).find((x) => x.clave === 'SOLAR:4').meta.nombre === 'Inst. de equipos')
// Lo que el feed NO debe poder mover: los días.
chk('el lead sigue en 150 — el feed no toca la tabla de días', g.find((x) => x.clave === 'SOLAR:4').lead === 150)

console.log(fallos ? '\n  ' + fallos + ' FALLO(S)\n' : '\n  todo pasa\n')
process.exit(fallos ? 1 : 0)
