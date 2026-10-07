# ADR-10: Migracion SDK v2 de datos (Etapa C del ADR-06) -- DAL dataClient

Fecha: 2026-10-07
Estado: Aceptada (ejecutada en FASE8-C1/C2)
Depende de: ADR-06 (decision marco Velo -> SDK v2), SSOT-01 (IDs canonicas)
Reemplaza a efectos practicos: import directo de `wix-data` en backend

## Contexto

La Etapa C del ADR-06 exige migrar la capa de datos backend de Velo legacy
(`wix-data`, `wix-secrets-backend`, `wix-members-backend`, `wix-ecom-backend`)
al JavaScript SDK v2, SIN alterar semantica fiscal ni de ledger. Requisitos
duros:

1. Lectura fuerte de CAJA_SEQ preservada (RD 1619/2012: riesgo de
   numSerieFactura duplicado si se pierde consistencia).
2. Pruebas de igualdad offline (ADR-06.10): misma semantica de store antes
   y despues de la migracion.
3. Minimo diff: los call-sites de negocio no se reescriben.
4. G10: ASCII estricto en .js; AEAT/PGC permanecen en espanol.

Auditoria previa: 18 ficheros importaban `wix-data`; 19 sitios usaban
`consistentRead` (17 true / 2 false); 8 consumidores de `getSecret`;
3 de members; 1 de ecom.

## Decisiones

### D1. DAL unico: `src/backend/dataClient.js`

Un modulo exportador por defecto con superficie compatible wix-data
(`query`, `get`, `insert`, `update`, `save`, `remove`) que delega en la
superficie REAL de `@wix/data`: el namespace `items` (`items.queryItems`,
`items.getItem`, `items.insertItem`, `items.updateItem`, `items.deleteItem`).

Correccion verificada sobre el plan original: `@wix/data@1.0.521` NO expone
named exports top-level `query/get/insert/update/remove` (el plan T1 los
asumia). El DAL importa `{ items }` y adapta firmas posicionales legacy:
- `get(collectionId, itemId, options)` -> `items.getItem(itemId, { dataCollectionId })`
- `query(collectionId, opts)` traduce WQL (`_id eq "x" and ...`) a filter
  DSL del SDK, con guard de campo `_id -> dataItemField._id`.
- `consistencyMode: "strong"/"eventual"` se mapea al enum `consistency`
  (`STRONG`/`EVENTUAL`) del SDK; opciones legacy desconocidas se ignoran.
- Resultado normalizado: `{ items, total, totalCount, hasNext(), next() }`
  (contrato de cursor usado por fiscalAggregator.web).

Los 18 modulos cambian UNA linea: `from "wix-data"` -> `from "backend/dataClient"`.
Punto unico de control para toda la capa de datos.

### D2. `consistentRead` -> `consistencyMode` en call-sites (explicito y greppable)

No se esconde un shim en el DAL: los 19 call-sites se reescribieron
literalmente (`consistencyMode: "strong"` x17, `"eventual"` x2). Ventaja:
la exigencia de lectura fuerte es visible en auditoria y no depende de
que el DAL interprete una opcion que el SDK v2 ignora.

### D3. Wrapper canonico de secretos en `mmSecrets.js`

Correccion verificada sobre el plan: `@wix/secrets` expone
`secrets.getSecretValue(name)` POSICIONAL (no `getSecret({name})`). El
wrapper mantiene la firma legacy exacta:

    import { secrets } from "@wix/secrets";
    export async function getSecret(name) { return secrets.getSecretValue(name); }

Los 8 consumidores eliminaron `import { getSecret } from "wix-secrets-backend"`
y fusionaron su import existente: `import { SECRETS, getSecret } from "backend/mmSecrets"`.
mmSecrets sigue siendo el SSOT de nombres de secreto; ningun valor hardcodeado.

### D4. Harness offline: mocks delegantes (igualdad de resultados)

`tests/loader.mjs`:
- Rama EXACTA `mock:@wix/data` (antes de la rama generica `mock:`) que
  resuelve `WIXDATASDK_SOURCE`: exporta `items` delegando en el MISMO
  `wixDataMock` del harness, mas named exports `query/get/insert/update/remove`
  y default, para compatibilidad con cualquier forma de import.
- GENERIC_STUB ampliado con `export const secrets = { getSecretValue: async (name) => "mock-secret:" + name }`
  (fix post-C2: sin este export, mmSecrets fallaba en link-time ESM con
  "does not provide an export named 'secrets'" -> 2 tests rotos).
- Mock de query ampliado con contrato cursor: `totalCount`, `hasNext()`,
  `next()` (R6 del informe de auditoria).
Resultado: bateria 57/57 verde IDENTICA al baseline pre-migracion (D4
cumple la exigencia de igualdad del ADR-06.10).

### D5. `@wix/members` y `@wix/ecom`: cambio de especificador con Riesgo R7 documentado

T5/T6 sustituyen solo el especificador de import (`wix-members-backend` ->
`@wix/members`, `wix-ecom-backend` -> `@wix/ecom`). HONESTIDAD RADICAL:
la superficie invocada por el codigo (`currentMember.getMember()`,
`orders.getOrder()`) es la API Velo; los paquetes SDK v2 exponen APIs
funcionales distintas (p. ej. `members.queryMembers`, `orders.getOrders`).
En runtime Wix estos aliases suelen resolverse por compatibilidad, pero
NO esta verificado aqui. Mitigacion obligatoria antes de publicar:
validacion E2E en preview (reserva dual, webhook ORDER_PAID/REFUNDED).
Si falla, revertir T5/T6 a Velo (los paquetes permanecen instalados y no
hay coste de rollback).

### Riesgos registrados

| # | Riesgo | Estado |
|---|--------|--------|
| R1 | Perder lectura fuerte CAJA_SEQ al migrar | Mitigado (D2/D1, mapeo a enum consistency) |
| R3/R4 | Firmas distintas get()/getSecret() | Mitigado (adaptadores D1/D3) |
| R5 | Cursor pagination en fiscalAggregator | Mitigado (mock + normalizacion DAL) |
| R6 | Loader sin exports para 18 modulos migrados | Mitigado (D4) |
| R7 | Superficie real @wix/members/@wix/ecom vs call-sites Velo | ABIERTO -- gate E2E preview |

### Whitelist de gobernanza (contradiccion BIBLIA 13.2)

- `contabilidad.js` NO esta muerto: `eventLog.js` lo consume via import
  dinamico (`projectLedgerMovementToAccounting`, ~linea 605). Se migro su
  import y queda WHITELISTADO.
- `marianAssistant.web.js` tiene consumidor vivo:
  `pages/ADMINISTRACION.gn7mx.js:35`. WHITELISTADO.
- Decision: evidencia antes que destruccion. No se archiva ninguno. Un ADR
  futuro de retirada debera refactorizar antes eventLog.js y la pagina
  ADMINISTRACION.

### Gap de publicacion: wix.lock de `@wix/ecom`

El repo no tiene entrada `@wix/ecom` resuelta en lockfile/Wix site context.
Antes de publicar: ejecutar `npx @wix/cli install` para regenerar el lock y
confirmar resolucion del paquete en el sitio.

## Consecuencias

- Greps negativos garantizados: `from "wix-data"` = 0 en backend,
  `wix-secrets-backend`/`wix-members-backend`/`wix-ecom-backend` = 0 imports,
  `consistentRead` = 0 call-sites.
- Recuentos positivos: `from "backend/dataClient"` = 18,
  `consistencyMode:"strong"` = 17, `"eventual"` = 2.
- IDs canonicas intactas (regresion legacy = 0 nuevos usos; los residuos
  historicos en src/pages y src/public son pre-existentes al baseline y
  quedan fuera del alcance Etapa C, alineados con SSOT-01 por las Fases 1-5).
- Pendientes manuales post-migracion: `npx @wix/cli install`, E2E preview
  (gate R7), push con tags.
