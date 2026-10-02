# INFORME DE EVIDENCIA — FASE 0 (SSOT v7.0 · Marian Madrid)

**Fecha de ejecución:** 2026-10-02T05:54Z
**Rama verificada:** HEAD `717be39` (merge PR #2 `ssot-refactoring-marian-madrid-23833`), working tree limpio.
**Alcance:** Solo evidencia y baseline. Sin cambios de código (regla FASE 0).

---

## 1. Estado del repositorio

| Ítem | Resultado |
|---|---|
| Clonación | Ya presente en `/workspace` (repo git inicializado con el código actual del usuario). No se re-clonó para no duplicar estado. |
| `npm install` | **No ejecutable en este entorno**: no hay acceso a registry/network disponible y el harness de tests (`src/backend/tests/loader.mjs`) está diseñado deliberadamente para correr **sin `node_modules`** (mocks offline de todos los módulos `wix-*`). Se documenta como limitación de entorno, no como fallo del sistema. |
| Suite de tests (harness offline) | `node --experimental-loader ./loader.mjs --test` → **52/52 PASS, 0 FAIL** (histórico). Actualización plan de corrección 2026-10-02: suite ampliada a **57/57 PASS, 0 FAIL** con la nueva suite `crons.jobsConfigParity.test.mjs` (CRON-PARITY-01/02, CRON-Z-01~03, CRON-AUDIT-01~03), más runners auxiliares 10/10 y 1/1. El archivo histórico `baseline-tests.txt` registraba 3 fallos DTO (DTO-02/04/05) que ya están verdes en HEAD actual. |
| `node --check` | Verde en los 33 archivos `.js` de `src/backend/*.js` y `src/backend/booking/*.js` (0 errores de sintaxis). |
| Tag `pre-ssot-migracion-fase0` | **NO creado**: el repo es un snapshot grafted (historial truncado); la política de rollback queda cubierta por el commit base visible `717be39`. Pendiente de crear cuando haya credenciales de remote. |
| `artifacts/evidencia-fase0/` | Existe; contiene `baseline-tests.txt`, `greps-baseline.txt` (histórico) y `greps-renovadas-20261002.txt` (salidas literales de esta sesión). |
| `docs/adr/` | Existe con ADR-01 a ADR-05. |

## 2. Evidencia CSV desde Wix Studio

**Imposibilidad documentada:** este entorno no tiene sesión de Wix Studio ni credenciales del site, por lo que **no es posible exportar CSV físicos** (`CitasF2`, `MovimientosCaja`, `ServiciosCatalogo`, las 8 colecciones a consolidar, `ComplementosCatalogo`, `ProveedoresLista`). Según la regla MATRIZ §H.1 (evidencia antes que destrucción), cualquier retirada/renombrado físico de campos en fases posteriores queda **bloqueado hasta que el operador exporte los CSV** y se archiven en `artifacts/evidencia-fase0/csv/`. La evidencia de código fuente obtenida mediante greps se detalla abajo y es suficiente para desambiguar los consumidores lógicos.

Verificaciones condicionales derivadas del análisis de código (a confirmar con CSV):
- `CitasF2`: el campo canónico en uso es **`bookingStatus`** (hooks `CitasF2_beforeInsert/Update` en `data.js:854+` y normalizadores read-only en `validation.js`). No se detectó lectura de `status` como alias activo fuera de proyecciones DTO. ADR propuesto si el CSV muestra filas con `status`: programar renombrado antes de EOL.
- `MovimientosCaja`: lecturas fiscales en `fiscalAggregator.web.js` ya son **AEAT-first con fallback legacy + warning** (`_readTaxRate` lee `tipoImpositivo` primero; logra `legacy-read taxRate`).
- Valores legacy persistidos observados en normalizadores de solo-lectura: `CONFIRMADO→CONFIRMED`, `PAGADO→PAID` (visible en el log WARN de la suite `data.hooks.test.mjs`), `NORMAL→SIMPLE`, `DUAL→DUALF1` y `DUAL_F2→DUALF2` vía `normalizeBookingType` (`internalConfig.js:1020-1028`; DUALF1/DUALF2 canónicos).

## 3. Greps de evidencia (salidas literales en `greps-renovadas-20261002.txt`)

### 3.1 P0 imports rotos — RESUELTOS en HEAD actual
```
grep -n "EU_VAT_PREFIXES|FISCAL_ROLE" src/backend/internalConfig.js
  → internalConfig.js:736 export const FISCAL_ROLE; :741 export const EU_VAT_PREFIXES ✔ presentes
grep -rn "EU_VAT_PREFIXES|FISCAL_ROLE" src/backend/data.js
  → data.js:30-31 imports resueltos; uso real en :91, :173, :288 ✔ sin import roto
```

### 3.2 Alias COLLECTIONS — ERRADICADO (FASE 3 ya aplicada en HEAD)
```
grep -rn "\bCOLLECTIONS\b" src/ --include="*.js" | grep -vE "BUSINESS_|OPERATIONAL_|FORBIDDEN_"
  → 0 consumidores. Solo quedan comentarios históricos en internalConfig.js (lineas 70-147
    declaran la erradicación; NO existe export COLLECTIONS activo).
```

### 3.3 Claves a retirar F1 — CASI LIMPIO
```
CATEGORIAS_SERVICIO / LIBRO_REGISTRO_FACTURAS_EXPEDIDAS:
  → 0 en código de producción. Solo 3 referencias textuales en __tests__ legacy
    (professional.testRunner.js:495, audit.e2e.js:246/262) como string de reporte, no como clave activa.
BOOKING_TYPE.NORMAL / BOOKING_TYPE.DUAL: → 0 ocurrencias ✔ (enum canónico SIMPLE/DUALF1/DUALF2 vigente)
PAYMENT_STATUS.UNPAID: → 0 ocurrencias en código ✔ (queda traducción defensiva
  UNPAID→NOT_PAID en bookingCore.js:168 y validation.js:40, coherente con "cero fallback en escritura").
```

### 3.4 Duplicidad fiscal — RESUELTA
```
prepareScheduledManagerPackages:
  → fiscalAggregator.web.js:515 = comentario "REMOVED here (BIBLIA 17.6 dedupe)" ✔
  → Productor único: fiscalDocuments.web.js:310 ✔
  → crons.js: NO importa prepareScheduledManagerPackages (grep de imports fiscales en crons.js = vacío) ✔
  → Test anti-duplicidad activo: tests/fiscalAggregator.read.test.mjs DEDUPE-01 ✔ (en verde)
```

### 3.5 Detector `.includes("f2")` en citasManager.web.js — RESUELTO
```
grep 'includes("f2")' src/backend/citasManager.web.js → 0 ocurrencias.
Uso canónico presente: cita?.bookingType === BOOKING_TYPE.DUALF2 (lineas 869, 879) ✔
```

### 3.6 Consumidores de las 8 colecciones a consolidar — ABSORBIDAS (FASE 4 ya aplicada en HEAD)
```
grep SLOT_LOCKS|PROCESSED_WEBHOOK_EVENTS|RATE_LIMIT_BLOCKS|BOOKING_TRANSACTIONS|
     COMPENSACIONES_PENDIENTES|ALERTAS_OPERATIVAS|AVAILABILITY_DAYS_CACHE|DUAL_SLOT_CACHE
  → 0 consumidores funcionales. Solo 3 menciones en comentarios (internalConfig.js:893, audit.js:8/14).
  → Sustituto vigente: OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO + CONTROL_TYPE (8 subtipos)
    + CONTROL_STATUS + hooks ControlOperativo_before* con test dedicado (controlOperativo.hooks.test.mjs, 7/7 verde).
```

### 3.7 Legacy A-E MATRIZ — PENDIENTE (riesgo documentado)
Campos legacy aún leídos/esritos en producción (deben migrarse según MATRIZ, con evidencia CSV previa):
- `taxRate`: `events.js` (escrituras :529/:697/:944/:969), `eventLog.js` (:359/:428/:525/:764), `contabilidad.js` (:82/:202/:227/:398), `fiscalAggregator.web.js` (fallback de lectura ya instrumentado).
- `staffDisponible`: `bookingSaga.js:596` (mapping UX con fallback).
- `dateYMD`: `pages/Calendario de reservas 2.q39h6.js:164/170` (frontend).
- `slugUrl / phase2ServiceId / linkFases / addonId / imageUrl / hiddenClient`: 0 ocurrencias ✔.

### 3.8 Frontend limpio — VERDE
```
grep -rn "wix-data" src/pages src/public --include="*.js" → 0 resultados ✔
```

## 4. Inventario de verificación de FASE 0

| Tarea del plan | Estado |
|---|---|
| Clone + npm install | Parcial: repo presente; install no viable sin red (harness offline compensa) |
| npm test + node --check | ✅ 57/57 tests verdes (re-ejecucion 2026-10-02, post plan de correccion; historico: 52/52); node --check 33/33 archivos |
| Tag pre-ssot-migracion-fase0 | ⚠️ No creado (repo grafted, sin credenciales remote) |
| Export CSV Wix Studio | ❌ Imposible en este entorno — documentado (§2); bloqueante para escrituras destructivas de FASE 4+/retiros |
| Greps de evidencia archivados | ✅ `greps-renovadas-20261002.txt` + `greps-baseline.txt` |
| Este INFORME.md | ✅ |

## 5. Conclusión

El HEAD actual **ya incorpora los parches objetivo de FASE 1, 2, 3 y 4** (exports restaurados, enums canónicos, AEAT-first, validation.js, hooks §13, alias COLLECTIONS erradicado, ControlOperativo 8-en-1 con tests). Los restos identificados para fases siguientes son:

1. **Higiene legacy A-E** (§3.7): migrar `taxRate`, `staffDisponible`, `dateYMD` — requiere CSV previo.
2. **Referencias textuales legacy en `__tests__`** (§3.3) — cosmético, suites existentes intocables por regla transversal.
3. **CSV de evidencia física** — única tarea de FASE 0 no reproducible en este sandbox; debe ejecutarla el operador en Wix Studio antes de cualquier retiro destructivo.

**Sin este informe, FASE 1 no se ejecuta.** Esperando `CONTINUAR`.

---

## ANEXO FASE 1 (2026-10-02) — Verificacion P0 y residuo corregido

Resultado de la re-auditoria de los 6 parches P0 planificados sobre HEAD actual:

| Parche F1 | Estado previo | Accion |
|---|---|---|
| internalConfig.js (exports/enums/collections) | YA APLICADO (EU_VAT_PREFIXES, FISCAL_ROLE, ITEM_NATURE, BOOKING_TYPE SIMPLE/DUALF1/DUALF2, sin UNPAID, FORBIDDEN 8, RESERVED/HISTORICAL) | Verificado por greps = 0 |
| fiscalAggregator.web.js (dedupe + AEAT-first) | YA APLICADO (prepareScheduledManagerPackages eliminado, _getBusinessTaxId lee DatosFiscales/CONFIG_SISTEMA/nifProductor con adapter legacy documentado + warning) | Verificado |
| citasManager.web.js (detector === DUALF2) | YA APLICADO (lineas 869/879) | Verificado |
| bookingCore.js (normalizeBookingType en writes) | YA APLICADO (linea 803) | Verificado |
| **bookingSaga.js (writes literales)** | **RESIDUO P0: "DUAL_F1"/"DUAL_F2" legacy en escrituras 1567/1619** | **CORREGIDO: BOOKING_TYPE.DUALF1/DUALF2/SIMPLE + import** |
| crons.js (re-apuntar producer) | YA APLICADO (cero referencias; producer unico fiscalDocuments.web) | Verificado |
| tools/migrate-booking-type.js | CONDICIONAL NO EJECUTADO: sin CSV CitasF2 (MATRIZ H.1) | ADR-07 |

Greps post-fix (todas = 0): alias COLLECTIONS., UNPAID en internalConfig,
BOOKING_TYPE.NORMAL/DUAL, DUAL_F1/DUAL_F2 en src/backend/booking/*.js.
Suite offline: 52/52 pass. node --check: 7 archivos OK.
Commit: 5d2c619.
