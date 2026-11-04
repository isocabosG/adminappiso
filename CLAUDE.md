# AdminAppISO — reglas de trabajo para Claude

**App:** AdminAppISO (compras, costeo de importaciones, inventario, tesorería, control presupuestal, flujo de efectivo) · **Repo:** `isocabosG/adminappiso` · **Supabase:** `gkoibrjhlqmuiuedrtaz` · **Deploy:** Vercel automático al empujar a `main` · **URL:** https://adminappiso.vercel.app · **Zoho Books org:** `809693641`

Este archivo es la memoria de la app. **La fuente de verdad es el repo y la base, no lo que recuerde un chat.** Si algo aquí contradice al código, el código gana y este archivo está mal: corrígelo.

Lee este archivo completo y la bitácora antes de tocar nada. El **por qué** de cada regla es la parte que importa: casi todas existen porque algo ya salió mal una vez.

---

## 1 · Qué hace y quién la usa

Es la app de administración de Innovación Solar. Siete pantallas:

| Pantalla | Qué resuelve |
|---|---|
| **Proyectos** | Ficha por obra: contratado, pagos, cobranza, control presupuestal, ajuste por cierre |
| **Costos** | Catálogo de artículos con el costo vigente y el promedio pendiente de mandar a Zoho |
| **Importaciones** | Costeo de pedimentos: extrae el PDF con IA, prorratea por valor FOB, calcula el promedio ponderado |
| **Inventario** | Existencias físicas y el reporte mensual que se entrega a contadores |
| **MRP** | El formato de compras de Jesús, leyendo Zoho en vivo |
| **Tesorería** | Saldos de banco y movimientos capturados |
| **Flujo** | Flujo de efectivo semanal, 52 semanas, leído de Zoho sin capturar nada |

Más la **barra de Preguntar** (IA, arriba y siempre visible) y **Usuarios** para quien administra accesos.

### Quién la usa

- **Fran** (`fvargas@innovacionsolar.com`) — dueño del producto. Nada se empuja a producción sin su Ok.
- **Jesús Miranda** (`admin@innovacionsolar.com`) — administración, compras e importaciones. Es el usuario principal del MRP, de Importaciones y de Inventario.
- **Constanza Bueno** — gerente general.
- Cobranza y operación — consulta.

### Roles

Viven en `public.profiles`. El rol gobierna qué pestañas se ven; las banderas gobiernan permisos.

| Campo | Qué hace |
|---|---|
| `role` | `operacion` (default, 4 usuarios) · `cobranza` (1 usuario) |
| `admin_accesos` | Ve la pestaña **Usuarios** y puede cambiar roles |
| `puede_ajustar` | Puede aplicar el ajuste por cierre de proyecto |
| `es_super` | Superusuario |
| `protegido` | No se le puede quitar el acceso desde la app |
| `activo` | Si es falso, no entra |

**`PESTANAS_POR_ROL` en `App.jsx`:** un rol que NO esté en esa tabla ve todas las pestañas. Agregar un rol ahí es QUITAR, nunca dar. `SOLO_LECTURA` hoy tiene `cobranza`.

**La pestaña de Usuarios NO la gobierna el rol, la gobierna `admin_accesos`.** Si la gobernara el rol, ponerse un rol restringido borraría la pantalla desde donde se cambian los roles, y el único super se quedaría encerrado sin nadie que pudiera devolvérselo.

> **Esconder una pestaña es comodidad, no permiso.** Mientras `adm_kv` siga sin RLS, cualquier cuenta con sesión puede leer los mismos datos desde la consola del navegador. El permiso de verdad es el RLS; esto es la puerta, no la cerradura.

---

## 2 · Infraestructura

| Pieza | Valor |
|---|---|
| GitHub | `https://github.com/isocabosG/adminappiso.git` · rama única `main` |
| Supabase | proyecto `gkoibrjhlqmuiuedrtaz` |
| Vercel | despliegue automático al empujar a `main` |
| URL | `adminappiso.vercel.app` |
| Zoho Books | organización `809693641` |
| Carpeta en la Mac | `~/Desktop/adminappiso` |
| Build | Vite 5 + React 18 |

### Crons (`pg_cron` + `pg_net`)

**Los Cabos es UTC−7 todo el año, sin horario de verano.** La hora UTC del cron es la local + 7.

| Job | Cron (UTC) | Hora local | Qué hace |
|---|---|---|---|
| `respaldo-kv-3am` | `20 10 * * *` | 3:20 am | Volcado de respaldo de `adm_kv` |
| `catalogo-zoho-5am` | `0 12 * * *` | 5:00 am | Catálogo de artículos → `iso3-catalogo-zoho` |
| `oc-zoho` | `10 12 * * *` | 5:10 am | Órdenes de compra → `iso3-mrp-oc-cache-v2` |
| `comprometido-zoho` | `15 12 * * *` | 5:15 am | Comprometido por OV → `iso3-comprometido-ov` |
| `inventario-zoho` | `40,43,46,49,52,55,58 12 * * *` | 5:40–5:58 am | Existencias físicas → `iso3-inventario-fisico` |
| `proyectos-zoho` | `25 */3 * * *` | cada 3 h | Proyectos → `iso3-proyectos-cache` |
| `aviso-cobranza-10am` | `0 17 * * *` | 10:00 am | Correo de cobranza |

**Por qué ese orden.** El límite de llamadas de Zoho es **por organización** y lo comparten esta app, IS-PMT y todos los crons. El proceso de IS-PMT corre a las 5:30; el inventario va DESPUÉS a propósito, porque si los dos barren al mismo tiempo se frenan entre sí.

**El inventario corre en tramos** porque son ~2,300 llamadas y no caben en una sola invocación. Procesa un tramo, guarda el avance en `iso3-inventario-parcial` y se sale; la siguiente invocación sigue donde quedó. El blob bueno **sólo se escribe cuando el recorrido termina completo**: si una corrida se corta, el inventario sigue siendo el de ayer — viejo pero íntegro, en vez de nuevo y a medias.

**Ningún cron lleva la `service_role` escrita.** Los jobs nuevos heredan los headers del job `oc-zoho` con `substring(command from 'headers := ''(.*?)''')`. Así la llave vive en un solo lugar y rotarla es corregir un job, no siete. El SQL de los crons está en `supabase/cron-sincronias.sql`, `supabase/cron-catalogo.sql` y `supabase/cron-flujo.sql`.

**Faltan por crear:** `gastos-zoho` y `contratado-anio` (están escritos en `supabase/cron-flujo.sql`, nunca se corrió).

### Edge Functions

`acceso` · `ai-extract` · `aviso-cobranza` · `aviso-sin-facturar` · `catalogo-sync` · `comprometido-sync` · `confirmar-proyecto` · `contratado-anio` · `estado-de-cuenta` · `gastos-sync` · `inventario-sync` · `mrp-feed` · `mrp-write` · `oc-sync` · `preguntar` · `proyectos-sync` · `respaldo-kv` · `so-ajuste` · `so-anular` · `so-cero-material` · `so-contratado` · `so-limpieza` · `so-saldo-cero` · `zoho-books` · `zoho-write`

Todas con `verify_jwt: true` salvo `estado-de-cuenta`, que es pública a propósito (el cliente abre su estado de cuenta por liga).

**Las sincronías NO pasan por `zoho-books`.** Usan `_shared/zoho.ts`, que le habla a Zoho directo. Cuando pasaban por el otro Edge Function, Supabase las frenaba con *"Rate limit exceeded for trace…"* — ese límite es de Supabase, de una función llamando a otra, y no tiene nada que ver con la cuota de Zoho. Peor: el error lo lanzaba el `fetch` mismo, así que no venía en el cuerpo y era invisible. `zoho-books` sigue siendo el proxy del navegador; la app nunca ve un token.

**El token de Zoho es uno solo para toda la casa**, en la fila `zoho_access_token` de `adm_kv`. Zoho bloquea a quien renueva de más, así que no puede haber uno por función.

---

## 3 · Variables de entorno

**Sólo nombres. Nunca pegues el valor de un token, llave o contraseña en un chat, en un commit, ni en la definición de un cron.**

### Secretos de Edge Functions (Supabase → Edge Functions → Secrets)

```
SUPABASE_URL              SUPABASE_ANON_KEY         SUPABASE_SERVICE_ROLE_KEY
ZOHO_CLIENT_ID            ZOHO_CLIENT_SECRET        ZOHO_REFRESH_TOKEN
ZOHO_ORG_ID               ZOHO_ALMACENES_ID         ZOHO_ALMACEN_ID (viejo, se respeta)
ZOHO_PROJECTS_PORTAL      ANTHROPIC_API_KEY         PREGUNTAR_MODELO
IS_PMT_URL                MRP_FEED_TOKEN            MRP_WRITE_TOKEN
COBRANZA_SECRET           MAIL_KEY_COBRANZA
```

### Variables del front (Vercel)

```
VITE_SUPABASE_URL         VITE_SUPABASE_ANON_KEY
```

**Nunca pongas un token como `VITE_*`.** Todo lo que empieza con `VITE_` se hornea en el bundle y lo lee cualquiera con las herramientas del navegador. La `anon key` es pública por diseño y ahí está bien; la `service_role` y los tokens de Zoho no van ahí jamás.

**Un secreto nuevo no lo toma una función ya corriendo: hay que REDESPLEGARLA.**

---

## 4 · Reglas que no se tocan

Cada una con su fecha y su razón. No las quites sin entender qué pasó el día que se pusieron.

### Código y despliegue

- **Push directo a `main`, sin ramas ni PR** (08-oct-2026). El flujo de rama + PR confundía y sólo hacía falta cuando Fran no tenía su computadora.
- **Se empuja sólo con el "Ok" de Fran.** Empujar a `main` publica a producción para todo el equipo.
- **Corre el build antes de empujar.** Vercel construye lo que llega a `main`; si truena allá, producción ya no corresponde a ningún commit.
- **Antes de cada commit: `git diff --cached --name-status HEAD`.** Si aparece un borrado que no pediste, no commitees.

### Supabase

- **Lecturas libres. INSERT / UPDATE / DELETE y cambios de esquema: mostrar el SQL a Fran y esperar su "Ok".**
- **El SQL de esquema se guarda también en el repo** (`supabase/*.sql`).

### Zoho Books

- **En órdenes de venta, material y equipo van en `rate: 0`.** El precio contratado vive en el concepto INST («SUMINISTRO E INSTALACIÓN…»), sin IVA. Ninguna orden salvo postventa debe traer valor en renglones de material (10-oct-2026).
- **Al actualizar una orden se manda el arreglo COMPLETO de `line_items`.** Zoho borra la línea que no venga.
- **Las apps usan el Self Client del usuario personal de Fran.** Las integraciones de Innobyte (ZBooksFZM, ZBooksProj) se revocaron el 05-oct-2026. Zoho permite **un solo Self Client por cuenta**.
- **Zoho manda en el costo de los artículos** (14-oct-2026). La app calcula el promedio ponderado y se lo **envía**; no al revés. Teclear el costo a mano en el catálogo de Zoho desincroniza los dos sistemas en silencio, porque la app calcula su propio promedio y no se entera.

### Inventario

- **Almacenes propios: Almacén Central + Almacén Logístico**, y nada más (18-oct-2026, ampliado el 03-nov-2026). NO entran: RMA, Devolución, Desecho, Semi-OK, Laboratorio, Coordinación, ni los de importación (Perezgrovas, Cargo Baja). Es una **lista** a propósito — el error de noviembre no fue el id, fue asumir que siempre habría un solo almacén.
- **El cable de uso continuo no entra al cálculo que se reporta a contadores** (18-oct-2026, los 3 cables solares agregados el 26-oct). Se corta y se consume en varias obras a la vez. Son 21 SKUs en `iso3-inv-reporte-fuera`.

### Flujo de efectivo

- **El cambio de divisas NO es flujo** (19-oct-2026). Tampoco el «Ajuste al Neto». Pero **se marcan, no se borran**: sin ellos, saldo inicial + entradas − salidas deja de dar el saldo final, y una tabla de flujo que no cuadra contra el banco no la vuelve a creer nadie. Van en su propio renglón.
- **La base del cobro pronosticado** es el concepto 1 sin IVA × porcentaje × 1.16.

### Seguridad

- **El `actor` de las bitácoras de auditoría se deriva del JWT del lado del servidor**, nunca se acepta del navegador.
- **Claude no teclea contraseñas ni credenciales** en navegadores ni terminales. Esos comandos los corre Fran.

---

## 5 · Integraciones

### IS-PMT (`isocabosG/is-pmt`, Supabase `xpyhidzocnkdcfmezqoi`)

| Dirección | Endpoint | Qué viaja |
|---|---|---|
| Leemos | `GET {IS_PMT_URL}/api/mrp` con `Bearer MRP_FEED_TOKEN` | Proyectos con su etapa, fecha de instalación y lista de materiales |
| Escribimos | `POST {IS_PMT_URL}/api/mrp/material` con `MRP_WRITE_TOKEN` | Corrección de SKU y cantidad de un renglón |

Pasan por los Edge Functions `mrp-feed` y `mrp-write`, no desde el navegador.

**AdminAppISO NO se conecta a la base de IS-PMT.** Hay un solo `createClient` en todo el repo y apunta a la nuestra. Verificado el 26-oct-2026 cuando IS-PMT cerró permisos de diez vistas: ninguna la usamos, y no por buena suerte, sino porque no tenemos cliente de su proyecto.

**Quién manda cuando difieren:**

| Dato | Manda |
|---|---|
| Costo del artículo | **Zoho**. La app calcula el promedio y se lo envía |
| Etapa de obra, fecha de instalación | **IS-PMT** |
| Renglones de material de la OV | **IS-PMT** (acuerdo del 24-oct-2026) |
| Universo de órdenes de venta | **Zoho**, nunca los proyectos locales. En IS-PMT salían 91 órdenes cuando Zoho tenía 124 abiertas |
| Facturación fiscal | **COMPAQ**, no Zoho. Zoho Books es control interno |

**`cant_pedida` del feed** se lee como `solicitadoEnObra` en `src/mrp.js`, pero **ninguna pantalla lo usa**. PIDE OBRA sale de `cant_disenada − cant_entregada`. Importa saberlo: IS-PMT corrigió 2,636 partidas infladas de ese campo y no movió ningún número nuestro.

### Quote Creator (`isocabosG/is-quotecreator`, Supabase `leeblsvqoyaitqlmxwxh`)

- **El transporte de correo es suyo.** `aviso-cobranza` le pega a `https://leeblsvqoyaitqlmxwxh.supabase.co/functions/v1/send-mail` con el header `x-iso-key` y el secreto `MAIL_KEY_COBRANZA`. Los destinatarios los resuelve SU tabla con la clave `reporte:cobranza`; mandar `to` desde aquí pisaría las bajas que hagan de su lado.
- **`aviso-sin-facturar` sigue con el patrón VIEJO** (busca `iso3-mailer` y `iso3-avisos-destinatarios.sinFacturar` en `adm_kv`, y **ninguna de las dos filas existe**). Hay que migrarlo al patrón de cobranza antes de ponerle cron.
- Quote Creator **sigue proponiendo claves dadas de baja** (`APL00038`, `NDR12024`). Limpiamos las órdenes de venta de Zoho; IS-PMT limpia sus listas de materiales. Limpiar uno no limpia el otro.

### ISO Service

**Las órdenes de POSTVENTA viven en ISO Service, no en IS-PMT.** Consecuencia medida el 28-oct-2026: el material de postventa **sí** entra a POR SURTIR (11 órdenes, 75 SKUs, 564 piezas, ~582 mil pesos — `comprometido-sync` barre todas las órdenes abiertas de Zoho sin filtrar), pero **nunca** a PIDE OBRA, porque el feed de IS-PMT trae cero postventa. Esos SKUs muestran un DIF negativo permanente que parece discrepancia y no lo es, y caen todos en SIN FECHA. No hay feed de ISO Service todavía.

### ISO Warehouse (`isocabosG/iso-warehouse`)

Maneja la recepción física. No nos alimenta. AdminAppISO **lee** el estado de recepción de Zoho (`quantity − quantity_received − quantity_cancelled`) pero no recibe ni avisa.

### Otras apps (no modificarlas desde aquí)

| App | Repo | Supabase |
|---|---|---|
| IS-PMT | `isocabosG/is-pmt` | `xpyhidzocnkdcfmezqoi` |
| ISO Engineering | `isocabosG/iso-engineering` | `lfvfmuykzbnylreadduh` |
| Quote Creator | `isocabosG/is-quotecreator` | `leeblsvqoyaitqlmxwxh` |
| ISO HR | `isocabosG/iso-hr` | `gjujgckrpnpfmpzryxua` |
| ISO Warehouse | `isocabosG/iso-warehouse` | — |

Si un cambio toca otra app, dilo y no la modifiques desde este repo.

---

## 6 · Trampas conocidas

### De Zoho Books

- **`quantity_yet_to_receive` NO existe a nivel renglón**, sólo en el encabezado de la orden. Al no encontrarlo, el código caía al respaldo y tomaba la cantidad completa: toda orden parcialmente recibida inflaba el tránsito. Lo correcto es `quantity − quantity_received − quantity_cancelled`, excluyendo los renglones de flete.
- **`actual_committed_stock` viene en cero o nulo para todo el catálogo.** Por eso el comprometido se arma recorriendo las órdenes abiertas, una por una.
- **`warehouses[]` sólo viene en `get_item`**, no en el listado. De ahí que el inventario tarde varias vueltas.
- **`rate` y `purchase_rate` traen el MISMO número en 2,321 de 2,326 artículos.** El costo que ve el contador en Zoho es un TERCER campo (el costo promedio de valuación) que no sincronizamos.
- **El índice de búsqueda por `item_id` va minutos atrás de las ediciones.** El 20-oct eso produjo una falsa alarma: una orden ya corregida seguía apareciendo con el SKU viejo. Verifica contra los `line_items` reales, no contra la búsqueda.
- **Zoho contesta 200 con `code != 0` cuando rechaza una escritura.** Sin revisar el `code`, una escritura fallida se lee como exitosa.
- **El rate limit es por ORGANIZACIÓN** y lo comparten esta app, IS-PMT y los crons. No se gana empujando más fuerte; se gana pidiendo menos. Cuando Zoho dice "espérate", lee cuánto pide y respétalo.
- **El campo nativo de Ajuste no existe en México:** *"La función Ajuste no se admite en su país. Agregue los cargos como artículo."* Por eso el ajuste por cierre es un renglón de servicio nuevo, no una edición.
- **El impuesto se hereda renglón por renglón, no es una tasa global.** Hay órdenes con el INST exento y material gravado (SO-00950, SO-01077). Suponer 16% deja la orden descuadrada.
- **`last_modified_time`** es de la ORDEN COMPLETA y tiene precisión de **un segundo**: dos cambios dentro del mismo segundo se ven iguales.

### De los pedimentos

- **La CANTIDAD UMT sólo son kilos cuando el UMT de esa fracción es de peso.** Para la 8541.43 (paneles) el UMT es PIEZAS, y las 864 piezas se colaban a la columna de kilos. Cuando no es de peso, usa el PESO BRUTO del encabezado.
- **El IVA de importación NO capitaliza** — es acreditable, queda fuera del costo.
- **Todo el prorrateo se reparte por VALOR FOB**, fletes incluidos. No por peso.
- **La agencia nombra los archivos al revés de lo que son:** el pedimento venía en un PDF llamado `PROFORMA`.

### De la base y del código

- **`adm_kv` todavía NO tiene RLS.** Es la tabla donde vive casi todo.
- **Hay 21 `catch` silenciosos en `App.jsx`.** Un `SELECT` sin permiso desde el navegador no truena a la vista: PostgREST devuelve un error que el `catch` se traga, el componente recibe vacío y la pantalla se pinta sin nada. **A IS-PMT le costó dos días descubrir uno igual.** Arreglar el shim para distinguir "no hay datos" de "no tuve permiso" es **requisito previo** a apretar el RLS de `adm_kv`, no una tarea suelta.
- **TDZ (temporal dead zone):** un `const` usado arriba de su declaración tira *"Cannot access 'X' before initialization"* **en producción**, y `no-undef` NO lo detecta. Usa `no-use-before-define` con `{variables: true}`. Pasó el 20-oct y tiró la pantalla de Inventario.
- **Un error-objeto concatenado da `[object Object]`.** Anthropic y Zoho contestan `{error: {type, message}}`. Hay un helper `textoError()` en `main.jsx`; úsalo.
- **Blobs huérfanos** que ya nadie lee: `iso3-inventario-cache`, `iso3-inventario-cache-v2`, `iso3-mrp-oc-cache` (v1), `iso3-mrp-ov-bom`. No los borres sin confirmar.
- **Git en carpetas conectadas no puede borrar sus propios `.lock`.** Si un comando falla con *"File exists"*, limpia `.git/*.lock`.
- **`npm run build` no corre en la VM Linux del puente** (el binario de rollup es darwin-arm64). El build y el push los hace Fran en su Mac.

---

## 7 · Pendientes

### Listos para correr, falta ejecutarlos

1. **Refrescar inventario y comprometido** con el código de almacenes nuevo. Los blobs son previos al cambio del 03-nov. `await window.sincronizar('comprometido-sync')` y `await window.sincronizar('inventario-sync')` (éste en tramos, hasta `terminado: true`).
2. **`gastos-sync` nunca se ha corrido.** Está desplegada; `iso3-gastos-zoho` no existe. Corre primero `{ muestra: true }`, que no escribe, y **verifica que los campos de Zoho se llamen como asume el código** antes de confiar en la clasificación. Si la salida real no anda cerca de 1.9 M por semana, la clasificación falló.
3. **Los crons del flujo** (`supabase/cron-flujo.sql`): `gastos-zoho` y `contratado-anio` no existen. Sin ellos `iso3-contratado-2026` sigue congelado desde el 10-oct.

### Decisiones pendientes de Fran

4. **`aviso-sin-facturar` nunca ha mandado un correo.** Falta migrarlo al `send-mail` de Quote Creator, que ellos emitan la llave y den de alta `reporte:sinFacturar`, y después el cron (Fran pidió **diario**).
5. **Postventa en el MRP:** marcar la fila, mandarla a SIN FECHA con etiqueta propia, o pedirle un feed a ISO Service. Sin decidir.
6. **SO-01124 KEITH MAURER MIGRIÑO POSTVENTA** — 28 SKUs, 151 piezas, $533,027: el 91% de todo el postventa. Medio millón no es una refacción; o está mal etiquetada o es obra que debería vivir en IS-PMT.
7. **El resto de los paneles.** PSP7460 estaba 2.1× abajo; **PSP7455 está en 808.61** con el mismo patrón. Decisión de Fran (28-oct): se corrigen conforme entre cada importación. Mientras tanto el inventario de esos SKUs está subvaluado.
8. **12 órdenes de compra vencidas más de un mes** siguen contando como material en camino. PO-00160 lleva 865 días. Inflan el BACK ORDER y el MRP cree que va a llegar material que no va a llegar.
9. **Los dos flujos.** Tesorería tiene su propio `FlujoSemanal` (movimientos capturados a mano) y ahora existe la pestaña **Flujo** (leída de Zoho). Dos pantallas que dicen "flujo" y dan números distintos erosionan la confianza en las dos. Hay que decidir si la de Tesorería se queda, se renombra o se absorbe.
10. **`so-ajuste` y `so-cero-material` escriben a las OV de Zoho sin verificar si la orden cambió.** `so-limpieza` sí tiene guardia (exige el `lineId` de la vista previa). IS-PMT escribe 167 veces por semana y va subiendo. Falta `last_modified_time` + `codigo: 'orden_cambio'`.
11. **Costo de mano de obra:** faltan los dos insumos. A IS-PMT se le pidió un `/api/cuadrilla` (quién asistió y cuántos días) y a ISO HR un `/api/costo-personal` (costo diario cargado). **El `empleado_id` tiene que ser el mismo en los dos**, o no hay cruce posible.
12. **TEST-00918** sigue sin borrarse: hay que anular el envío `ENV-04260`, luego el paquete `PAQ-04137`, luego la orden. 9 tubos salieron de inventario por esa orden de prueba.

### Deuda técnica

13. **Edge Functions desplegadas y NO committeadas:** `aviso-cobranza`, `proyectos-sync`, `aviso-sin-facturar`, `so-saldo-cero`, `so-anular`, `confirmar-proyecto`, `estado-de-cuenta`. El código vivo no está en el repo.
14. **Dos comentarios en `comprometido-sync` que ahora mienten** — siguen diciendo "Solo lo apartado en el Almacén Central". El código está bien.
15. **La pestaña Inventario recalcula en el navegador** y escribe en la misma llave que el cron. Lo correcto es que lea el blob.
16. **`ECUBE60` no está sembrado** en el catálogo de la app (sólo `ECLITE60`).
17. **Flujo etapa 2:** los dos motores de pronóstico (recurrente y proyectos) no existen. Las semanas futuras salen vacías a propósito.

---

## 8 · Cómo se despliega

```bash
cd ~/Desktop/adminappiso
./subir.sh
```

`subir.sh` se niega si hay cambios sin commitear o si el remoto trae commits que no tienes, muestra qué va a subir, **compila**, y empuja a `main`. **No hace commit a propósito**: compilar y empujar son reversibles, un commit con mensaje inventado por un script se queda en la historia para siempre.

Vercel despliega solo al llegar a `main`, en 1-2 minutos. La versión viva se ve en el encabezado de la app, junto a la cuenta de la sesión.

### Edge Functions

**No se despliegan con el push.** Una por una:

```bash
supabase functions deploy <nombre> --project-ref gkoibrjhlqmuiuedrtaz
```

**Si cambias una función Y la pantalla que la usa, despliega las dos.** Si subes sólo el front, la pantalla y el blob de madrugada van a decir cosas distintas.

### SQL

En el editor SQL de Supabase. Los archivos viven en `supabase/*.sql` y se guardan en el repo.

---

## 9 · Bitácora

Una línea por cambio: **fecha · qué cambió · POR QUÉ**. El por qué es lo que evita que alguien vuelva a meter un error que ya se había quitado a propósito.

- **2026-10-05** · Se crea el archivo de reglas comunes de trabajo.
- **2026-10-05** · Se revocan las integraciones de Innobyte (ZBooksFZM, ZBooksProj) · las apps pasan al Self Client personal de Fran. Zoho permite uno solo por cuenta.
- **2026-10-08** · Fuera el flujo de rama + PR; push directo a `main` · confundía y sólo hacía falta cuando Fran no tenía su computadora.
- **2026-10-09** · `puede_ajustar` y columna `nombre` en perfiles; Edge Function `so-ajuste` · el ajuste por cierre es un RENGLÓN NUEVO, no una edición: bajarle la cantidad a un renglón ya surtido arregla el importe y rompe el inventario, porque Zoho ya descontó esas piezas cuando salió el envío. Y no se usa el campo nativo de Ajuste porque Zoho lo rechaza en México, textual. La bitácora guarda el nombre para que diga QUIÉN, no sólo qué.
- **2026-10-09** · `so-cero-material` acepta el `salesorder_id` cuando la orden está cerrada.
- **2026-10-10** · `contratado-anio`: el contratado es el SUBTOTAL, no el concepto 1 crudo, y se excluye por total de orden, no por subtotal · el link viejo de Innobyte **restaba al concepto 1** el valor del material que no salía en cero, dejando el total intacto. Tres pruebas: en 65 de 65 `concepto 1 + material = subtotal`; en 61 de 65 `total = subtotal × 1.16` al centavo; y tres concepto 1 en NEGATIVO, que es lo que deja una resta que se pasa. El importe nunca se perdió: está en el subtotal. Como las 35 órdenes afectadas están cerradas, **se cambió la medición, no el dato**.
- **2026-10-12** · % pagado y etiqueta de sin facturar en cobranza; la utilidad promedio sólo de cerrados y ponderada · un promedio simple deja que una obra chica con buen margen pese lo mismo que una grande.
- **2026-10-14** · Zoho manda en el costo de los SKU que la app no costeó · la app sólo sabe de lo que pasó por Importaciones; para el resto, inventarse un costo es peor que tomar el de Zoho.
- **2026-10-14** · Guardia en Importar y volcado nocturno de `adm_kv` · importar encima de datos buenos no tiene deshacer.
- **2026-10-16** · El saldo del proyecto se mide contra el CONTRATO, no contra la factura · la facturación fiscal va en COMPAQ y Zoho no se entera, así que una orden ya cobrada se veía como si no se hubiera pagado nada.
- **2026-10-17** · El reporte de inventario se arma con casillas, no sólo con la fórmula; lo que no entra se ve en PANTALLA, no escondido en el CSV · un criterio que sólo vive en el archivo exportado no lo revisa nadie.
- **2026-10-18** · **Sólo Almacén Central** en el inventario · Zoho tiene diez almacenes y el total global los suma todos. SARK30K tenía 15 globales: 9 en Central y 6 en RMA — seis inversores apartados para devolver al proveedor, contados como vendibles. **Y había DOS definiciones** del mismo blob: la pantalla recalculaba en el navegador y el Edge Function escribía filtrando Central, así que mandaba quien escribiera al final; apretar "Actualizar" le metía al reporte del contador el material de RMA y laboratorio, en silencio.
- **2026-10-18** · Valuar con el costo del catálogo, no con `purchase_rate` · `rate` y `purchase_rate` traen el mismo número en 2,321 de 2,326 artículos: valuar con eso es valuar a precio de venta.
- **2026-10-18** · Lista de SKUs fuera del MRP, con candado · 242 SKUs que compras no quiere ver. **El candado importa:** si una obra pide un SKU excluido, vuelve a aparecer. Esconder algo que alguien está pidiendo es cómo se deja de comprar material que hace falta.
- **2026-10-18** · Columnas PIDE OBRA y DIF en el MRP · son dos fuentes distintas (la lista de materiales de IS-PMT contra lo apartado en Zoho) y **donde no coinciden está el material que va a faltar**. Antes esa diferencia no se veía.
- **2026-10-19** · El cable de uso continuo sale del reporte a contadores, apagado por default y con la tabla ordenable por valor · se corta y se consume en varias obras a la vez; no es inventario asignable. La hipótesis de que no había obras pidiéndolo era falsa: 18 SKUs de cable con existencia positiva estaban en la hoja de negativos.
- **2026-10-19** · Una sola cuenta para la tarjeta del panel y para el reporte · daban 846 contra 836. Dos funciones calculando lo mismo siempre acaban diferenciándose.
- **2026-10-20** · `subir.sh` · para empujar desde el teléfono por Termius. No hace commit a propósito.
- **2026-10-20** · **Se cayó la pantalla de Inventario en producción** (`noReporta` usado antes de declararlo) · TDZ: `const` leído arriba de su declaración truena en runtime y `no-undef` NO lo detecta. Se agregó `no-use-before-define` al linter y se comprobó contra el archivo roto. La lección real: *"la pantalla no la probé en navegador"* era exactamente la prueba que faltaba.
- **2026-10-23** · Totales por tipo en Otros costos del control presupuestal · los viáticos no se podían ver sumados.
- **2026-10-24** · El error de Anthropic deja de verse como `[object Object]` · `window.aiExtract` tiraba `new Error(data.error)` con `data.error` siendo un objeto `{type, message}`. El módulo de Importaciones llevaba días muerto mostrando un mensaje ilegible, y el motivo real era que **la API se había quedado sin saldo**. Se agregó `textoError()` y se aplicó en los 9 helpers. El fix no destapa el módulo: sólo deja ver el motivo. **Un error que no se puede leer es un error que nadie arregla.**
- **2026-10-25** · PSP7460 de 817.40 a **1,731.87** (pedimento 26403965006004655) · el costo viejo equivalía a 44 USD, por debajo del EXW actual de 56.12 y sin flete ni aduana: era un precio FOB viejo capturado a mano, no un costo aterrizado. **Se tomó el landed completo en vez del promedio ponderado estricto** (que habría dado 1,590.49) porque promediar contra un número inventado mete basura al promedio. Impacto: +144,486 en inventario y 789,188 de costo de material que no se reconocía, repartido en 10 obras vivas que se veían más rentables de lo que son. Las cotizaciones NO estaban mal: Quote Creator lee el costo de Zoho, que sí andaba cerca.
- **2026-10-26** · Importaciones: **OC como tipo de documento**, peso bruto real y descripción del catálogo · (1) la factura del proveedor no trae SKU ("Monocrystalline module 460W"), la OC sí lo trae escrito; leerla es exacto contra adivinarlo con IA. (2) El extractor afirmaba que la CANTIDAD UMT son kilos — cierto sólo cuando el UMT de esa fracción es de peso, y para la 8541.43 es PIEZAS, así que las 864 piezas se colaban a la columna de kilos. **No cambia ningún costo**: el prorrateo reparte por valor FOB. (3) La descripción se aplicó en los CUATRO caminos que asignan SKU; arreglarlo sólo donde se notaba lo habría dejado reaparecer por los otros tres.
- **2026-10-26** · `gastos-sync` · los egresos eran el único dato que le faltaba al flujo. **Clasifica traspaso contra salida real:** del 1-sep al 19-oct Zoho tenía 35.5 M de los que 22.3 M no son salida de efectivo (19.6 M de cambio de divisa entre cuentas propias y 2.7 M de ajustes contables). Sin clasificar, la gráfica diría que la empresa gasta 5 M a la semana en vez de 1.9 M. El traspaso se MARCA, no se borra. La semana se guarda como la fecha del LUNES y no como número ISO: el número se repite cada año y en el cruce de diciembre manda a la semana 1 fechas del año anterior.
- **2026-10-27** · Pantalla **Flujo**, 52 semanas · el saldo se camina HACIA ATRÁS desde el saldo real de hoy, porque de Zoho sabemos el de hoy y no el de cada viernes del año; la pantalla dice que los demás son derivados. **Si el blob de egresos no existe, sale un aviso** en vez de una tabla en ceros — un cero que no se explica se lee como un cero real. La paleta se validó con script: el verde de la marca contra el ámbar **reprobó** la separación para daltonismo (ΔE 7.9, abajo del piso de 8), así que las entradas van en azul. Las semanas futuras van vacías a propósito: una línea plana hacia el futuro se leería como "no va a pasar nada".
- **2026-10-28** · Medido: postventa entra a POR SURTIR pero nunca a PIDE OBRA · vive en ISO Service, que no nos alimenta. 11 órdenes, 75 SKUs, 564 piezas, ~582 mil pesos con DIF negativo permanente que parece error y no lo es.
- **2026-11-03** · **Almacén Logístico cuenta como inventario propio** · se dio de alta en Zoho y los 864 paneles del pedimento 6004655 aterrizaron ahí: 1,496,335 pesos que la app no veía, en el MRP, en el inventario físico y en el reporte a contadores. PSP7460 marcaba −705 disponible en Central (todo comprometido) y 864 en Logístico; **el neto real es 159 y cualquiera de los dos por separado miente**. El filtro pasó de un id a una LISTA en los tres lugares — el error no fue el id, fue asumir que siempre habría un solo almacén. Semi-OK sigue fuera: no está verificado.
- **2026-11-04** · Este archivo se reescribe completo y los documentos del proyecto se copian a `docs/` · el proyecto de Claude donde vivían se cierra, y el repo es lo único que sobrevive.

### Decisiones que se intentaron y se echaron atrás

- **`disponible contable − disponible física` como equivalente de "Cantidad por recibir"** (30-sep) · acertó en BRCHV5KW (96) y BREHV5KW (320) y **falló en BPEB2KWH** (−36 contra 66 real). Descartada.
- **Alarma por "588 piezas facturadas sin entrada registrada"** (30-sep) · **falsa**: las existencias contables son el acumulado histórico y no aportan al conteo. La corrigió Fran.
- **`MAX_OC = 250` limitando el tránsito** (hasta 6-oct) · ese tope se puso para reconstruir el historial de proveedores sin saturar a Zoho y acabó limitando también el material en camino. **Son dos cosas distintas: el historial aguanta una ventana, el material en camino no.** Veinte órdenes abiertas no se estaban contando.
- **El promedio ponderado estricto para PSP7460** (25-oct) · habría dado 1,590.49 mezclando el costo bueno con uno que nunca fue aterrizado. Se descartó a favor del landed completo.
- **Pedirle a IS-PMT un `codigo` para el rechazo por concurrencia** (28-oct) · ya existía (`orden_cambio`), y además `/api/mrp/material` no toca la OV, así que ese rechazo nunca nos llega. La petición estaba mal planteada.
- **Dar por hecho que `so-limpieza` no verificaba concurrencia** (28-oct) · **sí verifica**, con otro mecanismo: exige el `lineId` que devolvió la vista previa, que es más fino que `last_modified_time` porque es por renglón. Se concluyó de más buscando una palabra en el código en vez de leerlo. **La ausencia de una palabra no es la ausencia del comportamiento.**
