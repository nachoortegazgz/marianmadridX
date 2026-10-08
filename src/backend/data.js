/*
=============================================================================
MODULE: backend/data.js
VERSION: v10.0-SSOT-FRICTIONLESS
BASE: BIBLIA SSOT v9.1 + Anexo D (Correcciones y Reconciliación)
RESPONSIBILITY: Protección de ledgers fiscales/laborales/contables.
                CERO fricción en colecciones maestras CMS y datos de usuario.
STANDARDS: G10 ASCII Strict. Validación delegada en consumidor.

CAMBIOS ROMPIENTES (v10.0):
  - ELIMINADOS todos los hooks de ServiciosCatalogo, ComplementosCatalogo,
    MapaStaff y DatosFiscales.
  - ELIMINADA toda verificación del campo 'status'.
  - MANTENIDOS hooks de integridad legal y operativa.
  - Colecciones prohibidas mantienen bloqueo (SSOT-09).
=============================================================================
*/

import wixData from "backend/dataClient";

import {
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    INTEGRITY,
} from "backend/internalConfig";

import {
    assertCitasF2,
    assertControlOperativo,
    assertRegistrosHorariosStaff,
    assertMovimientosInventario,
    expectedInventoryMagnitude,
    isValidNifOrEuVat,
} from "backend/validation";

import { logger } from "backend/logger";

const log = logger;

const LEDGER_SCHEMA_VERSION_AEAT = INTEGRITY.LEDGERSCHEMA_VERSION;
const IMMUTABLE_ENTRY_STATUSES = new Set(["POSTED", "LOCKED"]);

const ALLOWED_Z_UPDATE_FIELDS = new Set([
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

function _roundItem(value) {
    const number = Number(value);
    return Number.isFinite(number)
        ? Math.round((number + Number.EPSILON) * 100) / 100
        : 0;
}

function _isV5Fiscal(item) {
    return _safeTrim(item?.schemaVersion) === LEDGER_SCHEMA_VERSION_AEAT;
}

function _fiscalError(message) {
    throw new Error(`FISCAL_VIOLATION: ${message}`);
}

function _schemaError(message) {
    throw new Error(`SCHEMA_VIOLATION: ${message}`);
}

// =============================================================================
// BLOQUE 1 - HELPERS DE LECTURA FISCAL (MovimientosCaja)
// =============================================================================

function _readTaxableBase(item) {
    const value =
        item.taxableBaseOrNonSubjectAmount ??
        item.baseImponibleOImporteNoSujeto ??
        item.taxableAmount;

    return Number(value) || 0;
}

function _readTaxAmount(item) {
    const value = item.taxAmount ?? item.cuotaTotal;
    return Number(value) || 0;
}

function _readTotalAmount(item) {
    const value = item.totalAmount ?? item.importeTotal ?? item.amount;
    return Number(value) || 0;
}

function _readSurchargeAmount(item) {
    const value =
        item.surchargeAmount ??
        item.cuotaRecargoEquivalencia ??
        item.importeRecargoEquivalencia;

    return Number(value) || 0;
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

    if (!breakdown) return { base, tax };

    try {
        const rows =
            typeof breakdown === "string" ? JSON.parse(breakdown) : breakdown;

        if (Array.isArray(rows) && rows.length > 0) {
            base = rows.reduce(
                (sum, row) =>
                    sum +
                    Number(
                        row.taxableBaseOrNonSubjectAmount ??
                            row.baseImponibleOImporteNoSujeto ??
                            row.base ??
                            0
                    ),
                0
            );

            tax = rows.reduce(
                (sum, row) =>
                    sum +
                    Number(
                        row.chargedTaxAmount ??
                            row.cuotaRepercutida ??
                            row.cuota ??
                            0
                    ),
                0
            );
        }
    } catch (error) {
        _schemaError(
            "detailedBreakdown/desgloseDetallado no es JSON valido"
        );
    }

    return { base, tax };
}

function _validateF1Requirements(item) {
    if (_readInvoiceType(item) !== "F1") return;

    const fiscalPayload = item.fiscalPayload || item.payloadFiscal || {};
    const taxId =
        _readRecipientTaxId(item) ||
        _safeTrim(fiscalPayload.nifDestinatario);
    const legalName =
        _readRecipientLegalName(item) ||
        _safeTrim(fiscalPayload.nombreRazonDestinatario);
    const address =
        item.recipientAddress || fiscalPayload.domicilioDestinatario || {};

    if (!taxId) {
        _schemaError("Factura F1 exige recipientTaxId/nifDestinatario");
    }

    if (!legalName) {
        _schemaError("Factura F1 exige recipientLegalName");
    }

    if (!address || !_safeTrim(address.cp)) {
        _schemaError("Factura F1 exige recipientAddress con cp");
    }
}

function _validateReverseCharge(item) {
    if (item.reverseCharge !== true && item.inversionSujetoPasivo !== true) {
        return;
    }

    if (_readTaxAmount(item) > 0) {
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
    const invoiceType = _readInvoiceType(item);
    if (!invoiceType.startsWith("R")) return;

    if (!_safeTrim(item.previousInvoiceId)) {
        _schemaError("Factura rectificativa R1-R5 exige previousInvoiceId");
    }
}

function _validateFiscalPayload(item) {
    if (!_isV5Fiscal(item)) return;

    const eventType = _safeTrim(item.eventType).toUpperCase();
    if (!eventType) return;

    if (eventType !== "CIERRE_Z") {
        if (!_safeTrim(item.thirdPartyId)) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }

        if (!item.fiscalPayload || typeof item.fiscalPayload !== "object") {
            _schemaError("fiscalPayload obligatorio (snapshot AEAT)");
        }
    }

    if (
        ["VENTALINEA", "COMPRALINEA", "RECTIFICATIVA", "MOV_STOCK"].includes(
            eventType
        ) &&
        !_safeTrim(item.catalogId)
    ) {
        _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
    }

    if (
        !Number.isFinite(Number(item.sequenceNumber)) ||
        Number(item.sequenceNumber) <= 0
    ) {
        _schemaError("sequenceNumber debe ser un entero positivo");
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
            finalBase +
                finalTax +
                surcharge +
                withholdingFactor * withholding
        );
        const difference = Math.abs(expected - total);

        if (difference > 0.02) {
            _schemaError(
                `Cuadre fiscal invalido (rol ${role}): base ${finalBase} + cuota ${finalTax} + recargo ${surcharge} ${
                    withholdingFactor > 0 ? "+" : "-"
                } retencion ${withholding} = ${expected.toFixed(2)}, total ${total.toFixed(2)}`
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

        for (const row of item.detailedBreakdown) {
            sumBase += Number(
                row.taxableBaseOrNonSubjectAmount ?? row.base ?? 0
            );
            sumTax += Number(row.chargedTaxAmount ?? row.cuota ?? 0);
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
        const payloadRegimeKey = _safeTrim(
            item.fiscalPayload?.claveRegimen
        );
        const itemRegimeKey = _safeTrim(item.regimeKey);

        if (
            payloadRegimeKey &&
            itemRegimeKey &&
            payloadRegimeKey !== itemRegimeKey
        ) {
            _schemaError(
                "regimeKey no coincide con fiscalPayload.claveRegimen"
            );
        }
    }

    if (!_safeTrim(item.traceId)) {
        _schemaError("traceId obligatorio en MovimientosCaja (SSOT-12)");
    }

    if (_safeTrim(item.schemaVersion) !== LEDGER_SCHEMA_VERSION_AEAT) {
        _schemaError(
            `schemaVersion debe ser "${LEDGER_SCHEMA_VERSION_AEAT}"`
        );
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
        _schemaError(
            `endSequence (${end}) no puede ser menor que startSequence (${start})`
        );
    }

    return item;
}

export function HistoricoCierresZ_beforeUpdate(item, context) {
    const previous = context?.original || {};

    const changedFields = Object.keys(item || {}).filter(
        (key) => String(previous[key]) !== String(item[key])
    );

    const onlySignatureFields = changedFields.every((key) =>
        ALLOWED_Z_UPDATE_FIELDS.has(key)
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

    const id = _safeTrim(item.id);

    if (id !== "CAJAPRINCIPAL" && id !== "CAJASEQ") {
        _schemaError(
            "CajaActual.id debe ser CAJAPRINCIPAL o CAJASEQ (singleton, ADR-11)"
        );
    }

    if (!_safeTrim(item.traceId)) {
        _schemaError("CajaActual.traceId obligatorio (SSOT-12)");
    }

    return item;
}

export function CajaActual_beforeUpdate(item, context) {
    const previous = context?.original || {};
    const previousCounters = previous.sequenceCounters;
    const nextCounters = item?.sequenceCounters;

    const countersChanged =
        JSON.stringify(previousCounters || {}) !==
        JSON.stringify(nextCounters || {});

    if (countersChanged && _safeTrim(item?.id) !== "CAJASEQ") {
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
// BLOQUES 6-7-9-10 - COLECCIONES MAESTRAS CMS Y DATOS DE USUARIO
// ServiciosCatalogo, ComplementosCatalogo, MapaStaff, DatosFiscales
//
// SIN HOOKS. La validacion estructural se realiza en el consumidor.
// No se valida el campo 'status'.
// =============================================================================

// =============================================================================
// BLOQUE 8 - LibroAsientosContablesDetalle (LEDGER CONTABLE, ADR-10)
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;

    const accountCode = _safeTrim(item.accountCode || item.cuentaContable);
    if (accountCode && !/^\d{6}$/.test(accountCode)) {
        _schemaError(
            `accountCode "${accountCode}" no tiene formato PGC (6 digitos)`
        );
    }

    if (_isV5Fiscal(item) || _safeTrim(item.sourceEventId || item.eventoOrigenId)) {
        const sourceEventId = _safeTrim(
            item.sourceEventId || item.eventoOrigenId
        );
        const thirdPartyId = _safeTrim(item.thirdPartyId || item.terceroId);
        const catalogId = _safeTrim(item.catalogId || item.catalogoId);

        if (!sourceEventId) {
            _schemaError("sourceEventId obligatorio (FK MovimientosCaja)");
        }

        if (!thirdPartyId) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }

        if (!catalogId) {
            _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
        }

        const lineNumber = Number(item.lineNumber ?? item.numeroLinea);
        if (!Number.isFinite(lineNumber) || lineNumber < 1) {
            _schemaError("lineNumber debe ser un entero mayor o igual que 1");
        }

        if (!Number.isFinite(Number(item.units)) || Number(item.units) <= 0) {
            _schemaError("units debe ser mayor que 0");
        }

        const operationDescription = _safeTrim(
            item.operationDescription || item.descripcionOperacion
        );

        if (!operationDescription) {
            _schemaError(
                "operationDescription obligatoria en lineas v5"
            );
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

    if (
        parentStatus &&
        IMMUTABLE_ENTRY_STATUSES.has(parentStatus.toUpperCase())
    ) {
        _fiscalError(
            "No se puede modificar o eliminar una linea de asiento POSTED o LOCKED"
        );
    }

    return item;
}

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
        .query(OPERATIONAL_COLLECTIONS.MOVIMIENTOSINVENTARIO)
        .eq("movementToken", token)
        .limit(1)
        .find();

    if (existing?.items?.length > 0) {
        _fiscalError(
            `movementToken duplicado en MovimientosInventario: ${token}`
        );
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

    if (_safeTrim(original?.controlType) === CONTROL_TYPE.WEBHOOK_EVENT) {
        _fiscalError("WEBHOOK_EVENT es append-only (ADR-05).");
    }

    return item;
}

export function ControlOperativo_beforeRemove(item) {
    if (_safeTrim(item?.controlType) === CONTROL_TYPE.WEBHOOK_EVENT) {
        _fiscalError("Borrado prohibido en WEBHOOK_EVENT (ADR-05).");
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
        if (
            Math.abs(
                stockOnHand - stockReserved - stockAvailable
            ) > 0.001
        ) {
            _schemaError(
                `stockAvailable (${stockAvailable}) debe ser stockOnHand (${stockOnHand}) - stockReserved (${stockReserved})`
            );
        }
    }

    return item;
}
