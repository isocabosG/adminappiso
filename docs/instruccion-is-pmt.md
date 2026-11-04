# Para IS-PMT — lo nuestro

_23-oct-2026_

**El proyecto nace solo con equipos.** Se jalan de la orden de venta de Zoho y
ahí se queda hasta que ISO Engineering suba el BOM.

## Pendientes, en orden

**1. Apagar `sync-bom`, o acotarlo a equipos.** Hoy jala el material de la
cotización a `project_materials`. Mientras siga corriendo, la app recibe la
lista de la cotización por la puerta de atrás y seguimos con dos orígenes.

> Este interruptor se jala **al final**, cuando ingeniería ya esté entregando:
> si se apaga antes, las obras nuevas quedan sin material y nadie puede
> trabajar.

**2. Banner «nuevo BOM disponible — revisar en el proyecto»**, también en la
lista de proyectos y en el correo diario.

**3. Pantalla de revisión del BOM** contra lo que hay, y botón «Cargar a Zoho»
como un solo acto con vista previa. Las tres piezas ya existen y están probadas.

**4. Los tres huecos del importador:**

- el hito y el sistema no se actualizan en una partida que ya existe;
- lo que entra por archivo se marca `cotizacion` en vez de `ingenieria` y por
  eso no queda protegido;
- da de baja lo que alguien agregó a mano, que `sync-bom` sí respeta.

---

_Las apps se hablan entre ellas; Zoho es el libro donde queda asentado lo que
pasó, no el lugar donde se decide nada._
