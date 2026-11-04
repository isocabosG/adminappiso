# Para Quote Creator — cambio en el proceso de confirmar proyecto

_23-oct-2026_

Tu proceso queda igual, con un solo cambio: al confirmar el proyecto, la orden
de venta en Zoho se crea solo con los **EQUIPOS** y el concepto de suministro e
instalación. **Ya no subas el material de instalación.**

Equipos son los que el cliente compró y firmó: paneles, baterías, inversores,
generadores y la estructura. El material de instalación —cable, taquetes,
tornillería, cinta, conectores— ya no va en la orden: vive dentro del concepto
contratado y lo va a cargar IS-PMT cuando ingeniería entregue el BOM real.

El despiece de la cotización no se tira: se lo entregas a **ISO Engineering**
como punto de partida de su cálculo. Ellos lo ajustan contra el diseño final y
el resultado es el que entra a la app de obra.

**Por qué:** el 7-oct medimos la SO-01098 y de 84 renglones de la cotización,
49 sobraban, 19 faltaban y 14 eran sustituciones de calibre. La cotización se
hace para vender; el BOM se hace cuando ya se sabe qué se va a instalar. Tener
los dos escribiendo en la orden es lo que nos ha costado la semana entera.

## Dos cosas más

**Hay que definir qué cuenta como equipo.** Zoho ya trae el campo
`cf_tipo_de_material` en cada artículo, pero es más ancho de lo que parece: en
las órdenes que revisamos dice «Equipos» también en gabinetes, interruptores y
bloques de distribución. Revisen sus valores antes de usarlo como filtro, o la
orden va a nacer con medio tablero eléctrico.

**Quote Creator está emitiendo claves que Zoho ya dio de baja.** Se encontraron
cuatro —`APL00014`, `APL00038`, `APL00516` y `NDR12024`— en 72 renglones de 30
obras vivas, todas con `source: quote`. Son claves inactivas en el catálogo:
compras no las puede pedir y almacén no las puede surtir. Hay que validar
contra `activo = true` antes de emitir.

> **Nota del 23-oct, medida contra Zoho:** las cuatro ya se limpiaron de las
> órdenes vivas el 19-oct — hoy ninguna tiene material apartado, y de los 102
> SKU inactivos del catálogo ninguno está apartando nada. La validación sigue
> haciendo falta: sin ella nada impide que vuelvan a entrar, y limpiarlas a
> mano cuesta una revisión orden por orden.

---

_Las apps se hablan entre ellas; Zoho es el libro donde queda asentado lo que
pasó, no el lugar donde se decide nada._
