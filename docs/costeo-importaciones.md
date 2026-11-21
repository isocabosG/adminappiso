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

## 11. El IGI se ancla a la partida, y se puede quedar huérfano (20-nov-2026)

El IGI es el **único** incrementable que no se captura como un monto: se
captura partida por partida, y el prorrateo lo lee de `incrementable.manual[idDePartida]`.
Ese id es el de la partida, no el SKU.

Si las partidas se vuelven a armar —se desglosa otra vez la factura, se borra
y se recaptura un renglón— los ids cambian y el mapa queda apuntando a ids que
ya no existen. Entonces: el campo **se ve capturado**, el resumen **lo suma**, y
el prorrateo **le asigna cero**.

Pasó en el 6004655. El IGI de 176,253 estaba anclado a `aud6wr8` y `k7vvoqx`, y
la partida viva era `q2e3my5`. Cerrarlo así habría costeado el panel en
**1,527.50 en vez de 1,731.50** — 204 pesos menos en cada uno de 864 paneles,
los 176,253 completos, sin un solo campo en rojo. Se reancló a mano en `adm_kv`
antes de cerrar.

Desde el commit `150cfe8`:
- La captura del IGI **avisa en rojo** cuánto quedó huérfano y ofrece quitarlo.
- El resumen suma **sólo lo anclado** (antes sumaba todo y cuadraba de mentiras)
  y avisa aparte de lo que no entró al costo.
- El cierre levanta un aviso antes de enterrarlo en el promedio.

**Regla:** si se rearman las partidas, el IGI se vuelve a capturar. No se
hereda.

### Revisión de los cinco pedimentos cerrados (20-nov-2026)

| Pedimento | IGI capturado | ¿Anclado? | ¿Entró al costo? |
|---|---|---|---|
| 6002798 · 22-jun | — | — | correcto: ese pedimento **no pagó IGI** |
| 6003534 · 5-ago | 42,354 (3 × 14,118) | **los tres huérfanos** | **NO — se perdió** |
| 6004109 · 23-sep | — | — | correcto: **no pagó IGI** |
| 6004655 · 22-oct | 176,253 | 1 vivo + 2 copias muertas | sí (las copias ya se limpiaron) |
| 6004711 · 2-nov | 31,354 | vivo | sí |

**6003534 quedó mal costeado.** Los 3 SARK30K se costearon en **151,139.90**
cuando el aterrizado real es **165,257.90**: faltan 14,118 por pieza, 42,354 en
total. Diluido en las 82 piezas del promedio, son 516.51 por pieza — el vigente
pasaría de 161,588.36 a **162,104.88**.

**Decisión de Fran (20-nov-2026): se deja así.** No se reescribe el histórico;
la regla nueva aplica al próximo que entre. Es el mismo criterio que ya tomó en
octubre con la familia de paneles (sección 10, punto 6): se corrige conforme
entre cada importación, no de golpe.

### El pedimento trae su propio checksum

El IVA declarado **es** el 16% de (FOB en pesos + flete internacional + DTA +
ICC + IGI). Cuadra en los cinco pedimentos con diferencias de centavos:

| Pedimento | IVA calculado | IVA declarado | dif |
|---|---|---|---|
| 6002798 | 806,292.43 | 806,291 | 1.43 |
| 6003534 | 75,087.01 | 75,087 | 0.01 |
| 6004109 | 4,187.42 | 4,187 | 0.42 |
| 6004655 | 217,707.37 | 217,707 | 0.37 |
| 6004711 | 55,596.52 | 55,584 | 12.52 |
| 6004840 | 50,534.20 | 50,521 | 13.20 |

Despejando al revés sale el IGI implícito, y da el capturado (42,353.95 contra
42,354; 176,250.68 contra 176,253) o cero cuando no se pagó (−8.93, −2.66).

**Ya está programado** (commit del 20-nov): la banda sale en el pie de
Incrementables mientras se captura, en el resumen y en el detalle del pedimento.
Cuando cuadra lo dice en verde; cuando no, dice cuánta base falta y que casi
siempre es el IGI. La tolerancia es `max(100, 0.25% del IVA)`, que cubre el
redondeo del papel —el peor de los seis fue 13.20 pesos— sin tapar un concepto
faltante, que nunca es de centavos. Probado contra los seis pedimentos: pasa los
cinco buenos y marca el 6003534 pidiendo 42,353.95 de base, que son los 42,354
del IGI.

Sirve para dos cosas: **confirma que un IGI huérfano sí se pagó** (así se
comprobó el de 6003534, sin abrir el PDF) y **caza la falta en la captura**,
con números que ya están en pantalla. Alcanza donde el aviso de huérfano no
llega: si el IGI de plano no se capturó, no hay nada huérfano que lo delate —
el único que sabe es el IVA. El ICC del 6004655 enseña el otro lado:
cuadra exacto con 20,023, que es el declarado a TC 18.42 — el costo usa los
20,349 desembolsados, que es la regla de la sección 3. El checksum valida el
pedimento, no el desembolso.

## 12. Precio por watt (20-nov-2026)

El resumen de la importación trae el **aterrizado del módulo entre su potencia**,
en MXN y USD, por SKU y promedio del embarque, más la potencia importada en kWp.
Es el número con el que se compara el mercado: nadie cotiza paneles por pieza.
En el 6004655: 397.44 kWp, **3.76 MXN/W · 0.204 USD/W**.

La potencia **no existe como campo** en ningún lado. Se lee del nombre del
artículo del catálogo (`PANEL SOLAR SUNPOWER PERFORMANCE P7 460W`) o de la
descripción de la factura del proveedor (`Monocrystalline module 460W`). Si no se
puede leer, no se inventa: el renglón no aparece. El filtro de módulo es a
propósito más estrecho que la categoría `Panel` del catálogo, que trae revueltos
combinadores fotovoltaicos, disyuntores de montaje en panel y estructuras para N
paneles.

## 10. Pendientes de este frente
1. Definir/dar de alta **ECUBE60** en Zoho si aplica (vs usar ECLITE60).
2. **Lectura de OCs desde Books** (Edge Function) para llenar la OC automáticamente en vez de a mano.
3. Opcional: exporte nativo **.xlsx** (hoy es CSV, que Excel abre directo).
4. **Validar el archivo antes de extraer:** el extractor debe rechazar un PDF que no traiga encabezado de pedimento y decirlo, en vez de tronar.
5. **Defenderse del pedimento duplicado** — ver sección 2. *Hecho el 19-nov (candado de carga) y el 20-nov (candado de cierre).*
   Los renglones que el doble cierre del 6002798 dejó en la historia **se quedan**: decisión de Fran (21-nov-2026), «los costos están ok». Con la regla de la sección 13 un renglón duplicado idéntico ya no mueve el promedio, así que el daño quedó acotado: el único que sí se desvía es ECUBE60, donde el duplicado le roba peso al embarque caro (242,529.27 contra 248,491.05 de lo medido).
6. **Revisar toda la familia de paneles.** PSP7460 iba 2.1× abajo; **PSP7455 está en 808.61** (43.9 USD para un panel de 455W), mismo patrón. **Decisión de Fran (28-oct): se corrigen conforme entre cada importación**, no todos de golpe. Mientras tanto el inventario de esos SKUs está subvaluado; con 504 piezas de PSP7455 en libros, del orden de 400 mil pesos.
7. **Programar el checksum del IVA** en la captura: si el IVA declarado no es el 16% de (FOB + flete internacional + DTA + ICC + IGI), avisar y decir cuánto falta. Habría cachado los dos IGI huérfanos el día que se capturaron.
8. **El margen del panel NO es una alarma.** Quote Creator jala el costo y le mete un indirecto encima; el 1,750 de Zoho no es precio de venta al cliente.

_Corregido el 04-nov: la escritura del costo a Zoho ya NO es simulada (sección 9), y la llave basura `iso3-catalogo-respaldo-psp7460-20261024` ya se borró._

## 13. El promedio se arma sólo con lo medido (20-nov-2026)

Fran: «el error es considerar la existencia + lo que estamos importando».

Hasta hoy el promedio ponderaba con `existencia`, que **no es un inventario**:
es una foto de Zoho del 31-jul-2026 escrita a mano en la semilla del catálogo
(`CAT_ROWS`, primer commit de la app), más cada pedimento cerrado desde
entonces. No le resta una venta, no le suma una compra nacional y nunca le
vuelve a preguntar a Zoho.

Se vio con PTBG485. La OC era de **936 paneles en dos embarques**: 144 en el
pedimento 6004840 (4-nov) y 792 en el 6004712 (2-nov). La app sumó esas piezas
encima de los 936 que ya traía y ponderó con 1,080, a las que además les había
estampado el costo del embarque chico. Salió **2,284.88** cuando los 936
paneles costaron 1,992,274 — **2,128.50** cada uno. 156.38 de más por panel, y
eso ya se había empujado a Zoho.

Regla nueva: `promedio = Σ(piezas medidas × landed) ÷ Σ(piezas medidas)` sobre
la historia de importaciones de esta app, incluida la que se cierra. Arregla
tres cosas de un golpe:

1. **Amarra con el banco.** El valor del inventario es lo que se desembolsó.
2. **El orden deja de importar.** Con la regla vieja, cerrar el 4712 primero
   daba 2,100.06 y al revés 2,284.88. Ahora da 2,128.50 en cualquier orden.
3. **Una existencia equivocada ya no mueve el costo** — inflada, vieja o
   contada dos veces.

Lo que se deja atrás: las piezas que la app nunca midió adoptan el promedio
medido. Hoy tampoco tenían costo propio: tenían el que les estampó la primera
medición, que es peor, porque es el de un solo embarque.

El cierre avisa cuando la existencia es mayor que las piezas medidas, para que
se vea de dónde sale el promedio y no se confunda con el inventario.

**Y el cierre ya no le suma piezas a la existencia.** El material se recibe en
Zoho cuando llega al almacén; el pedimento se costea después. Sumarle ahí las
piezas del pedimento las contaba dos veces —una al recibirlas, otra al cerrar el
costo—, y eso fue lo que infló el PTBG485 a 1,872 cuando la OC era de 936. El
reparto queda así: **Zoho cuenta piezas, esta app mide costos.**

**Por qué no es el promedio simple.** (2,441.27 + 2,071.62) ÷ 2 = 2,256.45
valuaría los 936 paneles en 2,111,032 contra los 1,992,274 que costaron:
118,758 pesos de valor sin desembolso detrás. El promedio simple sólo sería
correcto con embarques del mismo tamaño; aquí el 85% de los paneles entró al
precio bajo.

## 14. El catálogo se aplica solo, y la existencia la dice Zoho (21-nov-2026)

Fran: «asegura que se estén actualizando en el cron de todos los días».

`catalogo-sync` baja la foto de Zoho a las 5:00 y ahí se quedaba. Dar de alta
los artículos nuevos, adoptar costos y marcar bajas sólo pasaba cuando alguien
se acordaba de picar el botón en Catálogo: así se juntaron **99 artículos sin
dar de alta y 1,073 costos sin adoptar**. Un dato que sólo se actualiza si
alguien se acuerda no es un dato actualizado.

Ahora lo hace el Edge Function `catalogo-aplicar`, a las 6:05, con las mismas
reglas del botón —correrlo a mano y correrlo de madrugada tienen que dar lo
mismo—. No toca Zoho: lee dos blobs de `adm_kv` y escribe un tercero, así que
no puede fallar por cuota.

**Y la existencia ahora la dice Zoho.** Ese campo era un contador: la semilla
del 31-jul-2026 escrita a mano en el código más lo que cada cierre le sumaba —
decía 82 SARK30K donde el almacén tiene 1, y 1,872 PTBG485 donde hay 903. Desde
que el costo dejó de ponderarse con él (sección 13), su único trabajo es decir
cuánto hay, así que se lo pregunta a quien sabe: el `aMano` del inventario
físico que deja `inventario-sync`.

Orden de las sincronías: catálogo 5:00 → OC 5:10 → apartados 5:15 →
costos nacionales 5:20 → inventario 5:40-5:58 → **aplicar 6:05**.

## 15. El resumen vive en la captura, y el pedimento cerrado no lo tenía (20-nov-2026)

El precio por watt salió primero sólo en la sección 6, que vive en la pantalla
de **captura**. Un pedimento ya cerrado abre en otra pantalla —`DetallePedimento`,
que sólo traía las facturas de incrementables y el costo landed— así que el
número no aparecía donde se va a buscar después. Fran, del 6004840: «no salió el
$/watt». No faltaba el cálculo, faltaba la pantalla.

Ahora el detalle del pedimento trae su propia sección de resumen: precio por
watt, la banda del checksum del IVA y, si hay, el aviso de huérfano — también
para los ya cerrados, diciendo que ese dinero no entró al costo con el que se
cerró.

**6004840** (4-nov, 144 × PTBG485): 69.84 kWp, landed 2,441.27 por panel,
**5.03 MXN/W · 0.268 USD/W**. Contra los 3.76 MXN/W del 6004655: el FOB es más
alto (67.90 contra 56.12) y los 83,818 de flete internacional se reparten entre
144 paneles en vez de 864 — 582 por panel contra 303.

## 16. De la cotización, la columna de PESOS (20-nov-2026)

Fran: «todo de la cotización debe leer la columna de pesos».

Las cotizaciones de Perezgrovas traen dos columnas, Dlls y Pesos, y casi siempre
las dos llenas en el mismo renglón. **La de Pesos es la que manda**, porque es la
que se desembolsa — la misma razón por la que el ICC del 6004655 se costea con
los 20,349 de la cotización y no con los 20,023 declarados (sección 3).

El extractor leía «la columna donde estuviera escrito». Con las dos llenas eso es
una moneda al aire: en el 6004880 se trajo el cruce San Diego–Tijuana en dólares
cuando venía en pesos. Guardado así se multiplica por el tipo de cambio.

Ahora:
- El prompt dice que de la cotización **siempre** se lee Pesos, y que un campo
  `...Usd` se llena **sólo** si ese renglón no trae nada en la columna de Pesos.
- Si de todos modos llega un importe en dólares, la app **lo dice** al terminar
  de extraer, nombrando el concepto: un número con el selector en USD se ve igual
  que uno correcto.
