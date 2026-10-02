# ADR-07: Escrituras BOOKING_TYPE canonicas en bookingSaga (FASE 1)

- Fecha: 2026-10-02
- Estado: ACEPTADO
- Relacion: BIBLIA VV v7.0 SSOT-07/11.2, MATRIZ CAMBIO IDS seccion G (BOOKING_TYPE), regla transversal "Cero fallback en escritura"

## Contexto
La evidencia de FASE 0 demostro que los P0 originales (exports rotos,
duplicidad fiscal, alias COLLECTIONS, consolidacion ControlOperativo,
validation.js + hooks parciales) ya estaban resueltos en HEAD tras la PR #2.
El unico residuo P0 real restante era en bookingSaga.js: dos escrituras de
`bookingType` usaban literales legacy `DUAL_F1` / `DUAL_F2`, no canonicos
segun el enum BIBLIA 11.2 (`SIMPLE` / `DUALF1` / `DUALF2`).

Aunque `normalizeBookingType()` (solo lectura, EOL 31/12/2026) tolera esos
alias en inbound, la regla transversal prohibe fallbacks legacy en
SCRITURA fuera de validation.js. Los consumidores criticos
(citasManager.web.js) comparan con `=== BOOKING_TYPE.DUALF2`, por lo que un
registro persistido con `DUAL_F2` dependia de la normalizacion de lectura
para ser detectado como F2: punto fragil de integridad.

## Decision
Sustituir los dos literales de escritura en `_persistBooking` (rama F1 y
rama F2 del flujo dual) por las constantes canonicas
`BOOKING_TYPE.DUALF1` / `BOOKING_TYPE.DUALF2` / `BOOKING_TYPE.SIMPLE`,
aniadiendo `BOOKING_TYPE` al import de `backend/internalConfig`.

No se crea `tools/migrate-booking-type.js`: sin CSV Fase 0 que evidencie
valores `NORMAL/DUAL` persistidos en CitasF2, una migracion destructiva
vulneraria MATRIZ H.1 (evidencia antes que destraccion). Queda pendiente
para el operador exportar el CSV; si aparecen valores legacy, la lectura
canonica via normalizeBookingType cubre la compatibilidad hasta el EOL.

## Consecuencias
- Escrituras 100% canonicas; cero dependencia del adaptador legacy en el camino de ida.
- Greps negativos `DUAL_F1|DUAL_F2` en src/backend/booking/*.js = 0 (excepto mapa de normalizacion de lectura en internalConfig, deliberado).
- Suite offline 52/52 verde; unit.testRunner y audit.e2e verdes.
