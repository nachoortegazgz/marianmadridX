# ADR-03 — Email transaccional: MapaStaff como fuente de destinatarios internos

- **Fecha:** 02/10/2026
- **Estado:** Aceptado
- **Norma:** BIBLIA VV v7.0 §13 · MATRIZ CAMBIO IDS (registro horario/laboral)

## Contexto
Los avisos operativos (nuevas reservas, cancelaciones, alertas de compensación)
se enviaban a direcciones hardcodeadas o derivadas de `ConfiguracionFiscal`,
una colección que FASE 1 declaró no-canónica para datos de identidad. Además,
la normativa laboral exige trazabilidad de jornada: si un staff recibe un aviso
que implica trabajo (reagendar, atender alerta), debe constar en su registro.

## Decisión
1. Única fuente de destinatarios internos: colección `MapaStaff` con el campo
   `emailNotificaciones` (por miembro, con consentimiento explícito registrado).
2. Todo envío interno se hace THROUGH el hook de notificación que, al resolver
   destinatarios desde MapaStaff, escribe una entrada de auditoría vinculada al
   `memberId` — sin crear registros horarios por sí mismo (esos los genera
   `RegistrosHorariosStaff_beforeInsert`, que valida `adjustmentReason`).
3. Cero emails de staff fuera de MapaStaff; cualquier otro origen (config,
   constantes) queda prohibido y es verificado por test de guardia.

## Alternativas consideradas
- `permissions.json` / config estático: descartado — divergía de la realidad de
  plantilla y no permite opt-out individual (LOPD/GDPR minimización).

## Consecuencias
- Alta: ciclo de vida del destinatario ligado al de la ficha de staff (baja =
  cese inmediato de avisos).
- Media: requiere que MapaStaff esté completo antes de activar reenvíos nuevos;
  el cron de salud ya alerta si un rol activo carece de email válido.

## Evidencia
Hooks §13 en `src/backend/data.js`; consumidores de notificación en
`src/backend/crons.js` y `src/backend/booking/bookingSaga.js`.
