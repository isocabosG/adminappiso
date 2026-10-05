# AdminAppISO (compras, costeo, tesorería) — reglas de trabajo para Claude

**App:** AdminAppISO (compras, costeo, tesorería) · **Repo:** `isocabosG/adminappiso` · **Supabase:** `gkoibrjhlqmuiuedrtaz` (AdminAppISO) · **Deploy:** Vercel automático al mergear a `main`.

Este archivo es la memoria compartida entre chats. La fuente de verdad es el repo y la base, no lo que recuerde un chat.

## Antes de empezar
- Clona el repo desde `main`. Nunca trabajes sobre una copia vieja.
- Lee este archivo completo y la bitácora de abajo.
- Un solo chat trabaja esta app a la vez. Si hay otro chat activo en el mismo repo, detente y avisa.

## Código
- Todo cambio va en una rama + PR. Nunca push directo a `main`.
- Se mergea solo con el "Ok" de Fran. Mergear publica a producción para todo el equipo.
- Corre el build antes de abrir el PR.

## Supabase
- Lecturas: libres.
- INSERT / UPDATE / DELETE y cambios de esquema: mostrar el SQL a Fran y esperar su "Ok".
- El SQL de esquema se guarda también en el repo (`supabase/migrations/` o `sql/`).

## Zoho Books (org 809693641)
- En órdenes de venta, el material y el equipo van en `rate: 0`. El precio de venta vive en el concepto INST («SUMINISTRO E INSTALACION…») = precio contratado sin IVA.
- Al actualizar una orden se manda el arreglo COMPLETO de `line_items`: Zoho borra la línea que no venga. Nunca borrar renglones desde una app.
- Las apps usan el Self Client del usuario personal de Fran. Las integraciones de Innobyte (ZBooksFZM, ZBooksProj) se revocaron el 05-oct-2026; su link de carga de Excel y el widget de proyecto ya no existen.

## Otras apps (no modificarlas desde aquí)
| App | Repo | Supabase |
|---|---|---|
| PMT (Projects Management Tool) | `isocabosG/is-pmt` | `xpyhidzocnkdcfmezqoi` |
| ISO Engineering | `isocabosG/iso-engineering` | `lfvfmuykzbnylreadduh` |
| AdminAppISO (compras, costeo, tesorería) | `isocabosG/adminappiso` | `gkoibrjhlqmuiuedrtaz` |
| Quote Creator | `isocabosG/is-quotecreator` | `leeblsvqoyaitqlmxwxh` |
| ISO HR | `isocabosG/iso-hr` | `gjujgckrpnpfmpzryxua` |

Si un cambio toca otra app, dilo y no la modifiques desde este repo.

## Bitácora
Al terminar un cambio, agrega una línea: fecha · qué cambió · por qué.

- 2026-10-05 · Se crea este archivo con las reglas comunes de trabajo.
