# BACK ORDER del MRP — la ventana de 250 OC

_30-sep-2026 el diagnóstico · **6-oct-2026 corregido y desplegado**._

## RESUELTO — 6-oct-2026

El cambio está en producción. `oc-sync` v13, commit `2a26e82`, PR `arreglo-back-order`.

**El barrido ya no para en 250.** Recorre todas las páginas (tope 80 = 8,000 OC)
y el tránsito toma **todas** las abiertas; el historial de proveedores conserva
su ventana de 250, que es para lo que se hizo. Si el barrido se trunca en el
tope, NO se escribe el tránsito y se conserva el del día anterior: un barrido a
medias subestima, que es el bug mismo.

**Corrida de verificación del 6-oct, 11:01 h:**

```
ocTotales 2,839 · páginasLeídas 29 · truncado false
abiertas 90  (antes 69)
abiertasFueraDeLaVentanaVieja 20
SKU en tránsito 214  (antes 209)
frenadas por Zoho 0 · llamadas 119
```

**20 órdenes abiertas no se estaban contando.** El rango del caché pasó de
`PO-02711…PO-02933` a `PO-00128…PO-02940`. La preocupación de que la corrida se
alargara no se materializó: cero frenadas, 119 llamadas.

## La respuesta a la pregunta 2: era captura, no la ventana

Con las OC viejas ya visibles se pudo ver qué traen las dos órdenes que Jesús reclamaba:

```
PO-02015   ECUBE60      4 pzas   llegada estimada 28-sep-2026
PO-02055   ECUBE60      4 pzas   llegada estimada 28-sep-2026
PO-02713   BREHV5KW   160 pzas   llegada estimada 11-ene-2027
PO-02714   ECUBE60     16 pzas
PO-02805   BREHV5KW   160 pzas  ·  ECUBE60  12 pzas
```

En camino: BREHV5KW 320 · BREP16KW 80 · BRELV5KW 40 · ECUBE60 36 · BRC00038 20.
**`BRCHV5KW` y `BPEB2KWH` siguen en cero, y es correcto: no hay ninguna OC abierta
con esos SKU.**

Se confirma la sospecha de Fran del 26-sep: **las compras se dieron de alta como
`ECUBE60` (el rack) y `BREHV5KW`**, separando racks de baterías. Y encima
`BRCHV5KW` y `BREHV5KW` se diferencian en una letra, C contra E — la misma
confusión que produjo el tercer error de diagnóstico de la lista de abajo.

**Hallazgo operativo:** PO-02015 y PO-02055 tenían llegada estimada 28-sep. Al
6-oct llevaban 8 días vencidas, 8 piezas de ECUBE60. Eso es lo que la app tapaba
al no verlas.

## Lo que sigue abierto

1. **¿El "96 por recibir" que ve Jesús es de `BRCHV5KW` o de `BREHV5KW`?** Una
   letra de diferencia, y BREHV5KW sí tiene 320 en camino.
2. **¿Las baterías se compran como `ECUBE60` y se desglosan al recibir?** Si la
   respuesta es sí, no hay error en ningún lado: hay dos SKU para la misma cosa
   física, y el MRP los va a seguir viendo como artículos distintos hasta que se
   decida cuál manda.
3. **El alcance por almacén**: `oc-sync` no filtra por almacén destino mientras
   `comprometido-sync` sí, así que STOCK FINAL mezcla un término global con dos
   de almacenes propios. Arreglarlo hace **bajar** números, por eso va solo y
   avisado — si entra junto con otro cambio, compras ve subir una cosa y bajar
   otra el mismo día y no sabe a cuál creerle.

## Efecto lateral: la barra de preguntas mentía por omisión

El 5-oct Jesús preguntó por PO-02015 y PO-02055 en la barra. Contestó que **no
existían** y ofreció tres hipótesis: que estarían cerradas, que el número sería
de otro sistema, que habría un error de captura. Ninguna era cierta — leía el
mismo caché recortado.

Corregido en `cee907c` (`preguntar` v5): la herramienta de órdenes de compra
devuelve `alcanceDeEstaFuente` (de qué OC a qué OC) y, cuando preguntan por un
número fuera del rango, lo dice en vez de callarlo. Y la regla 2b del prompt:
*"no lo encuentro" no es "no existe"; prohibido ofrecer hipótesis de por qué
falta; quien pregunta conoce su operación mejor que el buscador.*

Mandar a compras a buscar un PDF para resolver un problema que no era suyo es
peor que no contestar: le quita la razón para creerle a la app.

## El diagnóstico original (30-sep)

Dos de las tres columnas ya estaban bien: POR SURTIR y STOCK AL DÍA coinciden
con las existencias físicas, y el STOCK FINAL reproduce el "Disponible para la
venta" que Zoho calcula (−8 en BPEB2KWH, 0 en BRCHV5KW) sin que nadie lo
programara para eso. Toda la discrepancia estaba en BACK ORDER.

La fórmula por renglón era correcta —`quantity − received − cancelled`—. El
problema era el universo: `MAX_OC = 250` se puso para reconstruir el historial
de proveedores sin saturar a Zoho y quedó limitando también el tránsito.
**Son dos cosas distintas: el historial aguanta una ventana, el material en
camino no.**

## Errores de diagnóstico que se cometieron en el camino

Los tres son la misma falla con distinto disfraz: **dar por buena una explicación
antes de probarla contra todos los casos.**

- Se propuso `disponible contable − disponible física` como equivalente de
  "Cantidad por recibir". Acertó en BRCHV5KW (96) y BREHV5KW (320) y **falló en
  BPEB2KWH** (−36 contra 66 real). Descartada.
- Se levantó una alarma por "588 piezas facturadas sin entrada registrada".
  **Falsa:** las existencias contables son el acumulado histórico y no aportan al
  conteo de inventario (lo corrigió Fran).
- Se atribuyó "Cantidad por recibir = 320" a BRCHV5KW cuando ese 320 era de
  BREHV5KW. La misma confusión de una letra que explica el caso completo.

---

_Nota del 28-oct-2026: nada avisa cuando una OC pasa su ETA. Medido ese día: **12
órdenes llevan más de un mes vencidas** y el MRP las sigue contando como material
en camino — PO-00160 lleva 865 días, PO-00128 805, PO-00946 634. Inflan el BACK
ORDER. Más 35 órdenes vencidas en los últimos 30 días con 6,972 piezas._
