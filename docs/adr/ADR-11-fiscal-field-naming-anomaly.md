# ADR-11: Anomalia de nombres en campos fiscales CUSTOM (invoiceNumber / taxRate)

- Estado: ACEPTADO (decision de NO-ACTUACION inmediata + plan de remediation)
- Fecha: 2026-10-07
- Contexto: cierre FASE8 / Etapa C (ADR-10), verificacion final post-migracion SDK v2
- Relacion: BIBLIA SSOT v8.0-MASTER, GUIA REFACTOR S1.2, DOSSIER CMS REFACTOR v7.3, ADR-10

## 1. Hallazgo (evidencia literal)

El grep del checklist S7.1 (`slugUrl|taxRate|invoiceNumber|UNPAID|hiddenClient|addonIds`)
sobre src/ devuelve coincidencias que la premisa de partida ("IDs ya alineadas, 0 legacy")
daba por inexistentes. Desglose verificado:

### 1.1 invoiceNumber / taxRate (65 coincidencias en src/backend, preexistentes en main)
No son un residuo aleatorio: forman un **contrato interno coherente y activo**:

- `eventLog.js` escribe documentos fiscales con ambos nombres simultaneamente:
  - AEAT-canonical: `numSerieFactura`, `tipoImpositivo`, `cuotaTotal` (usados en el
    payload TBA/hash chain, lineas 174, 350, 359).
  - CUSTOM-interno: `invoiceNumber`, `taxRate` (lineas 275, 359, 413, 428, 763...).
- `audit.e2e.js:1053` declara `invoiceNumber` como **requiredField** del esquema de
  `MovimientosCaja`; `audit.e2e.js:1058` declara `numSerieFactura` como requiredField
  de OTRA coleccion fiscal. Es decir: los tests de auditoria codifican a proposito la
  coexistencia de ambos vocabularios segun coleccion.
- Consumidores vivos de `.invoiceNumber` / `.taxRate`: cajas.web, events.js,
  fiscalAggregator.web, contabilidad.js, fiscalDocuments.web (helper `_readInvoiceValue`
  hace fallback doble `invoiceNumber -> numTicketFactura`), reservas.web, qrHelper.js
  (pagina publica), professional.testRunner.js.
- 0 fixtures JSON persistidas en repo (el esquema real vive solo en el backoffice Wix).

### 1.2 UNPAID (2 coincidencias, ambas benignas)
- `unit.testRunner.js:150`: asercion de que el alias UNPAID esta ERRADICADO (test
  guardian, debe existir).
- `validation.js:46`: entrada de `PAYMENT_LEGACY_MAP`, normalizador read-only EOL
  31/12/2026 que traduce valores legacy de datos HISTORICOS a canonicos al vuelo,
  sin inventar datos ni escribirlos. Patrocinado por el patron "sin evidencia no hay
  destruccion": mientras existan items legacy con paymentStatus="UNPAID" en el CMS,
  borrar el mapa rompe la lectura.

### 1.3 slugUrl / hiddenClient / addonIds: 0 coincidencias. OK.

## 2. Diagnostico

Los campos `invoiceNumber`/`taxRate` parecen ser claves CUSTOM **deliberadas** para
colecciones internas de operacion (ingles = convencion CUSTOM del Plan Maestro),
mientras que `numSerieFactura`/`tipoImpositivo`/`cuotaTotal` gobiernan las colecciones
de emision fiscal AEAT. La GUIA REFACTOR S1.2 resuelve conflictos de IDs pero no
documenta explicitamente este par dual por coleccion; el predecesor lo registro como
"residuo". La evidencia (tests de auditoria que exigen AMBOS sets como requiredFields
en colecciones distintas) apunta a diseno intencional, no a deuda.

## 3. Decision

**NO renombrar ahora.** Motivos, en orden de peso:

1. Linea roja de irreversibilidad: renombrar campos de colecciones fiscales exige
   export CSV previo + migracion de datos en vivo + confirmacion de esquema real,
   nada verificable offline desde este repo.
2. Riesgo regulatorio: si algun campo renombrado forma parte del calculo del hash
   chain o del payload TBA (Veri*Factu), cualquier error de mapeo invalida la cadena
   de registros existentes (RD 1619/2012). Un rename incorrecto es peor que un nombre
   esteticamente inconsistente.
3. Los tests de auditoria actuales (57/57 verdes) FALLARIAN con un rename parcial:
   `audit.e2e.js` fija los nombres requeridos por coleccion; renombrar sin actualizar
   el esquema del backoffice crea incoherencia repo<->CMS.
4. Cumplimiento legal real: el payload AEAT ya usa los nombres legales espanoles
   donde obliga la norma. Los nombres internos CUSTOM no estan regulados.

**Reglas operativas derivadas (vigentes desde este ADR):**

- R11.1 Queda prohibido introducir NUEVOS usos de `invoiceNumber`/`taxRate` en codigo
  de emision fiscal (facturas/ticket-BAI); usar siempre `numSerieFactura`/
  `tipoImpositivo`/`cuotaTotal` en capas de salida legal.
- R11.2 El contrato dual actual queda CONGELADO tal cual: renames, eliminaciones o
  "unificaciones" requieren export CSV del CMS + ADR nuevo que reemplace este.
- R11.3 El grep del checklist S7.1 se interpreta a partir de ahora con exclusion
  documentada: las coincidencias de `invoiceNumber|taxRate` listadas en artifacts/evidencia-fase8/inventario-ids-post-cierre.txt
  son baseline autorizado por este ADR; el criterio es "0 NUEVAS respecto al baseline".
- R11.4 `PAYMENT_LEGACY_MAP` (validation.js) se elimina en la ventana post-31/12/2026
  una vez confirmado via export CSV que ningun item conserva paymentStatus legacy.

## 4. Plan de remediation (si se activa en el futuro)

1. Export CSV de las colecciones implicadas desde el backoffice Wix (evidencia previa
   obligatoria).
2. Verificar que el esquema live coincide con los requiredFields de audit.e2e.js.
3. Renombre en CMS primero, codigo despues (productor+consumidores+tests en el mismo
   commit), con fase transitoria de doble lectura via helper tipo `_readInvoiceValue`.
4. Ejecutar verificacion de integridad fiscal S7.2 completa antes y despues.
5. Sustituir este ADR por ADR-NN con evidencia del diff cero-registros-perdidos.

## 5. Consecuencias

- El objetivo NORTH STAR sigue sin poder declararse ALCANZADO hasta E2E preview +
  gates externos (ver informe FASE8), pero la discrepancia entre premisa de partida
  y realidad del repo queda registrada y acotada, no oculta.
- Honestidad radical: la premisa "0 legacy" del prompt de arranque era parcialmente
  falsa; se corrige aqui con evidencia literal en lugar de ajustar el grep para que
  diera 0.
