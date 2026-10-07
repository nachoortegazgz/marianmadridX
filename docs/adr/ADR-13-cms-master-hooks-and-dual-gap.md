# ADR-13: Maestros CMS editables y reservas duales con hueco libre

- **Estado:** Aceptado
- **Fecha:** 2026-10-07
- **Alcance:** `ServiciosCatalogo`, `MapaStaff`, `ComplementosCatalogo` y el flujo de reservas online simple/dual.

## Contexto y evidencia

El CMS Wix conectado se inspeccionó en modo lectura mediante **Get Data Collection**. Wix documenta que el recurso devuelve la definición y los campos de una colección:

- [Wix Data Collections — Get Data Collection](https://dev.wix.com/docs/api-reference/business-solutions/cms/collection-management/data-collections/get-data-collection)
- [Wix Data Collections — List Data Collections](https://dev.wix.com/docs/api-reference/business-solutions/cms/collection-management/data-collections/list-data-collections)

La colección `ServiciosCatalogo` contiene `serviceId`, `title`, `slug`, `price`, `availableStaff`, `addOnOptions` (referencia múltiple a `ComplementosCatalogo`), `phase1Duration`, `exposureDuration`, `phase2Duration`, `allowCombine`, `linkedPhases` y `clientHidden`. La colección `MapaStaff` contiene `resourceId`, `memberId`, `rolBookings`, `rolWebsite`, `staffName`, `scheduleId` y `traceId`. `ComplementosCatalogo` define `addonId` (no `addOnId`), `name`, `price`, `durationMinutes` y una referencia a `ServiciosCatalogo`.

La evidencia mostró una discrepancia concreta: el hook de complementos exigía `addOnId`, mientras que el CMS define `addonId`. Los hooks de maestros también imponían requisitos y enums de contenido adicionales a la estructura administrada en CMS.

## Decisiones

1. Retirar los hooks `beforeInsert`, `beforeUpdate` y `beforeRemove` de `ServiciosCatalogo`, `MapaStaff` y `ComplementosCatalogo`. El CMS es la fuente de verdad de estos maestros; los consumidores proyectan los campos que usan y verifican los requisitos operativos en el momento de la operación.
2. Mantener los hooks de ledgers, fiscalidad, caja, horario laboral, idempotencia y append-only sin cambios. Esta ADR no autoriza cambios destructivos sobre esos registros.
3. Adaptar la proyección de complementos al campo real `addonId` de CMS, manteniendo el identificador `addOnId` únicamente donde el contrato externo de reserva lo requiera.
4. Reservas duales no usan Wix multi-service: crean una reserva Bookings V2 independiente por fase y un checkout con una línea por reserva. La fase enlazada puede estar oculta al público; la visibilidad la gobierna el servicio padre.
5. Un par dual solo se ofrece/acepta si deja un intervalo positivo entre F1 y F2. Si falta el final de F2, se deriva de la duración de la fase enlazada; no se usa un fallback fijo de 30 minutos.
6. Persistir los tipos duales con los enums canónicos `DUAL_F1` y `DUAL_F2`.

## Verificación

Se añadieron pruebas de integración offline con mocks configurables de Bookings V2, eCommerce y CMS. Las pruebas simulan una reserva online simple y otra dual con fase enlazada oculta y 30 minutos libres entre fases; verifican una llamada de creación para SIMPLE, dos para DUAL, un checkout con el número correspondiente de líneas, tipos persistidos canónicos y ausencia de payload multi-service. No se crearon reservas ni se modificaron datos del sitio Wix durante la prueba.
