# AdminAppISO — Costeo de importaciones: lógica de sistemas, prorrateo y OCs
_Actualizado: 04-nov-2026. Referencia para el equipo y para retomar el desarrollo._

## 1. Regla de sistemas (kits) vs SKU único
- **XTREME HV y XTREME LV** se importan como **sistemas que SÍ se desglosan**: cada sistema = **4 baterías + 1 módulo de control**. En el pedimento la partida indica el **# de sistemas**; en la factura aparecen como **total de baterías + total de módulos de control**.
  - HV: batería **BREHV5KW** + control **MC050**
  - LV: batería **BRELV5KW** + control **MC300**
- **Xcellent Plus (BREP16KW), ECube60 (ECUBE60), ECLite60 (ECLITE60), MPack233 y demás** = **sistemas completos**, entran como **UN SOLO SKU** (no se desglosan). Las baterías/racks de ECube (BRCHV5KW, RKBR5KHV) existen como SKU aparte **solo para pedir módulos/refacciones a futuro**, no para la importación del sistema.
- En la app, el botón **"🧩 Desglosar por factura"** sigue esta regla automáticamente.

## 2. Mapeo del pedimento 26 40 3965 6002798
| OC Books | Factura Renon (USD) | Partida pedimento | SKUs resultantes |
|---|---|---|---|
| 2052 | RN-26012201JFA (72,437.94) | 1 · XTREME HV (18 sist.) | 72× BREHV5KW + 18× MC050 |
| 2053 | RN-26012202JFA (69,933.15) | 4 · XTREME LV (21 sist.) | 84× BRELV5KW + 21× MC300 |
| 2054 | RN-26012203JFA (35,414.00) | 5 (20) | 20× BREP16KW |
| 2015 | RN-26011301JFB (50,304.08) | 2 · ECube (4) | 4× ECUBE60 |
| 2055 | RN-26012204JFA (50,304.08) | 3 · ECube (4) | 4× ECUBE60 |

- **Vínculo factura ↔ partida:** valor USD de la factura × TC del pedimento (17.3688) = valor en pesos de la partida. **Cada factura = una OC de Books.**
- FOB total = 278,393.25 USD (suma de las 5 facturas), cuadra con el pedimento.
- **OJO:** este pedimento está grabado DOS VECES en `iso3-pedimentos`, idéntico, con sus 7 partidas cada uno. De ahí salen las entradas duplicadas de historia del MC050. El módulo no se defiende de guardar el mismo pedimento dos veces.

## 3. Prorrateo (método)
- **TODO se reparte por VALOR FOB** (verificado contra el Excel del equipo, Hoja1). Cada SKU toma su % del FOB total y ese **mismo %** aplica a **todos** los incrementables, **incluidos los fletes**. **No por peso.**
- **El IVA de importación NO capitaliza** (es acreditable) — queda fuera del costo.
- Mapeo columnas del Excel (Hoja1) → conceptos de la app:
  - HON ADU = Honorarios + servicios agente (Perezgrovas)
  - CRUCE SD-TJ = Cruce San Diego → Tijuana (Perezgrovas)
  - OTROS INCREM = Cuenta de Gastos Americana (ICC)
  - FLETE TJ-CSL = Flete Tijuana → Los Cabos (Tres Guerras)
  - FLETE CA-SD = Flete internacional origen → San Diego (Fleischer)
  - DTA, PRV, IGI = del cuadro de liquidación del pedimento
- Landed: **COSTO CSL MXN** = total ÷ cant; **COSTO CSL USD** = CSL MXN ÷ TC.

## 4. Órdenes de compra (OC)
- Cada factura corresponde a **una OC de Books**.
- Desde el 26-oct-2026 la app acepta la **OC como tipo de documento**: adjuntarla deja que el extractor copie el SKU exacto (la factura del proveedor no lo trae; la OC sí, como `SKU : XXXX`). Antes se adivinaba con IA contra el catálogo.

## 5. Catálogo — SKUs confirmados
BREHV5KW (bat. EXTREME HV) · MC050 (control HV) · BRELV5KW (bat. EXTREME LV) · MC300 (control LV) · BREP16KW (XCELLENT PLUS 16KWH) · ECLITE60 (ECUBE LITE 60KWH) · RKBR5KHV (rack ECube) · BRCHV5KW (bat. ECube).
- **PENDIENTE:** **ECUBE60 no está sembrado** en el catálogo de la app (solo ECLITE60).

## 6. Cambios de agosto 2026
- **Fix de extracción:** FOB unitario correcto (precio pagado ÷ TC ÷ piezas); incrementables del pedimento forzados a MXN; lectura de cruce SD-TJ y honorarios desde la cotización Perezgrovas.
- **max_tokens 5,000 → 16,000** (arregla el corte "motivo: max_tokens").
- **🎯 Auto-asignar SKUs** por IA, apoyado en costo; popup solo para dudosos.
- **🧩 Desglosar por factura** y **prorrateo por valor FOB** como default, con exporte CSV y OC editable por renglón.

## 7. Caso PSP7460 — pedimento 26 40 3965 6004655 (oct 2026)

**Qué pasó.** Jesús reportó "en la App marca error" y actualizó el costo a mano en el catálogo de Zoho. El error no era de costeo: era que `window.aiExtract` tiraba `new Error(data.error)` con `data.error` siendo un objeto `{type, message}`, así que Importaciones mostraba `No se pudo leer el PDF automáticamente: [object Object]` y escondía el motivo real — **saldo agotado de la API de Anthropic**. Arreglado en commit `0fc3a92` con `textoError()`, aplicado en los 9 helpers de `main.jsx`. Créditos recargados, auto-reload encendido, y verificado de punta a punta el 24-oct.

**Segunda causa, independiente.** Jesús etiquetó mal los archivos: marcó como *Pedimento* el `COTIZACION OTROS 6004655.pdf` (la cotización de Perezgrovas, sin partidas), cuando el pedimento real venía en el archivo que la agencia nombró `PROFORMA 6004655.pdf`. Aunque hubiera habido créditos, la extracción fallaba.

**Datos del pedimento (verificados contra el PDF):**
- TC oficial **18.42000** · valor aduana 1,175,018 · precio pagado 893,143 · peso bruto 19,824.22 kg · 24 bultos
- Proveedor TCL Zhonghuan, factura TCL260908-03, FCA, 48,487.68 USD, 864 paneles a 56.12 USD
- IGI 176,253 = **15% exacto del valor aduana** · DTA 9,400 (8 al millar) · PRV 330 · IVA 217,707 (acreditable, fuera del costo)
- Un solo pedimento, una sola factura: el 100% de los fletes es atribuible a los paneles

**Landed:** 1,496,338.17 MXN ÷ 864 = **1,731.87 MXN/panel** = 94.02 USD = 0.204 USD/W. La aritmética de Jesús cuadró al centavo.

**Decisión de Fran (opción A):** fijar 1,731.87 para los 1,022 paneles, **no** promediar contra el costo anterior. Razón: el `costoVigente` previo era **817.40** — equivalente a 44.37 USD, por debajo del EXW actual de 56.12 y sin flete ni aduana. No era un costo aterrizado sino un precio FOB viejo capturado a mano, y promediarlo habría metido basura (habría dado 1,590.49).

**Impacto:** +914.47 por panel. 144,486 MXN en el valor de inventario, y 789,188 MXN de costo de material que antes no se reconocía, repartido en 10 proyectos vivos (COSTA PALMAS BFV 11 y 12, CHILENO HV 303, CHILENO GE 26, CHILENO 101 EXPANSION, QUERENCIA COLINAS 2 EXP., PALMILLA OASIS 1, REMANSO 9, THE COMMONS ARROYO CLUB, PALMILLA OCEANO BAJA 14).

**Lo que NO se afectó:** las cotizaciones al cliente. Quote Creator toma el costo de Zoho, que sí andaba cerca del correcto (1,750). No se vendió barato; se midió mal el margen.

**Diferencias menores, sin efecto en la decisión:**
- *Otros incrementables:* la hoja usó 20,349 (ICC 1,087 USD a TC 18.72, el de la cotización); el pedimento declara 20,023 (mismo USD a 18.42). 326 pesos. Para costo manda lo desembolsado. Jesús lo atribuyó a un acumulado por reconocimiento aduanero.
- *Saldo a favor 9,994* en la cotización de Perezgrovas: el total a terceros era 32,479 pero sólo se desembolsaron 22,485. No cambia el costo; **sí cambia el flujo de efectivo**.

## 8. Mejoras del 26-oct-2026 (commit `2faa126`)
Las tres que pidió Jesús después de cerrar el caso:
1. **OC como tipo de documento** — ver sección 4.
2. **Peso bruto.** El prompt afirmaba que `CANTIDAD UMT = KILOS`. Es cierto sólo cuando el UMT de esa fracción es de peso; para la 8541.43 el UMT es PIEZAS, así que las 864 piezas se colaban a la columna de kilos ("1.00 kg c/u"). Ahora sólo se toma si el código UMT es de peso, y con una sola partida cae al PESO BRUTO del encabezado. **No cambia ningún costo:** el prorrateo reparte por valor FOB.
3. **Descripción del catálogo** cuando hay SKU, aplicada en los **cuatro** caminos que lo asignan (extracción, auto-asignar, captura manual, desglose por factura) — arreglarlo sólo donde se notaba lo habría dejado reaparecer por los otros tres.

## 9. El paso para mandar el costo a Zoho
No está dentro de Importaciones, y por eso cuesta encontrarlo:
1. Se **cierra el pedimento** en Importaciones → la app calcula el promedio ponderado y lo deja como `promedioPendiente` en el SKU.
2. Se va a la pantalla de **Catálogo**, donde aparece el SKU con su costo pendiente y el delta contra el vigente.
3. Desde ahí se manda a Zoho. **Esa escritura es real** — pega al Edge Function `zoho-write`. Al confirmar Zoho, el pendiente pasa a vigente y queda sellado el "Último envío a Zoho" con fecha y monto.

## 10. Pendientes de este frente
1. Definir/dar de alta **ECUBE60** en Zoho si aplica (vs usar ECLITE60).
2. **Lectura de OCs desde Books** (Edge Function) para llenar la OC automáticamente en vez de a mano.
3. Opcional: exporte nativo **.xlsx** (hoy es CSV, que Excel abre directo).
4. **Validar el archivo antes de extraer:** el extractor debe rechazar un PDF que no traiga encabezado de pedimento y decirlo, en vez de tronar.
5. **Defenderse del pedimento duplicado** — ver sección 2.
6. **Revisar toda la familia de paneles.** PSP7460 iba 2.1× abajo; **PSP7455 está en 808.61** (43.9 USD para un panel de 455W), mismo patrón. **Decisión de Fran (28-oct): se corrigen conforme entre cada importación**, no todos de golpe. Mientras tanto el inventario de esos SKUs está subvaluado; con 504 piezas de PSP7455 en libros, del orden de 400 mil pesos.
7. **El margen del panel NO es una alarma.** Quote Creator jala el costo y le mete un indirecto encima; el 1,750 de Zoho no es precio de venta al cliente.

_Corregido el 04-nov: la escritura del costo a Zoho ya NO es simulada (sección 9), y la llave basura `iso3-catalogo-respaldo-psp7460-20261024` ya se borró._
