# MRP de compras — el formato de Jesús, conectado

_26-sep-2026. Reemplaza al MRP anterior, que quedó en la pestaña "MRP detalle"._

## Qué es

Réplica de la hoja de Excel que compras ya usaba, con los mismos nombres de
columna y la misma fórmula, pero leyendo de Zoho en vivo. **No filtra nada**:
salen los ~2,307 SKU del catálogo completo, tengan o no movimiento. La decisión
de compra se toma mirando el total, no una selección que alguien hizo antes.

```
STOCK FINAL = BACK ORDER + STOCK AL DIA − POR SURTIR
```

## De dónde sale cada columna

| Columna | Qué es | Fuente | Sincronía |
|---|---|---|---|
| SKU · DESCRIPCION | catálogo completo | `iso3-catalogo-zoho` | 5:00 |
| BACK ORDER | pedido y no recibido | `iso3-mrp-oc-cache-v2` | 5:10 |
| POR SURTIR | apartado en órdenes de venta abiertas | `iso3-comprometido-ov` | 5:15 |
| STOCK AL DIA | existencia física en los almacenes propios | `iso3-inventario-fisico` | 5:40 |
| Meses | el mismo POR SURTIR, repartido por fecha de instalación | los dos de arriba + feed IS-PMT | — |
| QTY | captura de Jesús | `iso3-mrp-qty` | ninguna la pisa |

Los meses son columnas que se prenden y apagan. Salen del **mismo número** que
POR SURTIR, no de otra fuente, así que siempre cuadran contra el total — que es
lo que en el Excel ya no pasaba, porque `Hoja5` se pegaba a mano y envejecía
aparte.

Lo que no tiene obra calendarizada cae en **SIN FECHA** y sigue contando en POR
SURTIR. Un requerimiento sin fecha sigue siendo material que hay que comprar.

## Dos errores de fondo que salieron el mismo día

Los dos los encontró Fran mirando renglones que no le cuadraban, no revisando
código. Los dos se veían perfectamente normales en pantalla.

**El back order contaba como pendiente lo ya recibido.** `oc-sync` leía
`quantity_yet_to_receive` por renglón, y ese campo **no existe a nivel renglón**
— solo en el encabezado de la orden. Al no encontrarlo caía al respaldo y tomaba
la cantidad completa. Toda orden parcialmente recibida inflaba el tránsito.
Detectado con M00163: decía 50 en camino cuando las 50 se recibieron el 22-sep.
Ahora: `pedido − recibido − cancelado`, y los renglones de flete se excluyen.

**Las existencias sumaban todos los almacenes.** Zoho tiene diez: RMA (lo que se
devuelve al proveedor), Devolución, Desecho, Semi-OK, Laboratorio, Coordinación y
dos de importación en San Diego. SARK30K tenía 15 globales: 9 en Central y 6 en
RMA — seis inversores apartados para devolver, contados como vendibles. Ahora
todo sale de `warehouses[]`, que **solo viene en `get_item`**, no en el listado.
De ahí que el inventario tarde varias vueltas.

## Zoho no reporta el comprometido que sirve

`actual_committed_stock` viene en cero o nulo para todo el catálogo. Por eso
Jesús armaba la hoja *Exist Comp* a mano desde las órdenes de venta.

`comprometido-sync` hace eso mismo, en vivo: recorre las órdenes abiertas
(`order_status !== 'closed'`, `status !== 'void'`) y por cada renglón de
inventario calcula `cantidad − entregado`. Verificado renglón por renglón contra
SO-00069. El renglón de "suministro e instalación" es un servicio y no aparta
nada, aunque se lleve todo el precio de la orden.

El universo sale de **Zoho**, no de los proyectos locales: en IS-PMT eso daba 91
órdenes cuando Zoho tenía 124 abiertas.

## El MRP se audita solo

`inventario-sync` guarda también el `available_for_sale` que calcula Zoho. El MRP
compara su propio `STOCK AL DIA − POR SURTIR` contra ese número y marca con **▲
ámbar** los renglones donde no coincidan.

La comparación va **sin** el back order a propósito: Zoho no sabe de órdenes de
compra en camino. Las dos cifras contestan preguntas distintas —

| | Pregunta |
|---|---|
| Zoho | ¿Cuánto puedo vender hoy? |
| MRP | ¿Cuánto me va a faltar cuando llegue lo que ya pedí? |

Existe porque el error del back order llevaba horas en producción y se veía
normal. **Ahora hay un segundo número que tiene que dar lo mismo.**

## Pendientes

- La pestaña Inventario sigue calculando en el navegador y escribiendo en la
  misma llave que el cron. Se le puso la regla de no publicar con más del 2% de
  huecos, pero lo correcto es que lea el blob y no recalcule.
- El MRP anterior quedó en "MRP detalle" (ETA por SKU, proveedor sugerido, liga
  al proyecto). Decidir si se conserva o se quita.

---

_Notas posteriores:_
- _18-oct-2026: se agregaron las columnas **PIDE OBRA** (lo que las obras piden según
  IS-PMT) y **DIF** (PIDE OBRA − POR SURTIR). Son dos fuentes distintas y **donde no
  coinciden está el material que va a faltar**. También la lista de SKUs fuera del MRP,
  con candado: si una obra pide un SKU excluido, vuelve a aparecer._
- _28-oct-2026: el material de POSTVENTA entra a POR SURTIR pero nunca a PIDE OBRA,
  porque vive en ISO Service y ese feed no existe. 75 SKUs con DIF negativo permanente
  que parece error y no lo es._
- _03-nov-2026: STOCK AL DIA pasó a sumar **Almacén Central + Almacén Logístico**._
