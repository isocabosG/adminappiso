# Flujo de efectivo semanal — especificación y punto de arranque

_19-oct-2026, fin de sesión. Todo lo de aquí está medido contra Zoho ese día,
no supuesto._

## Por qué esto se puede hacer ya

La nota de septiembre (`tesoreria-y-cobranza-plan.md`) decía que faltaban scopes
de Zoho. **Ya no.** Se probó endpoint por endpoint el 19-oct:

| Pieza | Estado | Dónde |
|---|---|---|
| Saldos por cuenta y moneda | ✅ corre solo | blob `iso3-bancos-zoho` |
| Ingresos (pagos de clientes) | ✅ corre solo | blob `iso3-pagos-zoho`, 212 kB |
| Egresos (gastos) | ⚠️ el API responde, **nadie los baja** | no existe blob |
| Compras a proveedor (bills) | ❌ sin scope | — |
| Contratado por OV (concepto 1) | ✅ existe, **sin cron** | blob `iso3-contratado-2026` |

**El único trabajo de datos pendiente es bajar los egresos.** Lo demás ya está.

## Los números del 19-oct, para comparar después

| | |
|---|---|
| Pesos líquidos | $786,763 |
| Dólares líquidos | USD 238,113 |
| Consolidado @18.43 | ≈ $5.17 M |
| Deuda | $10.17 M (préstamos BBVA 3.3 M + 5.9 M, TDC 900k) |
| Salida real | ≈ $1.9 M por semana |

Cobertura ≈ 2.7 semanas de egreso con el efectivo en caja. No es lectura de
solvencia —entran cobros cada semana— pero es la razón por la que el **valle
semanal** importa más que el cierre del año.

## La trampa que hay que codificar antes de dibujar nada

Del 1-sep al 19-oct hay 182 gastos capturados por $35.5 M. **$22.3 M de esos no
son salidas de efectivo:**

```
35.5 M  gastos capturados en Zoho
-19.6 M  «Cambio Divisa Dólares»  → 12 movimientos, todos salen de Mifel
                                    Dólares y entran como pesos. Traspaso.
- 2.7 M  «Ajuste al Neto»         → 9-sep, dos sobre cuentas ZInactivo y
                                    2.5 M de Fondos Sin Depositar. Contable.
─────────
13.2 M  salida real en 7 semanas  ≈  1.9 M / semana
```

Si esto se arma sin la clasificación, la gráfica dice que la empresa gasta 5 M
a la semana y está mal desde el primer día.

**Decisión de Fran (19-oct): el cambio de divisas NO entra al flujo.** Mismo
criterio para «Ajuste al Neto».

**Pero los traspasos tienen que verse en un renglón propio.** Si no, saldo
inicial + entradas − salidas no da el saldo final, y una tabla de flujo que no
cuadra contra el banco no la vuelve a creer nadie.

## Qué categorías son las que mandan

Lo que sí es salida, por tamaño en el periodo medido: impuestos 5.8 M, nómina
quincenal 2.1 M, IMSS SIPARE 1.1 M, IVA acreditable de importación 1.1 M,
diversos 726k, nómina semanal 488k, otros gastos 384k, combustible 360k,
comisiones sobre ventas 273k, intereses bancarios 262k, Fonacot 162k, viajes
160k, incrementables y agente aduanal 149k.

Casi todo lo grande es **recurrente y de calendario** —nómina cada quincena,
IMSS mensual, impuestos el 17—, así que la mayor parte del egreso futuro se
proyecta sin capturar nada.

## Cómo se debe ver

**Tabla**, 52 columnas (semanas ISO, lunes a domingo), 5 renglones: saldo
inicial, entradas, salidas, traspasos, saldo final.

**Dos monedas separadas más un consolidado al TC del día.** Con 238 mil dólares
en caja —más de la mitad del efectivo— mezclarlos a un solo tipo de cambio
esconde la exposición cambiaria.

**Gráfica**: barras de entradas hacia arriba, salidas hacia abajo del eje, y la
línea del saldo final encima. Las barras explican por qué se mueve; la línea es
lo que se decide. Línea vertical en "hoy": real en sólido a la izquierda,
pronóstico punteado a la derecha. **Real y pronóstico nunca del mismo color.**

**Arriba de todo, el valle**: _«semana más baja: S11, −1.8 M»_. Un año que
cierra en positivo puede tocar negativo en marzo, y esa semana es la que
quiebra.

## El pronóstico — dos motores, no uno

**Recurrente.** Nómina, IMSS, impuestos, intereses. Calendario puro, se proyecta
solo. Es la mayor parte de la salida.

**Proyectos.** Las dos reglas de Fran, con las definiciones que cerró el 19-oct:

1. **30% al llegar el equipo a nuestro almacén.** El disparador es la ETA que
   compras ya captura en la OC (`cf_fecha_estimada_a_almacén_IS`). No requiere
   captura nueva. Limitación aceptada a propósito: esa fecha es semanas después
   del embarque real, así que el cobro se reconoce tarde. Conservador, no
   optimista — para flujo es el error correcto.
2. **Finiquito al ~80% de avance.** Falta definir contra qué reporte se mide. El
   avance por material entregado ÷ diseñado de IS-PMT es el proxy objetivo
   disponible hoy.

**La base del cobro, regla de Fran:** concepto 1 (SUMINISTRO E INSTALACIÓN) sin
IVA × porcentaje × 1.16. **Ya está calculada**: `iso3-contratado-2026` guarda
`instSinIva` por orden de venta. No hay que derivar nada.

```
cobro = instSinIva × % × 1.16
```

Ese blob se corrió a mano el 10-oct y **no tiene cron** — para pronosticar tiene
que refrescarse solo.

## Orden de construcción

1. **`gastos-sync`** — Edge Function nueva + cron. Baja los gastos del año a
   `iso3-gastos-zoho` con categoría, cuenta, moneda y tipo de cambio, marcando
   cuáles son traspaso. Es el único dato que falta.
2. **Cron para `contratado-anio`.**
3. **Pantalla Flujo** — tabla de 52 semanas y gráfica, dos monedas, valle
   marcado. Solo con datos reales.
4. **Pronóstico** — recurrente primero, proyectos después.

Los puntos 1 a 3 no necesitan que nadie capture nada nuevo.

---

## Estado al 04-nov-2026

- **`gastos-sync` escrita y desplegada**, pero **nunca se ha corrido**:
  `iso3-gastos-zoho` no existe. Tiene un modo `{ muestra: true }` que devuelve
  los gastos crudos sin escribir — correrlo primero y verificar los nombres de
  campo antes de confiar en la clasificación.
- **Pantalla Flujo construida** (commit `a68bb64`): 52 semanas, cinco renglones,
  dos monedas más consolidado, valle arriba, gráfica de barras + línea de saldo.
  El saldo se camina hacia atrás desde el saldo real de hoy. Si falta el blob de
  egresos, sale un aviso en vez de una tabla en ceros.
- **Los crons del flujo NO se han creado** (`supabase/cron-flujo.sql`).
  `iso3-contratado-2026` sigue congelado desde el 10-oct.
- **El pronóstico (punto 4) no existe.** Las semanas futuras salen vacías a
  propósito.
