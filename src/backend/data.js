/*
=============================================================================
MODULE: backend/data.js
VERSION: v9.0-SSOT-MASTER
BASE: BIBLIA v8.0-SSOT-MASTER + ANEXO SSOT v8.1 + cms.v8.1-FINAL.json
RESPONSIBILITY: Hooks de inmutabilidad y proteccion de ledgers fiscales/laborales.
                Validacion estructural delegada en backend/validation.js.
STANDARDS: G10 ASCII Strict. Cero friccion innecesaria.

CORRECTIONS APPLIED (v9.0):
  - Eliminados hooks sobre colecciones maestras CMS (ServiciosCatalogo, MapaStaff,
    ComplementosCatalogo). La validacion de negocio se realiza en el consumidor.
  - Eliminado _rejectActiveField: el campo 'active' no existe en el schema actual;
    su presencia ya genera error de schema nativo en Wix Data sin necesidad de hook.
  - Eliminadas validaciones redundantes de estructura basica (tipos primitivos,
    formatos simples) que solo reportaban errores sin corregir datos.
  - Mantenidos EXCLUSIVAMENTE hooks de integridad fiscal/laboral/contable que
    protegen la inmutabilidad del ledger o aplican correcciones automaticas.
=============================================================================
*/

import wixData from "backend/dataClient";

import {
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    INTEGRITY,
    RECORD_TYPE,
    isValidGuid,
} from "backend/internalConfig";

import {
    assertCitasF2,
    assertDatosFiscales,
    assertControlOperativo,
    assertRegistrosHorariosStaff,
    assertMovimientosInventario,
    expectedInventoryMagnitude,
    isValidNifOrEuVat,
} from "backend/validation";

import { logger } from "backend/logger";

const log = logger;

// =============================================================================
// BLOQUE 0 - HELPERS INTERNOS
// =============================================================================

const LEDGERSCHEMAVERSIONAEAT = INTEGRITY.LEDGER_SCHEMA_VERSION;
const CONTROLTYPE = CONTROL_TYPE;

const IMMUTABLEENTRYSTATUSES = new Set(["POSTED", "LOCKED"]);

const ALLOWEDZUPDATE_FIELDS = new Set([
    "closingSignature",
    "closingSignatureStatus",
    "verifiedAt",
    "approverUser",
    "_updatedDate",
]);

function _safeTrim(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
}

const safeTrim = _safeTrim;

function _isGuid(value) {
    return isValidGuid(value);
}

function _roundItem(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function _isV5Fiscal(item) {
    return safeTrim(item?.schemaVersion) === LEDGERSCHEMAVERSIONAEAT;
}

function _fiscalError(message) {
    throw new Error(`FISCAL_VIOLATION: ${message}`);
}

function _schemaError(message) {
    throw new Error(`SCHEMA_VIOLATION: ${message}`);
}

// =============================================================================
// BLOQUE 1 - HELPERS DE LECTURA FISCAL
// =============================================================================

function _readTaxableBase(item) {
    const v =
        item.taxableBaseOrNonSubjectAmount ??
        item.baseImponibleOImporteNoSujeto ??
        item.taxableAmount;
    return Number(v) || 0;
}

function _readTaxAmount(item) {
    const v = item.taxAmount ?? item.cuotaTotal;
    return Number(v) || 0;
}

function _readTotalAmount(item) {
    const v = item.totalAmount ?? item.importeTotal ?? item.amount;
    return Number(v) || 0;
}

function _readSurchargeAmount(item) {
    const v =
        item.surchargeAmount ??
        item.cuotaRecargoEquivalencia ??
        item.importeRecargoEquivalencia;
    return Number(v) || 0;
}

function _readRecipientTaxId(item) {
    return _safeTrim(
        item.recipientTaxId || item.nifDestinatario || item.nifTercero
    );
}

function _readRecipientLegalName(item) {
    return _safeTrim(
        item.recipientLegalName ||
            item.nombreRazonDestinatario ||
            item.razonSocialTercero
    );
}

function _readInvoiceType(item) {
    return _safeTrim(
        item.invoiceType || item.tipoFactura || item.claveRegistroFactura
    ).toUpperCase();
}

function _readBreakdownBaseAndTax(item) {
    let base = 0;
    let tax = 0;

    const breakdown =
        item.detailedBreakdown ||
        item.desgloseDetallado ||
        item.desgloseImpuestos ||
        item.lineItems;

    if (breakdown) {
        try {
            const arr =
                typeof breakdown === "string" ? JSON.parse(breakdown) : breakdown;
            if (Array.isArray(arr) && arr.length > 0) {
                base = arr.reduce(
                    (sum, d) =>
                        sum +
                        Number(
                            d.taxableBaseOrNonSubjectAmount ??
                                d.baseImponibleOImporteNoSujeto ??
                                d.base ??
                                0
                        ),
                    0
                );
                tax = arr.reduce(
                    (sum, d) =>
                        sum +
                        Number(d.chargedTaxAmount ?? d.cuotaRepercutida ?? d.cuota ?? 0),
                    0
                );
            }
        } catch (e) {
            _schemaError("detailedBreakdown/desgloseDetallado no es JSON valido");
        }
    }

    return { base, tax };
}

function _validateF1Requirements(item) {
    if (_readInvoiceType(item) !== "F1") return;

    const pf = item.fiscalPayload || item.payloadFiscal || {};
    const taxId = readRecipientTaxId(item) || safeTrim(pf.nifDestinatario);
    const legalName =
        readRecipientLegalName(item) || safeTrim(pf.nombreRazonDestinatario);
    const address = item.recipientAddress || pf.domicilioDestinatario || {};

    if (!taxId) _schemaError("Factura F1 exige recipientTaxId/nifDestinatario");
    if (!legalName) _schemaError("Factura F1 exige recipientLegalName");
    if (!address || !_safeTrim(address.cp)) {
        _schemaError("Factura F1 exige recipientAddress con cp");
    }
}

function _validateReverseCharge(item) {
    if (item.reverseCharge !== true && item.inversionSujetoPasivo !== true) return;
    const tax = _readTaxAmount(item);
    if (tax > 0) {
        _schemaError("inversionSujetoPasivo implica cuotaTotal = 0");
    }
}

function _validateAjuste(item) {
    if (_safeTrim(item.eventType).toUpperCase() !== "AJUSTE") return;
    if (!_safeTrim(item.previousInvoiceId)) {
        _schemaError("eventType=AJUSTE exige previousInvoiceId");
    }
}

function _validateRectificativa(item) {
    const tipo = _readInvoiceType(item);
    if (!tipo.startsWith("R")) return;
    if (!_safeTrim(item.previousInvoiceId)) {
        _schemaError("Factura rectificativa R1-R5 exige previousInvoiceId");
    }
}

function _validateFiscalPayload(item) {
    if (!_isV5Fiscal(item)) return;

    const eventType = _safeTrim(item.eventType).toUpperCase();
    if (!eventType) return;

    if (eventType !== "CIERRE_Z") {
        if (!_isGuid(item.thirdPartyId)) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }
        if (!item.fiscalPayload || typeof item.fiscalPayload !== "object") {
            _schemaError("fiscalPayload obligatorio (snapshot AEAT)");
        }
    }

    if (
        ["VENTALINEA", "COMPRALINEA", "RECTIFICATIVA", "MOV_STOCK"].includes(
            eventType
        )
    ) {
        if (!_isGuid(item.catalogId)) {
            _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
        }
    }

    if (
        !Number.isFinite(Number(item.sequenceNumber)) ||
        Number(item.sequenceNumber) <= 0
    ) {
        _schemaError("sequenceNumber debe ser mayor que 0");
    }

    if (!_safeTrim(item.recordHash)) {
        _schemaError("recordHash obligatorio (cadena SHA-256)");
    }
}

// =============================================================================
// BLOQUE 2 - MovimientosCaja (LEDGER APPEND-ONLY, Ley 11/2021)
// =============================================================================

export function MovimientosCaja_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const taxId = _readRecipientTaxId(item);
    if (taxId && !isValidNifOrEuVat(taxId)) {
        _schemaError(
            "recipientTaxId/nifDestinatario no tiene formato valido (NIF/VAT-UE)"
        );
    }

    const { base, tax } = _readBreakdownBaseAndTax(item);
    const finalBase = base > 0 ? base : _readTaxableBase(item);
    const finalTax = tax > 0 ? tax : _readTaxAmount(item);

    const withholding =
        Number(item.irpfWithholdingAmount || item.importeRetencionIRPF) || 0;
    const surcharge = _readSurchargeAmount(item);
    const total = _readTotalAmount(item);

    if (finalBase > 0 || finalTax > 0 || withholding > 0 || surcharge > 0) {
        const role = _safeTrim(item.fiscalRole || item.rolFiscal).toUpperCase();
        const withholdingFactor = role === "RECEPTOR" ? 1 : -1;

        const expected = _roundItem(
            finalBase + finalTax + surcharge + withholdingFactor * withholding
        );
        const diff = Math.abs(expected - total);
        if (diff > 0.02) {
            _schemaError(
                `Cuadre fiscal invalido (rol ${role}): base ${finalBase} + cuota ${finalTax} + recargo ${surcharge} ${withholdingFactor > 0 ? "+" : "-"} retencion ${withholding} = ${expected.toFixed(2)}, total ${total.toFixed(2)}`
            );
        }
    }

    _validateF1Requirements(item);
    _validateReverseCharge(item);
    _validateAjuste(item);
    _validateRectificativa(item);
    _validateFiscalPayload(item);

    if (
        Array.isArray(item.detailedBreakdown) &&
        item.detailedBreakdown.length > 0
    ) {
        let sumBase = 0;
        let sumTax = 0;
        for (const d of item.detailedBreakdown) {
            sumBase += Number(
                d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0
            );
            sumTax += Number(d.chargedTaxAmount ?? d.cuota ?? 0);
        }
        if (Math.abs(_roundItem(sumBase) - finalBase) > 0.02) {
            _schemaError(
                `detailedBreakdown.base (${sumBase}) no cuadra con cabecera (${finalBase})`
            );
        }
        if (Math.abs(_roundItem(sumTax) - finalTax) > 0.02) {
            _schemaError(
                `detailedBreakdown.cuota (${sumTax}) no cuadra con cabecera (${finalTax})`
            );
        }
    }

    if (item.catalogId) {
        const payloadRegimeKey = _safeTrim(item.fiscalPayload?.claveRegimen);
        const itemRegimeKey = _safeTrim(item.regimeKey);
        if (payloadRegimeKey && itemRegimeKey && payloadRegimeKey !== itemRegimeKey) {
            _schemaError("regimeKey no coincide con fiscalPayload.claveRegimen");
        }
    }

    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio en MovimientosCaja (SSOT-12)");
    }
    if (safeTrim(item.schemaVersion) !== LEDGERSCHEMAVERSIONAEAT) {
        _schemaError(`schemaVersion debe ser "${LEDGERSCHEMAVERSIONAEAT}"`);
    }

    return item;
}

export function MovimientosCaja_beforeUpdate() {
    _fiscalError(
        "Modificacion de MovimientosCaja prohibida por normativa fiscal (append-only, Ley 11/2021). Use eventType=AJUSTE o factura rectificativa R1-R5."
    );
}

export function MovimientosCaja_beforeRemove() {
    _fiscalError(
        "Borrado de MovimientosCaja prohibido por normativa fiscal (Ley 11/2021 + Veri*Factu)."
    );
}

// =============================================================================
// BLOQUE 3 - HistoricoCierresZ (LEDGER, actualizacion restringida a firma)
// =============================================================================

export function HistoricoCierresZ_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    if (!_safeTrim(item.recordDomain)) {
        _schemaError("HistoricoCierresZ.recordDomain obligatorio (ADR-01)");
    }
    if (!_safeTrim(item.traceId)) {
        _schemaError("HistoricoCierresZ.traceId obligatorio (SSOT-12)");
    }
    if (!item.operationDate) {
        _schemaError("HistoricoCierresZ.operationDate obligatorio");
    }

    const start = Number(item.startSequence);
    const end = Number(item.endSequence);
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
        _schemaError(`endSequence (${end}) no puede ser menor que startSequence (${start})`);
    }

    return item;
}

export function HistoricoCierresZ_beforeUpdate(item, context) {
    const previous = context?.original || {};
    const changes = Object.keys(item || {}).filter((key) => {
        const before = previous[key];
        const after = item[key];
        return String(before) !== String(after);
    });

    const onlySignatureFields = changes.every((key) =>
        ALLOWEDZUPDATE_FIELDS.has(key)
    );

    if (!onlySignatureFields) {
        _fiscalError(
            "Modificacion de HistoricoCierresZ prohibida. Solo se permite actualizar closingSignature/closingSignatureStatus/verifiedAt/approverUser."
        );
    }

    return item;
}

export function HistoricoCierresZ_beforeRemove() {
    _fiscalError(
        "Borrado de HistoricoCierresZ prohibido por normativa fiscal (Ley 58/2003 art. 29-30)."
    );
}

// =============================================================================
// BLOQUE 4 - RegistrosHorariosStaff (LEDGER, RD 8/2019)
// =============================================================================

export function RegistrosHorariosStaff_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    assertRegistrosHorariosStaff(item);
    return item;
}

export function RegistrosHorariosStaff_beforeUpdate() {
    _fiscalError(
        "Modificacion de RegistrosHorariosStaff prohibida (append-only, RD 8/2019 + Art. 34.9 ET). Use clockEventType=AJUSTE con adjustmentReason."
    );
}

export function RegistrosHorariosStaff_beforeRemove() {
    _fiscalError(
        "Borrado de RegistrosHorariosStaff prohibido. Retencion legal 4 anos (RD 8/2019)."
    );
}

// =============================================================================
// BLOQUE 5 - CajaActual (SINGLETON PROTEGIDO)
// =============================================================================

export function CajaActual_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const id = safeTrim(item.id);
    if (id !== "CAJAPRINCIPAL" && id !== "CAJASEQ") {
        _schemaError(
            "CajaActual.id debe ser CAJAPRINCIPAL o CAJA_SEQ (singleton, ADR-11)"
        );
    }
    if (!_safeTrim(item.traceId)) {
        _schemaError("CajaActual.traceId obligatorio (SSOT-12)");
    }

    return item;
}

export function CajaActual_beforeUpdate(item, context) {
    const previous = context?.original || {};

    const prevSeq = previous?.sequenceCounters;
    const nextSeq = item?.sequenceCounters;

    const changed =
        JSON.stringify(prevSeq || {}) !== JSON.stringify(nextSeq || {});

    if (changed && safeTrim(item?.id) !== "CAJA_SEQ") {
        _schemaError(
            "sequenceCounters solo modificable en documento id=CAJASEQ (ADR-12)"
        );
    }

    return item;
}

export function CajaActual_beforeRemove() {
    throw new Error(
        "SINGLETON_PROTECTED: No se puede eliminar el estado de caja (ADR-11)."
    );
}

// =============================================================================
// BLOQUES 6-7 - Catalogos maestros (ServiciosCatalogo, MapaStaff)
// SIN HOOKS. Colecciones maestras CMS: cero friccion en escritura.
// La validacion de negocio se realiza exclusivamente en el consumidor.
// =============================================================================

// =============================================================================
// BLOQUE 8 - LibroAsientosContablesDetalle (LEDGER CONTABLE, ADR-10)
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const code = _safeTrim(item.accountCode || item.cuentaContable);
    if (code && !/^\d{6}$/.test(code)) {
        _schemaError(`accountCode "${code}" no tiene formato PGC (6 digitos)`);
    }

    if (isV5Fiscal(item) || safeTrim(item.sourceEventId || item.eventoOrigenId)) {
        const sourceEventId = _safeTrim(item.sourceEventId || item.eventoOrigenId);
        const thirdPartyId = _safeTrim(item.thirdPartyId || item.terceroId);
        const catalogId = _safeTrim(item.catalogId || item.catalogoId);

        if (!_isGuid(sourceEventId)) {
            _schemaError("sourceEventId obligatorio (FK MovimientosCaja)");
        }
        if (!_isGuid(thirdPartyId)) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }
        if (!_isGuid(catalogId)) {
            _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
        }

        const lineNumber = Number(item.lineNumber ?? item.numeroLinea);
        if (!Number.isFinite(lineNumber) || lineNumber < 1) {
            _schemaError("lineNumber debe ser mayor o igual que 1");
        }

        if (!Number.isFinite(Number(item.units)) || Number(item.units) <= 0) {
            _schemaError("units debe ser mayor que 0");
        }

        const opDesc = _safeTrim(
            item.operationDescription || item.descripcionOperacion
        );
        if (!opDesc) {
            _schemaError("operationDescription obligatoria en lineas v5");
        }
    }

    if (!_safeTrim(item.traceId)) {
        _schemaError(
            "LibroAsientosContablesDetalle.traceId obligatorio (SSOT-12)"
        );
    }

    return item;
}

export async function LibroAsientosContablesDetalle_beforeUpdate(item) {
    return _validateAccountingLineParent(item);
}

export async function LibroAsientosContablesDetalle_beforeRemove(item) {
    return _validateAccountingLineParent(item);
}

async function _validateAccountingLineParent(item) {
    const parentStatus = _safeTrim(item?.parentEntryStatus);
    if (parentStatus && IMMUTABLEENTRYSTATUSES.has(parentStatus.toUpperCase())) {
        _fiscalError(
            "No se puede modificar o eliminar una linea de asiento POSTED o LOCKED"
        );
    }
    return item;
}

// =============================================================================
// BLOQUE 9 - DatosFiscales
// =============================================================================

export function DatosFiscales_beforeInsert(item) {
    return _validateDatosFiscalesSchema(item);
}

export function DatosFiscales_beforeUpdate(item) {
    return _validateDatosFiscalesSchema(item);
}

export function DatosFiscales_beforeRemove(item) {
    const id = safeTrim(item?.id);
    if (id === "CONFIGSISTEMAFISCAL") {
        _fiscalError(
            "CONFIGSISTEMAFISCAL es singleton protegido. No se puede eliminar."
        );
    }
    return item;
}

function _validateDatosFiscalesSchema(item) {
    if (!item || typeof item !== "object") return item;

    assertDatosFiscales(item);

    if (safeTrim(item.recordType) === RECORDTYPE.CONFIG_SISTEMA) {
        const nifProductor = _safeTrim(item.nifProductor || item.producerTaxId);
        if (!nifProductor || !isValidNifOrEuVat(nifProductor)) {
            _schemaError(
                "CONFIG_SISTEMA exige nifProductor valido (Veri*Factu, Ley 11/2021)"
            );
        }
    }

    return item;
}

// =============================================================================
// BLOQUE 10 - ComplementosCatalogo
// SIN HOOKS. Catalogo maestro CMS: cero friccion en escritura.
// =============================================================================

// =============================================================================
// BLOQUE 11 - CitasF2 (PROYECCION BOOKINGS)
// =============================================================================

export function CitasF2_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    assertCitasF2(item);
    return item;
}

export function CitasF2_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;
    assertCitasF2(item);
    return item;
}

export function CitasF2_beforeRemove(item) {
    return item;
}

// =============================================================================
// BLOQUE 12 - MovimientosInventario (LEDGER APPEND-ONLY)
// =============================================================================

export async function MovimientosInventario_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    assertMovimientosInventario(item);

    if (
        item.magnitude === undefined ||
        item.magnitude === null ||
        item.magnitude === ""
    ) {
        item.magnitude = expectedInventoryMagnitude(
            item.movementType,
            item.quantityDelta
        );
    }

    const token = _safeTrim(item.movementToken);
    const existing = await wixData
        .query(OPERATIONALCOLLECTIONS.MOVIMIENTOSINVENTARIO)
        .eq("movementToken", token)
        .limit(1)
        .find({ suppressAuth: true });

    if (existing?.items?.length > 0) {
        _fiscalError(`movementToken duplicado en MovimientosInventario: ${token}`);
    }

    return item;
}

export function MovimientosInventario_beforeUpdate() {
    _fiscalError("MovimientosInventario es append-only (SSOT-05).");
}

export function MovimientosInventario_beforeRemove() {
    _fiscalError("Borrado prohibido en MovimientosInventario (ledger).");
}

// =============================================================================
// BLOQUE 13 - ControlOperativo (8-en-1, ADR-05)
// =============================================================================

export function ControlOperativo_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    assertControlOperativo(item);
    return item;
}

export function ControlOperativo_beforeUpdate(item, context) {
    const original = context?.original || item;
    if (safeTrim(original?.controlType) === CONTROLTYPE.WEBHOOK_EVENT) {
        _fiscalError("WEBHOOKEVENT es append-only (ADR-05).");
    }
    return item;
}

export function ControlOperativo_beforeRemove(item) {
    if (safeTrim(item?.controlType) === CONTROLTYPE.WEBHOOK_EVENT) {
        _fiscalError("Borrado prohibido en WEBHOOKEVENT (ADR-05).");
    }
    return item;
}

// =============================================================================
// BLOQUE 14 - InventarioStockVenta (SNAPSHOT, invariante aritmetico)
// =============================================================================

export function InventarioStockVenta_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    return _validateStockCoherence(item);
}

export function InventarioStockVenta_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;
    return _validateStockCoherence(item);
}

export function InventarioStockVenta_beforeRemove(item) {
    return item;
}

function _validateStockCoherence(item) {
    const stockOnHand = Number(item.stockOnHand);
    const stockReserved = Number(item.stockReserved ?? 0);
    const stockAvailable = Number(item.stockAvailable);

    if (Number.isFinite(stockOnHand) && Number.isFinite(stockAvailable)) {
        if (Math.abs(stockOnHand - stockReserved - stockAvailable) > 0.001) {
            _schemaError(
                `stockAvailable (${stockAvailable}) debe ser stockOnHand (${stockOnHand}) - stockReserved (${stockReserved})`
            );
        }
    }
    return item;
}

// =============================================================================
// BLOQUE 15 - COLECCIONES PROHIBIDAS (SSOT-09, SSOT-15)
// =============================================================================

export function FacturasRecibidas_beforeInsert() {
    _fiscalError(
        "FacturasRecibidas prohibida (SSOT-09). Registre compras en MovimientosCaja (fiscalRole=RECEPTOR) + LibroAsientosContablesDetalle."
    );
}

export function FacturasRecibidas_beforeUpdate() {
    _fiscalError(
        "FacturasRecibidas prohibida (SSOT-09): no se admiten actualizaciones."
    );
}

export function FacturasRecibidas_beforeRemove() {
    _fiscalError(
        "FacturasRecibidas prohibida (SSOT-09): no se admiten eliminaciones."
    );
}

export function AsientosContables_beforeInsert() {
    _fiscalError(
        "AsientosContables prohibida (SSOT-09). Use LibroAsientosContablesDetalle."
    );
}

export function AsientosContables_beforeUpdate() {
    _fiscalError("AsientosContables prohibida (SSOT-09).");
}

export function AsientosContables_beforeRemove() {
    _fiscalError("AsientosContables prohibida (SSOT-09).");
}

export function ConfiguracionFiscal_beforeInsert() {
    _fiscalError(
        "ConfiguracionFiscal prohibida (SSOT-09). Use DatosFiscales con recordType=CONFIG_SISTEMA."
    );
}

export function ConfiguracionFiscal_beforeUpdate() {
    _fiscalError("ConfiguracionFiscal prohibida (SSOT-09).");
}

export function ConfiguracionFiscal_beforeRemove() {
    _fiscalError("ConfiguracionFiscal prohibida (SSOT-09).");
}
