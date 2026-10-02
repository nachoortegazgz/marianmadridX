# ADR-04 — Degradación de ComplementosCatalogo y ProveedoresLista a reservadas

- **Fecha:** 02/10/2026
- **Estado:** Aceptado
- **Norma:** Plan SSOT v7 (objetivo 21→12 colecciones activas) · MATRIZ §H.5

## Contexto
Tras la consolidación FASE 4, quedan dos colecciones con esquema definido pero
**cero consumidores vivos**: `ComplementosCatalogo` (add-ons de servicio nunca
lanzados comercialmente) y `ProveedoresLista` (datos de proveedores hoy viven
en `DatosFiscales` + documentos de compra). Mantenerlas "activas" infla el
conteo, obliga a mantener hooks/permisos muertos y contradice el criterio de
mínima superficie del CMS.

## Decisión
Degradar ambas de ACTIVAS a `RESERVED_COLLECTIONS`:
1. Se mueven al grupo `RESERVED_COLLECTIONS` en `internalConfig.js`.
2. No se borran del CMS (preservan esquema y posibles datos históricos) ni se
   eliminan sus índices; simplemente ningún módulo nuevo puede escribir en ellas
   y los tests de guardia fallan si aparece un consumidor.
3. Promoción de vuelta a activas: requiere decisión de producto documentada y
   alta de hooks §13 completos — no basta con importar la constante.

## Criterio profesional aplicado (Regla de Oro 4)
El plan pedía "degradar", no "eliminar": al no poder verificar export CSV de
contenido real en entorno offline, se elige la vía conservadora (reservada) que
cumple el objetivo de conteo de colecciones ACTIVAS sin riesgo de pérdida de
datos. Documentado aquí para revisión posterior.

## Consecuencias
- Conteo activo baja hacia los 12 objetivo; superficie de permisos reduce.
- Deuda controlada: dos esquemas dormidos con ruta de reactivación explícita.

## Evidencia
`RESERVED_COLLECTIONS` en `src/backend/internalConfig.js`; suites de guardia en
`src/backend/__tests__/`.
