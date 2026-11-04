# Contratado vendido 2026

**10-oct-2026.** Definición de Fran: *el concepto 1 de cada orden de venta — SUMINISTRO E
INSTALACIÓN — más IVA 16%*. Las 389 órdenes de venta 2026 de Books org 809693641 leídas
renglón por renglón, incluidas las cerradas. 0 fallos. **Verificado de forma independiente
por el equipo de Quote Creator**, que encontró un error de exclusión ya corregido (abajo).

## La cifra

| | USD | MXN |
|---|---|---|
| **OBRA** (120 órdenes) | **9,453,036.91** | **3,552,091.95** |
| POSTVENTA (180 órdenes) | 122,529.99 | 2,288,824.95 |

89 órdenes depuradas (garantías llevadas a cero el 9-oct) quedan **fuera del reporte**, no
solo en cero: nunca fueron una venta. 14 de obra, 75 de postventa.

## La regla

> contratado de la orden = subtotal (tal como está) × 1.16
> se excluye la orden cuando el **total del encabezado** es 0

El concepto 1 no se puede leer directo: da **7,635,071 USD**, 1.82 M menos. La causa la
identificó Fran — el link viejo de Innobyte **restaba al concepto 1** el valor de los
materiales que no salían en cero, sin tocar el total. Comprobado:

1. En **65 de 65** órdenes con material con precio, `concepto 1 + material = subtotal`.
2. En **61 de 65**, `total = subtotal × 1.16` al centavo.
3. La firma son concepto 1 en **negativo**: SO-00790 (−3,730.53) y SO-00900 (−2,766.95)
   siguen vivos; SO-00905 salió con la depuración. Nadie captura un suministro e instalación
   en negativo.

El total nunca se movió, así que el subtotal es el contrato.

## El error que encontró Quote Creator

La exclusión de depuradas filtraba por `|subtotal| >= 1`. **SO-01011 QUERENCIA 49
REUBICACIÓN PANELES** tiene subtotal **−173.39** con el total en 0 — su ajuste de −1,342.96
sobrepasó el subtotal — así que el valor absoluto la dejaba pasar y metía **−201.13 USD** a
la cifra de obra. Era además la única orden del archivo donde `subtotal ≠ concepto 1 +
material`, lo que la hacía invisible a la otra validación.

Corregido en v4: el criterio es `total de la orden >= 0.5`. Una venta tiene total positivo;
lo demás está depurado. La cifra de obra USD pasó de 9,452,835.78 (121 órdenes) a
**9,453,036.91** (120).

## No se corrige el dato en Zoho

Las 35 órdenes vivas con el renglón INST comido **están todas cerradas**. Ninguna abierta.
El importe mal repartido —1,236,702 USD + 1,052,905 MXN— está atorado en órdenes cerradas que
no se van a abrir. **Se arregla midiendo, no escribiendo.**

Y dejó de crecer: la última es del **17-ago-2026** y enero concentra 14, consistente con que
el link de Innobyte ya no corre.

SO-01069 CHILENO RE 19 ADECUACIONES **no se toca**: es garantía y ya estaba depurada. Una
recomendación anterior de moverle 73.58 al concepto 1 era incorrecta.

## Dos decisiones de Fran, 10-oct-2026

- **Los ajustes de cierre no se devuelven.** Devolverlos infla postventa MXN de 2.29 a
  **8.30 millones**, resucitando garantías dadas por perdidas. En obra son −80,913 USD /
  −100,555 MXN, el 1%.
- **Las órdenes sin concepto 1 sí cuentan** en el total. Son 20 de obra y 172 de postventa:
  REVISION, GEN, INGENIERIA, ALARMAS. No son contratos de FV pero son ventas.

## Los tres tableros

| | USD obra | contra la cifra |
|---|---|---|
| **contratado-anio** (la definición) | 9,453,037 | — |
| Books / Quote Creator (`total` del encabezado) | 9,401,521 | −51,515 |
| concepto 1 crudo × 1.16 | 7,635,071 | −1,817,966 |

Books y Quote Creator estaban **casi en lo correcto**. Los 51,515 son 6 órdenes, por tres
mecanismos distintos:

| Mecanismo | Órdenes | USD |
|---|---|---|
| Entran sin IVA desde Quote Creator | SO-01127, SO-01077 | 43,972 |
| Concepto 1 exento | SO-00950, SO-00895 | 1,645 |
| Renglones de equipo sin gravar (Zero Rate) | SO-01051, SO-00952 | 5,898 |

## Cómo volver a sacarla

Edge Function **`contratado-anio`** v4 (`supabase/functions/contratado-anio/index.ts`,
commits `aa5253c`, `b62d29a`, `246089f`). Barrido reanudable, ~130 órdenes por corrida de 95s.

```sql
select net.http_post(
  url := 'https://gkoibrjhlqmuiuedrtaz.supabase.co/functions/v1/contratado-anio',
  headers := (select substring(command from 'headers := ''(.*?)''')::jsonb
              from cron.job where jobname = 'oc-zoho'),
  body := '{"anio":"2026","reiniciar":true}'::jsonb,   -- sin reiniciar para continuar
  timeout_milliseconds := 115000
);
```

Progreso y detalle por orden en `adm_kv` → `iso3-contratado-2026`. Repetir hasta
`progreso.pendientes = 0`. Devuelve `contratadoUSD`/`contratadoMXN` (la cifra),
`soloConcepto1*` (el contraste, no para reportar) y `difierenContraEncabezado` (las 6).

Entregable: `contratado-2026-innovacion-solar.xlsx` (Escritorio), 300 órdenes.

## Qué sigue

1. Quote Creator resincroniza `ventas_historico` y concilia orden por orden por la columna OV.
2. Que AdminApp lea esta función en vez de `totDoc()`.
3. Campo de **tipo de venta** en Books (obra / servicio / garantía / interno) — instrucción
   girada a Service App. Hoy la separación obra/postventa depende de la palabra POSTVENTA en
   texto libre, y hay 8 revisiones contadas como obra.
4. `cf_cotizacion`, el endpoint `contratado-publico` y el cron semanal de aviso — pendientes
   del Ok de Fran.

---

_Nota del 04-nov-2026: `iso3-contratado-2026` sigue con la corrida del 10-oct. El cron que lo
refrescaría solo está escrito en `supabase/cron-flujo.sql` pero nunca se creó._
