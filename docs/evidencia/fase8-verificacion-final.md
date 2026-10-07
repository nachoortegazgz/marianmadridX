FASE 8 - VERIFICACION FINAL POST ETAPA C (2026-10-07)
=====================================================
Baseline:            57/57 pass  (baseline-tests.log)
Post-migracion:      57/57 pass  (final-post-C3-tests.log)

GREPS NEGATIVOS
from "wix-data" salvo dataClient ............ 0
consistentRead en call-sites ................ 0 (2 menciones documentales: mmSecrets.js:57, dataClient.js:26)
wix-secrets-backend en import ............... 0
wix-members-backend en import ............... 0
wix-ecom-backend en import .................. 0
wix-data en src/pages + src/public .......... 0
ALIAS COLLECTIONS fuera de categorias SSOT .. 0

GREPS POSITIVOS
from "backend/dataClient" ................... 18
consistencyMode: "strong" ................... 18 grep plano = 17 call-sites reales + 1 cabecera DAL
consistencyMode: "eventual" ................. 2

REGRESION IDs (main vs HEAD, ficheros tocados por Etapa C)
total coincidencias legacy main=65 actual=65 -> 0 nuevas introducidas
Residuo global 90 = preexistente en main (public/, pages/, tests/, validation.js),
fuera del alcance Etapa C. Campo CUSTOM "invoiceNumber"/"taxRate" en colecciones
fiscales es alias interno NO-AEAT: el payload AEAT usa numSerieFactura/
tipoImpositivo (verificado eventLog.js:174,359). No tocar sin ADR propio.

node --check todos los .js de src/backend ... verde
G10 ASCII estricto en ficheros tocados ...... verde

> Nota: artifacts/ esta en .gitignore (regla C0b). La evidencia versionable se archiva en docs/evidencia/. Logs crudos disponibles localmente en artifacts/evidencia-fase8/.

## Addendum FASE8-C5 (2026-10-07): resolucion de la discrepancia de IDs

La nota de "deuda detectada" del informe C4 queda formalizada en **ADR-11**
(`docs/adr/ADR-11-fiscal-field-naming-anomaly.md`):

- Hallazgo verificado: 65 coincidencias `invoiceNumber|taxRate` en src/backend y 2 en
  `UNPAID`, TODAS preexistentes en main. Comparacion por fichero tocado
  (main vs HEAD): recuentos identicos -> **0 nuevas introducidas por la Etapa C**.
- Diagnostico: contrato dual deliberado (AEAT-canonical vs CUSTOM-interno) codificado
  en los requiredFields de audit.e2e.js; no es residuo sino esquema vivo con
  consumidores en CMS real (sin export CSV offline no verificable).
- Decision ADR-11: NO renombrar (linea roja de irreversibilidad fiscal); congelar el
  contrato; reglas R11.1-R11.4; plan de remediation condicionado a export CSV + ADR
  sustitutorio.
- UNPAID: ambas coincidencias benignas (test guardian de erradicacion + normalizador
  read-only legacy EOL 31/12/2026 con log.warn). Sin accion.
- Baseline autorizado archivado (local, gitignored): `artifacts/evidencia-fase8/inventario-ids-post-cierre.txt` (88 lineas totales src/).

Verificacion tras el addendum: bateria offline **57/57 pass / 0 fail** (re-ejecutada).
