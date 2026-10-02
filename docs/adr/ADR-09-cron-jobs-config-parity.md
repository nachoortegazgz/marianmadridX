# ADR-09: Paridad jobs.config <-> crons.js (verifyNightlyZClosing, cleanAuditLogs)

- Fecha: 2026-10-02
- Estado: ACEPTADO
- Relacion: Plan de correccion item 1, SSOT FASE4 (ControlOperativo 8-en-1), ADR-05 (append-only condicional), cajas.web.js `registerZClosing`

## Contexto
`src/backend/jobs.config` declaraba 8 jobs, pero `src/backend/crons.js` solo
exportaba 6. Los dos sin implementacion eran:

- `verifyNightlyZClosing` (20 1 * * *, cierre Z nocturno del dia anterior)
- `cleanAuditLogs` (0 2 * * 0, retencion semanal 90 dias)

Un jobs.config que apunta a funciones inexistentes es un fallo latente del
runner de Velo (el job falla al resolverse la funcion) y una divergencia
SSOT entre configuracion y codigo. Opciones: eliminar las entradas o
implementar las funciones. Se decide **implementar**, porque ambas capacidades
estan justificadas por el dominio fiscal (cierre Z diario obligatorio en
sistemas de registro de operaciones) y por la higiene de retencion de
`ControlOperativo`.

## Decision
Implementar en `backend/crons.js` (v5011-CRON-PAIR):

### CRON 7: verifyNightlyZClosing
- Calcula el dia anterior en hora Madrid via `_readDate` (mmUtils).
- Delega integramente en `registerZClosing` (cajas.web.js) — unica
  implementacion canonica del cierre (hash chain, firma, breakdowns). No se
  duplica logica.
- Pasos benignos tolerados: `NO_MOVEMENTS`, `Z_ALREADY_CLOSED`.
- Restriccion de plataforma (follow-up): Velo no expone sesion de miembro
  dentro de un cron, por lo que el `requireCajero()` interno devuelve
  `ACCESS_DENIED`. El cron interpreta ese codigo como "verificacion por
  lectura": si `HistoricoCierresZ/Z_<ymd>` existe (cierre manual del cajero),
  sale con log.info idempotente; si falta, inserta ALERT WARN
  `NIGHTLY_Z_CLOSING_MANUAL_REQUIRED` (dedupeKey `ALERT:ZCLOSING:<ymd>`) sin
  relanzar (accion humana, no re-ejecucion infinita del runner).
- Fallos reales (`INTEGRITY_VIOLATION`, `APPROVER_REQUIRED`, config fiscal):
  inserta ALERT `NIGHTLY_Z_CLOSING_FAILED` en ControlOperativo (dedupeKey
  `ALERT:ZCLOSING:<ymd>`) y relanza para activar alerting del runner
  (`onConsecutiveFailures: 1`).
- `approverUser: "CRON_NIGHTLY"` marca el origen automatico del cierre
  (`closingSource: "CRON"` ya lo registra `registerZClosing`).

### CRON 8: cleanAuditLogs
- Retencion leida de `SDK_CONFIG.JOBS.AUDIT_RETENTION_DAYS` (SSOT en
  internalConfig.js; hoy = 90 dias) sobre `ControlOperativo._createdDate`.
- Alcance restrictivo por `controlType`: SOLO `ALERT`, `COMPENSATION` en
  estado terminal (`EXECUTED`/`FAILED`) y `WEBHOOK_EVENT` procesado
  (`EXECUTED`/`CLOSED`).
- Nunca toca caches/locks (purgados por expiraAt en crons 1/2/4), ni
  `BOOKING_TX`/`RATE_LIMIT`.
- Coherente con ADR-05 (append-only condicional): un WEBHOOK_EVENT sin estado
  procesado NO se elimina aunque supere la ventana.

### Harness offline
`tests/loader.mjs` no soportaba `.count()` en el mock de query; se anade para
que `systemHealthCheck` y `verifyNightlyZClosing` puedan ejercitarse offline.

## Consecuencias
- jobs.config <-> crons.js: 8 declaraciones = 8 exports (grep de paridad = 0
  divergencias). El modulo declara "8 crons activos".
- Cierre Z nocturno automatico con escalamiento humano ante violacion de
  integridad; cero logica duplicada del cierre.
- Purga semanal de auditoria acotada y segura para append-only.
- Suite offline ampliada con CRON-PARITY-01 (paridad estatica config/exports).
