# ADR-05 — Append-only condicional para WEBHOOK_EVENT en ControlOperativo

- **Fecha:** 02/10/2026
- **Estado:** Aceptado
- **Norma:** BIBLIA VV v7.0 §13 · Plan SSOT FASE 4 (hooks ControlOperativo)

## Contexto
La consolidación 8-en-1 convierte a `ControlOperativo` en destino de dominios
con ciclos de vida incompatibles: SLOT_LOCK caduca y se purga, RATE_LIMIT se
desbloquea, DAYS_CACHE se sobreescribe constantemente… y WEBHOOK_EVENT, que por
idempotencia fiscal/integración **no debe reescribirse jamás**: su presencia es
la prueba de "ya procesé este evento externo". Un append-only absoluto sobre la
colección entera rompería locks y caches; uno laxo abriría agujero de
doble-procesamiento de webhooks.

## Decisión
Append-only CONDICIONAL, discriminado por `controlType`, implementado en los
hooks `ControlOperativo_beforeUpdate/beforeRemove` (`data.js`):

1. `controlType === WEBHOOK_EVENT` → UPDATE y REMOVE **denegados siempre**.
   Corrección de un evento mal procesado = insertar evento nuevo con
   `dedupeKey` distinto y referencia cruzada en `payload.supersedes`.
2. Rest de tipos → mutables según su contrato:
   - SLOT_LOCK: mutable solo por dueño del lock (token) o cron de expiración
     (`status: ACTIVE → EXPIRED/CLOSED`).
   - COMPENSATION: máquina de estados PENDING → EXECUTED|FAILED (nunca reversa).
   - Caches (DAYS_CACHE/DUAL_CACHE): upsert libre por `dedupeKey`.
3. invariantes comunes a todos los inserts: `controlType` ∈ CONTROL_TYPE,
   `dedupeKey` único (índice), `traceId` presente, `schemaVersion` canónica.

## Alternativas
- Tabla separada para webhooks: rechazada — reintroduce las 8 colecciones que
  la FASE 4 elimina y multiplica permisos/índices.
- Soft-delete con flag en vez de denegar remove: rechazada — deja ventana de
  reescritura y no satisface la prueba de idempotencia ante auditoría.

## Consecuencias
- Un solo hook family que bifurca por discriminador: coste de lectura mayor,
  mitigado con helpers nombrados y tests específicos por tipo.
- La migración de eventos históricos usa `tools/migrate-control-operativo.mjs`
  (solo WEBHOOK_EVENT + COMPENSATION tienen estado vivo relevante).

## Evidencia
Hooks en `src/backend/data.js`; tests `data.hooks.test.js` (casos: update
WEBHOOK_EVENT denegado, update SLOT_LOCK por token permitido).
