# CIERRE — Refactorización SSOT v7 · marianmadridV

- **Fecha:** viernes, 02 de octubre de 2026
- **Alcance:** Plan SSOT completo (Fases 0–6) sobre `github.com/nachoortegazgz/marianmadridV`
- **Resultado:** CMS consolidado, enums canónicos, hooks §13 completos, suites verdes.

---

## 1. Checklist "Definición de Hecho" (§22 del plan)

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 1 | Baseline y suites finales verdes | ✅ | baseline 49/52 → final **52/52 pass, 0 fail** (`src/backend/tests/`, runners `unit.testRunner.runner.mjs` 10/10, `audit.e2e.runner.mjs` 1/1) |
| 2 | Greps negativos = 0 | ✅ | `\bCOLLECTIONS\b` aislado = 0; `UNPAID` solo en normalizador legacy de `validation.js` + aserción de erradicación en test; `ConfiguracionFiscal` solo como término PROHIBIDO (lista bloqueada + comentario) |
| 3 | `validation.js` operativo con cobertura §12.4 | ✅ | `assertValidEnum`, normalizadores legacy→canónico con EOL 31/12/2026 documentado |
| 4 | Hooks §13 completos | ✅ | CitasF2 beforeInsert/Update · MovimientosInventario append-only · WEBHOOK_EVENT append-only condicional · RegistrosHorariosStaff (adjustmentReason) · MovimientosCaja (traceId + LEDGER schema) |
| 5 | Hooks de colecciones bloqueadas retirados (ADR-02) | ✅ | `BLOCKED_UNVERIFIED_COLLECTIONS`: SecuenciaTickets, InventarioStockVentaCierre — sin hooks en `data.js` |
| 6 | `prepareScheduledManagerPackages` solo en `fiscalDocuments.web.js` | ✅ | grep único consumidor |
| 7 | `_getBusinessTaxId` lee `DatosFiscales`/`nifProductor` | ✅ | `fiscalAggregator.web.js` (comentario BIBLIA 10 / SSOT-09) |
| 8 | `_read*` agregador con primario canónico AEAT | ✅ | `numSerieFactura`, `tipoImpositivo` primero; test `fiscalAggregator.read.test.mjs` verde |
| 9 | `BOOKING_TYPE` canónico persistido; detector `.includes("f2")` eliminado | ✅ | `normalizeBookingType()` en `bookingCore._persistBooking`; `isDualBookingType()` sustituye detección por subcadena |
| 10 | Alias `COLLECTIONS` y `UNPAID` erradicados | ✅ | FASE 3: export eliminado del productor + 4 consumidores parcheados en el mismo commit |
| 11 | `ControlOperativo`: schema + índices + migración + consumidores | ✅ | CONTROL_TYPE/CONTROL_STATUS en producer; bookingCore/bookingSaga/crons/cajas.web/eventes escriben con `controlType`+`dedupeKey`+`traceId`; script `tools/migrate-control-operativo.mjs` (dry-run default, CSV §H.1 previo) |
| 12 | Frontend: duplicados muertos fuera, DTO-whitelist testeada, `permissions.json` resuelto | ✅ | Eliminado `Calendario de reservas.zfv13.js` (0 líneas, cero referencias); eliminado `permissions.json` stub huérfano (cero consumidores, contenido vacío `{web-methods:{}}`); `dto.whitelist.test.mjs` verde (envolvente `{ok,data,error}`, sin `previousRecordHash`) |
| 13 | `jobs.config`, `widgetBridge.js`, `mmUtils.js` intactos | ✅ | Sin cambios en working tree ni en commits |
| 14 | 5 ADRs emitidos | ✅ | `docs/adr/ADR-01…ADR-05` (recordDomain, retiro bloqueadas, email MapaStaff, degradación colecciones, append-only condicional) |
| 15 | Push con tag `ssot-v7-aligned` | ⚠️ | Commits atómicos creados localmente + tag `ssot-v7-aligned`. **El push a remoto queda pendiente**: este entorno no dispone de credenciales del repositorio `nachoortegazgz/marianmadridV` (Regla de Oro 4: documentar y continuar). Comando: `git push origin main --tags` |

## 2. Commits ejecutados (productor + consumidores juntos, §H.5)

1. `fix(ssot) FASE1-P0` — exports rotos (EU_VAT_PREFIXES, FISCAL_ROLE, ITEM_NATURE), BOOKING_TYPE canónico, UNPAID fuera, fiscal agregador AEAT-first/DatosFiscales.
2. `feat(ssot) FASE2` — validation.js + hooks §13 + retirada de bloqueadas.
3. `refactor(ssot) FASE3` — erradicación alias COLLECTIONS (grep negativo = 0).
4. `refactor(cms) FASE4` — ControlOperativo 8-en-1: discriminadores, hooks, crons de purga, script de migración.
5. `chore(front) FASE5` — higiene: duplicado zfv13 y permissions.json huérfano fuera; DTO-whitelist cerrada en verde.

Cada commit es revertible de forma independiente; la suite se mantiene verde tras cada uno.

## 3. Deuda controlada / siguientes operaciones manuales

- **Migración de datos vivos:** ejecutar `node tools/migrate-control-operativo.mjs --dry-run` contra el sitio real (requiere `WIX_ACCESS_TOKEN`), revisar CSVs en `artifacts/evidencia-fase4/`, luego `--execute`. Solo WEBHOOK_EVENT + COMPENSATION; el resto es efímero y lo purgan los crons.
- **Borrado físico** de SecuenciaTickets e InventarioStockVentaCierre en el CMS tras export CSV (ADR-02 punto 3).
- **Push + tag** cuando haya credenciales de remoto.
- Normalizadores legacy de `validation.js`: retirar tras EOL **31/12/2026**.

## 4. Verificación reproducible

```bash
node --check $(find src -name "*.js")            # sintaxis OK
node --experimental-loader ./src/backend/tests/loader.mjs --test src/backend/tests/   # 57/57 (52 base + suite crons.jobsConfigParity; re-ejecutado 2026-10-02)
node --experimental-loader ./src/backend/tests/loader.mjs src/backend/tests/unit.testRunner.runner.mjs  # 10/10
node --experimental-loader ./src/backend/tests/loader.mjs src/backend/tests/audit.e2e.runner.mjs        # 1/1
```

Grep negativo FASE 3:
```bash
grep -rn "\bCOLLECTIONS\b" src --include="*.js" --include="*.mjs" \
  | grep -vE "BUSINESS_COLLECTIONS|OPERATIONAL_COLLECTIONS|RESERVED_COLLECTIONS|HISTORICAL_COLLECTIONS|_COLLECTIONS" \
  | grep -v "tests/unit.ssot.v5011.test.mjs"   # unico match permitido: asercion de erradicacion en comentario del test
# → 0 resultados
```
