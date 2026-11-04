# Para ISO Admin — control presupuestal por proyecto

_23-oct-2026_

Al cerrar una obra, ISO Admin calcula su **utilidad real**. Es el único lugar
donde se compara lo cotizado contra lo que pasó, y por eso se hace una vez, al
final, y no todos los días en la app de obra.

## Cuatro insumos

**De Zoho** — lo que de verdad se surtió, equipos y materiales, contra la orden
de venta. Y el precio de venta, que vive completo en el concepto de suministro
e instalación; el material va todo en $0, así que **no lo sumen como costo
desde ahí**.

**De IS-PMT** — los días trabajados y quiénes trabajaron en ese proyecto. La
app lleva asistencia por obra y por día, con la persona y la cuadrilla, más las
fechas reales de inicio y término. Eso es lo que convierte la mano de obra en
un número y no en una estimación.

**De ISO HR** — el sueldo de cada colaborador, para costear esos días.

**El resultado** — costo de material surtido + mano de obra real, contra el
precio de venta. Eso es la utilidad del proyecto, y es lo que hoy nadie tiene.

## Dos notas de diseño

**La comparación contra la cotización original también vive aquí**, no en
IS-PMT — es información para medir margen y nadie la acciona en campo.

**El universo de órdenes sale de Zoho, no de la base local.** Una obra marcada
terminada en la app puede tener su orden todavía abierta, y una orden sin
proyecto amarrado es invisible desde la app. Ya pasó: en la revisión del 24-sep
salieron 9 órdenes que Zoho tenía y la app no.

---

_Las apps se hablan entre ellas; Zoho es el libro donde queda asentado lo que
pasó, no el lugar donde se decide nada._
