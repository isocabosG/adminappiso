# Sincronización de la cifra de ventas entre apps

**10-oct-2026.** Cierre de la conciliación del contratado 2026. Los tres tableros quedan en
la misma cifra, cada uno corregido por su lado y verificados entre sí por caminos
independientes.

## La cifra

**Obra 2026: 9,453,036.91 USD + 3,552,091.95 MXN**, 120 órdenes.
Postventa: 122,529.99 USD + 2,288,824.95 MXN, 180 órdenes.
89 órdenes depuradas excluidas (garantías del 9-oct) — 14 de obra, 75 de postventa.

Regla: `contratado = subtotal de la orden × 1.16`, y se excluye la orden cuando el **total del
encabezado es 0**. Detalle en `contratado-2026-concepto1.md`.

## Qué se arregló en cada app

### AdminAppISO — `contratado-anio` v4 + `App.jsx`

- **`contratado-anio`** (commit `246089f`): la exclusión de depuradas filtraba por
  `|subtotal| >= 1` y dejaba pasar SO-01011 QUERENCIA 49, que tiene subtotal −173.39 con el
  total en 0 porque su ajuste de −1,342.96 se pasó. Metía −201.13 USD. Ahora el criterio es
  `total >= 0.5`. Lo encontró el equipo de Quote Creator.
- **`App.jsx` / `totDoc()`** (commit `a8962cc`): calculaba el contratado solo y de dos maneras,
  las dos mal.
  - Con factura usaba el total de **la factura**: una obra facturada a medias quedaba valuada
    en lo facturado.
  - Sin factura, `total × 1.16` cuando `source = api`. Esa regla nació cuando Quote Creator
    mandaba las órdenes sin IVA; **hoy ya las manda con IVA**, así que el ×1.16 lo cobraba dos
    veces: **+536,428 USD y +34,993 MXN** en obra 2026. Toda la serie Chileno GV inflada
    ~31,500 USD cada una.
  - Ahora lee el blob `iso3-contratado-<anio>`. Una OV fuera del blob cae al cálculo viejo y la
    tarjeta del resumen dice cuántas van estimadas, en vez de esconderlas en el total.

### Quote Creator — `sync-historico` (proyecto `leeblsvqoyaitqlmxwxh`)

Desplegado por ellos el 10-oct. Ya no escribe a `ventas_historico`:

- las órdenes cuyo folio no empieza con `SO-` (TEST-00918 valía 114,142.17 MXN en la cifra de
  obra 2026);
- las de total en cero (las 88 garantías depuradas).

Descartan la fila completa, no la dejan en cero, porque una fila en cero sigue contando como
proyecto en el conteo del tablero. Su filtro deja **301 de 389** — el mismo conteo al que
llegó AdminApp por un camino independiente. Separan el contador `excluidas` de `descartadas`
a propósito: descartadas significa que Zoho mandó algo ilegible y dispara falla; una página de
depuradas no es una falla.

**Les falta la lectura del subtotal**: el endpoint de lista de Books no devuelve `sub_total`,
solo `total`. Por eso su cifra queda en el total del encabezado (9,401,521 USD) y los 51,515
de diferencia siguen ahí. Se cierra cuando consuman el endpoint de AdminApp.

## Los 51,515 USD de diferencia, por mecanismo

| Mecanismo | Órdenes | USD |
|---|---|---|
| Entran sin IVA desde Quote Creator | SO-01127, SO-01077 | 43,972 |
| Concepto 1 exento | SO-00950, SO-00895 | 1,645 |
| Renglones de equipo sin gravar (Zero Rate) | SO-01051, SO-00952 | 5,898 |

Quote Creator atribuyó SO-00895 a Zero Rate de equipo; es al revés — lo gravado son 1,553.75,
que coincide al centavo con el material, y lo exento es el concepto 1 (3,282.78). SO-01051 sí
es equipo sin gravar.

## Verificación cruzada que funcionó

Los dos equipos midieron el hueco del concepto 1 por caminos distintos: 1,817,764.57 (ellos)
contra 1,817,965.77 (AdminApp). La diferencia de 201.20 era exactamente SO-01011, y fue lo que
delató el bug del filtro. **Medir dos veces por caminos independientes es lo que encontró el
error**, no la revisión del código.

## Estado del despliegue — cerrado el 10-oct-2026

**Lado AdminAppISO: completo y verificado.**

- `contratado-anio` v4 desplegado y corriendo. 389 órdenes, 0 fallos.
- Commits `246089f` y `a8962cc` en `main`.
- `npm run build` sí corrió y pasó. Solo el aviso conocido de que `main-*.js` pasa de 500 kB,
  que es de antes y no viene de este cambio.
- También pasó `react-hooks/rules-of-hooks` limpio — el hook nuevo queda arriba del return
  condicional, que es la clase de bug del React #300 que ya nos mordió.

**Lado Quote Creator:** `send-mail` y `sync-historico` desplegados en `leeblsvqoyaitqlmxwxh`.
Falta correr la sincronización desde su tablero y confirmar el contador.

### Nota operativa: el push que parecía haber fallado

El primer intento de push terminó con `update_ref failed for ref 'refs/remotes/origin/main':
No space left on device`, con el disco del iMac al 100%. **El push había entrado** — la línea
`b62d29a..a8962cc main -> main` es la confirmación de GitHub; lo único que falló fue escribir
el apuntador local. Un `git fetch origin` lo dejó en orden una vez liberado el disco. Repetir
el push habría sido inútil, no dañino.

## Pendientes

1. **Correr la sincronización desde el tablero de ventas de Quote Creator** y confirmar que
   `excluidas` suma 88 para 2026. Si sale 0, el deploy de `sync-historico` no entró. *No se
   puede hacer desde AdminAppISO: es el proyecto `leeblsvqoyaitqlmxwxh` y el acceso de Supabase
   en estas sesiones está limitado a `gkoibrjhlqmuiuedrtaz` por instrucción de Fran.*
2. **Campo de tipo de venta** en Books (obra / servicio / garantía / interno) — instrucción
   girada a Service App, pendiente que Fran cree el campo. Hoy la separación obra/postventa
   depende de la palabra POSTVENTA en texto libre y hay 8 revisiones contadas como obra.
3. **`cf_cotizacion`**, el endpoint `contratado-publico` y el cron semanal de aviso —
   pendientes del Ok de Fran.
