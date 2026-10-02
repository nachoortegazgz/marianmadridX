# ADR-02 — Retiro de colecciones bloqueadas sin evidencia de esquema

- **Fecha:** 02/10/2026
- **Estado:** Aceptado
- **Norma:** BIBLIA VV v7.0 §13 · MATRIZ §H.1 (evidencia antes que destrucción)

## Contexto
Dos colecciones — `SecuenciaTickets` e `InventarioStockVentaCierre` — no tienen
consumidores vivos verificables ni datos exportables relevantes, pero conservan
hooks heredados que ejecutan lógica de validación muerta y consumen presupuesto
de runtime en cada operación de sus dominios vecinos.

## Decisión
En lugar de eliminarlas directamente (imposible sin confirmar ausencia de
dependencias externas):
1. Se listan en `BLOCKED_UNVERIFIED_COLLECTIONS` (`internalConfig.js`) como
   inventario formal de retiro.
2. Se RETIRAN sus hooks de `data.js` (ya no hay comportamiento de backend para
   ellas): cualquier escritura futura cae con error de esquema, no con validación
   silenciosa.
3. Su borrado físico del CMS queda pendiente de una operación manual con
   export CSV previo (§H.1); mientras figuren en la lista bloqueada, ningún
   código nuevo puede referenciarlas (test de guardia lo verifica).

## Consecuencias
- Hooks §13 más pequeños y auditables; cero rutas de escritura "zombi".
- Deuda conocida: dos colecciones siguen existiendo en el CMS hasta la operación
  de limpieza manual documentada en CIERRE.md.

## Evidencia
Bloque `BLOCKED_UNVERIFIED_COLLECTIONS` en `src/backend/internalConfig.js`;
ausencia de `SecuenciaTickets_*`/`InventarioStockVentaCierre_*` en `data.js`.
