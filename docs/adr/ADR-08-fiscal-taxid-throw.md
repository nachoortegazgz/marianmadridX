# ADR-08: _getBusinessTaxId LANZA FISCAL_CONFIG_MISSING (sin placeholder)

- Fecha: 2026-10-02
- Estado: ACEPTADO
- Relacion: BIBLIA VV v7.0 SSOT-09 / 10 / 11.4, Directriz V20.1, ADR-07 (canonicidad de escrituras)

## Contexto
`_getBusinessTaxId` (`src/backend/fiscalAggregator.web.js`) resuelve el NIF del
emisor leyendo `DatosFiscales` (registro `CONFIG_SISTEMA`, campo canonico
`nifProductor`; adaptador de lectura transitorio sobre `taxId` con EOL
31/12/2026). Historicamente existio un fallback que devolvia el placeholder
`"BXXXXXXXX"` cuando no habia configuracion fiscal, lo que permitia publicar
resumenes fiscales (Modelo 303 borrador, libro registro) con un NIF ficticio.

El Plan de correccion detecto una divergencia test/codigo: el codigo lanza
`Error("FISCAL_CONFIG_MISSING")` desde v20.1, pero el test
`TAXID-03 safe placeholder when nothing found` seguia asertando el
comportamiento antiguo (`assert.strictEqual(id, 'BXXXXXXXX')`) y fallaba en
verde->rojo (suite offline 51/52).

Opciones evaluadas:
1. Restaurar el placeholder y ajustar el codigo al test.
2. Ajustar el test al codigo (lanzar) y documentar la decision.

## Decision
**Opcion 2 — LANZAR es el comportamiento canonico.** Sin NIF real no se
produce un resumen fiscal valido: emitir documentos fiscales con un NIF
ficticio es un riesgo de intrusismo/requerimiento AEAT mayor que el de
interrumpir el reporte interno. El placeholder `BXXXXXXXX` queda ERRADICADO
(cero ocurrencias fuera de comentarios/test que verifican su erradicacion).

Cambios aplicados juntos (productor + consumidores, regla H.5):
- Test `TAXID-03` reescrito como `assert.rejects(..., /FISCAL_CONFIG_MISSING/)`.
- Consumidor `getQuarterlyTaxSummaryInternal` ya mapea el throw a
  `{ status: "ERROR", error: FISCAL_CONFIG_MISSING }` (respuesta envoltorio
  canonica DTO-whitelist); no se modifica.
- Este ADR documenta la decision para cerrar la divergencia.

## Consecuencias
- Suite offline verde de nuevo (54/54 con las adiciones de cron-parity).
- Toda publicacion fiscal exige fila `CONFIG_SISTEMA`/EMISOR activa con NIF;
  la ausencia se senala de forma explicita y accionable (alerta/config), no
  se silencia con datos falsos.
- Grep negativo: `"BXXXXXXXX"` solo aparece en este ADR, en el comentario del
  agregador (erradicacion documentada) y en el nombre del test TAXID-03.
