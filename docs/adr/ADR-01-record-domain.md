# ADR-01 — Dominio canónico de registros (Record Domain)

- **Fecha:** 02/10/2026
- **Estado:** Aceptado
- **Norma:** BIBLIA VV v7.0 §12/§13 · MATRIZ CAMBIO IDS 30/09/2026 (SSOT-01)

## Contexto
El CMS tenía 21 colecciones activas con solapamientos semánticos: dominios de
negocio (Citas, MovimientosCaja, DatosFiscales), operativos transitorios
(SlotLocks, RateLimitBlocks, caches) y legacy (alias `COLLECTIONS`, enums con
valores dobles como `BOOKING_TYPE.NORMAL` + `SIMPLE`). Los consumidores
importaban desde un export paraguas ambiguo, lo que impedía razonar sobre
permisos, índices y ciclo de vida por dominio.

## Decisión
Se establece un único dominio por registro con cuatro grupos explícitos en
`internalConfig.js`:

| Grupo | Semántica | Ejemplos |
|---|---|---|
| `BUSINESS_COLLECTIONS` | Entidades de negocio persistentes | CitasF1/F2, MovimientosCaja, DatosFiscales |
| `OPERATIONAL_COLLECTIONS` | Estado de control efímero/reconstruible | ControlOperativo (8-en-1), colas de sincronización |
| `RESERVED_COLLECTIONS` | Esquema reservado sin consumidores vivos | ComplementosCatalogo, ProveedoresLista (ADR-04) |
| `HISTORICAL_COLLECTIONS` | Solo lectura / append-only fiscal | series Veri*Factu, cierres |

Reglas:
1. Todo documento declara su grupo; está prohibido escribir datos de negocio en
   el grupo operativo y viceversa.
2. El alias paraguas `COLLECTIONS` queda ERRADICADO del productor y de todos
   los consumidores (FASE 3). Grep negativo `\bCOLLECTIONS\b` = 0.
3. Productor y consumidores se modifican en el MISMO commit (MATRIZ §H.5).

## Consecuencias
- Positivas: permisos e índices por dominio; auditoria SSOT trivial; el plan
  21→12 colecciones se vuelve verificable mecánicamente.
- Negativas: los imports existentes requirieron codemod determinista (hecho,
  4 consumidores finales: bookingCore, bookingSaga, crons, cajas.web).

## Evidencia
`artifacts/evidencia-fase0/greps-baseline.txt` y grep negativo post-FASE3.
