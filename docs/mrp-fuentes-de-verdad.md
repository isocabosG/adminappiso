# MRP — quién manda sobre cada dato

_24-sep-2026 · Acuerdo entre AdminAppISO e IS-PMT sobre qué sistema es dueño de
qué número. Leer esto antes de "arreglar" una diferencia entre las dos apps:
varias no son errores, son campos que significan cosas distintas._

## El reparto

| Dato | Dueño | Por qué |
|---|---|---|
| Cantidad requerida por obra | IS-PMT (`project_materials`) | Nace en Quote Creator → `sync-bom` |
| Cantidad en camino | **AdminAppISO** | IS-PMT no tiene ninguna cifra de material comprado |
| Existencias físicas | **AdminAppISO** (Zoho) | Único lugar donde se descuenta inventario |
| Fecha de llegada a almacén | IS-PMT (`eta_almacen`) | Allá se puede corregir a mano |
| Estatus de la obra | IS-PMT | Define qué entra al MRP |
| Catálogo de SKU | Zoho, leído por los dos | AdminAppISO 5:00 am, IS-PMT 5:30 |

## `cant_pedida` NO es material comprado

Es la trampa más fácil de este modelo. IS-PMT escribe ese campo cuando alguien
levanta una **requisición de sección o de hito dentro de IS-PMT**. Nunca mira
Zoho. Significa *"esta obra ya pidió esto"*, no *"compras ya lo ordenó"*.

En AdminAppISO se llamaba `pedido` y no se pintaba en ninguna pantalla — pero
con ese nombre era cuestión de tiempo que alguien lo sumara como cobertura de
compra y el MRP dejara de mandar a comprar algo que nadie ordenó. Renombrado a
**`solicitadoEnObra`**.

La cobertura real de compra sale de las OC de Zoho que lee AdminAppISO
(`quantity_yet_to_receive` por partida de OC).

## `eta_almacen` y el campo `eta_origen`

La fecha que ve Jesús es **siempre la de IS-PMT**. La razón no es territorio:
allá una persona puede corregirla con lo que el proveedor confirmó por
teléfono, y eso es mejor información que la promesa del PO.

`sync-eta` la arma por dos caminos, y `eta_origen` dice cuál se usó:

| `eta_origen` | Significa | Cómo tratarla |
|---|---|---|
| `manual` | La capturó una persona | Manda sobre todo |
| `ov` | El PO nombraba esa obra en `reference_number` | Asignada y confiable |
| `sku` | El PO no decía para quién era | **Zona de traslape** — ver abajo |
| `null` | Sin fecha, o el sync no la ha tocado | Se cae a nuestro cálculo |

Cuando varias obras comparten un renglón del MRP, la celda toma la fecha de
mayor jerarquía: `manual` > `ov` > `sku`.

**La zona de traslape.** Un `eta_origen: 'sku'` sale de un PO que no decía a qué
obra iba — o sea, puede ser material de piso que AdminAppISO **ya está contando
como inventario disponible**. Si se toma como apartada para esa obra, el mismo
material se cuenta dos veces. Por eso en pantalla sale marcado con `?` en ámbar
y no asciende a dato duro solo por venir del otro lado.

## El patrón que hay que preguntar siempre

Cuatro bugs en dos días, todos iguales: **un proceso automático encima de una
captura humana, de noche y sin avisar.**

- `sync-bom` pisaba el SKU corregido por compras
- `sync-bom` pisaba la cantidad corregida
- `sync-eta` (cron 7:15 am) pisaba la fecha capturada a mano
- `pull-so` reseteaba el estatus de una obra en curso

Todos resueltos con candados (`sku_locked`, `cant_locked`, `eta_locked`).

**Pregunta adoptada por los dos equipos al conectar cualquier cosa nueva:
¿qué escribe esto que una persona pudo haber corregido a mano?**

## Lo que queda abierto

El motor del MRP **todavía asigna el material en camino usando la ETA del PO de
Zoho**, no la de IS-PMT. Para una partida con `eta_origen: 'manual'` que diga
que llega tres semanas después de lo que prometió el PO, el motor sigue siendo
optimista y puede dar por cubierta una obra que no lo está.

No se cambió a propósito: IS-PMT da la **fecha** pero ninguna **cantidad**, y
sin cantidad no se puede decidir cobertura. Hacerlo a medias sería peor que no
hacerlo — es la lógica que decide qué se compra. Requiere diseño, no un parche.
