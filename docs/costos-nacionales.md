# Costo promedio de las compras nacionales

_20-nov-2026. Pedido de Fran: «todas las compras con proveedores nacionales,
sacar el costo promedio de sus SKU... abajo de las importaciones»._

Mismo principio que el costeo de importaciones (`costeo-importaciones.md`,
sección 13): **el promedio se arma con lo que dicen los documentos, ponderado
por piezas, y se puede ver de dónde sale.** Sin existencias y sin costos
heredados.

## Qué cuenta como nacional

Todo lo que **no entró por pedimento**. No se adivina por moneda ni por nombre
de proveedor: las OC que amparan una importación están escritas en las partidas
de `iso3-pedimentos`, y ésas se excluyen. El resto es compra nacional.

## De dónde sale el precio

De la **orden de compra** (decisión de Fran, 20-nov-2026), no de la factura del
proveedor. Llega antes y hay muchas más OC capturadas. Si una OC viene en
dólares se convierte con el tipo de cambio de la propia orden; si no lo trae,
ese renglón se salta y se cuenta aparte — meter dólares a un promedio de pesos
es peor que no tener el dato.

## Cómo se junta

El Edge Function `costos-nacionales` barre las OC de los últimos 12 meses y
guarda en `iso3-costos-nacionales` **las compras**, no el promedio:

```
{ fecha, desde, meses, compras: { SKU: [{f, po, q, u, prov}] }, vistas, faltanPorLeer }
```

Guardar las compras y no el promedio permite mover la ventana sin volver a
barrer Zoho, y sobre todo deja ver los renglones detrás de cada número. Un
promedio sin sus renglones es un número que nadie puede defender — es la lección
del PTBG485.

Pide poco y vuelve: los encabezados son baratos (100 por llamada), lo caro es
leer los renglones de cada OC, una llamada cada una. Cada corrida muerde un lote
de 150, se acuerda de lo leído y la siguiente sigue donde quedó. El límite de
Zoho es por organización y por minuto, y lo comparten esta app, IS-PMT y los
demás crons. Cron diario a las 5:20 (`costos-nacionales-520am`), y el botón
**↻ Traer de Zoho** de la sección lo corre en el momento.

## Qué hace la pantalla

Debajo de la lista de pedimentos, en Importaciones. Por SKU: cuántas compras,
cuántas piezas, el promedio ponderado, el costo que tiene Zoho hoy y la
diferencia. Al dar clic en la clave se abren los renglones que forman ese
promedio, con fecha, OC, proveedor, piezas y precio.

**Proponer este costo** no escribe en Zoho: deja el número como
`promedioPendiente` con `origenPendiente: "nacional"`, y se aprueba en
**Catálogo** con el mismo botón que ya se usa para las importaciones. Un solo
escritor hacia Zoho, no dos. Si el SKU ya trae un pendiente de una importación
sin enviar, no lo pisa: avisa.
