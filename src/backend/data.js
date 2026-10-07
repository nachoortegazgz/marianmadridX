/*
=============================================================================
MODULE: backend/data.js
VERSION: v8.1-SSOT-MASTER
BASE: BIBLIA v8.0-SSOT-MASTER + ANEXO SSOT v8.1 + cms.v8.1-FINAL.json
RESPONSIBILITY: Hooks de inmutabilidad, validacion estructural y proteccion
                de ledgers fiscales/laborales/contables.
STANDARDS: G10 ASCII Strict. Validacion delegada en backend/validation.js.

CORRECTIONS APPLIED (ANEXO v8.1):
  - C-01: Campo 'active' eliminado. Hooks no lo referencian.
  - C-02: MapaStaff valida rolBookings + rolWebsite (no staffRole).
  - C-03: MapaStaff/DatosFiscales usan memberId (no staffMemberId).
  - C-04: RegistrosHorariosStaff usa memberId.
  - C-05: ServiciosCatalogo.locationId validado como Multi Reference.
  - C-06: ServiciosCatalogo.mainMedia validado como Image nativo Wix.
  - ADR-17: Enums SNAKE_CASE (DUAL_F1, NOT_PAID, SLOT_LOCK).
  - SSOT-07: Validacion runtime centralizada via assert*.
=============================================================================
*/

import wixData from "backend/dataClient";

import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONTROL_STATUS,
    INTEGRITY,
    RECORD_TYPE,
    THIRD_PARTY_TYPE,
    EVENT_TYPE,
    FISCAL_ROLE,
    TIPO_FACTURA,
    TIPO_RECTIFICATIVA,
    isValidGuid,
} from "backend/internalConfig";

import {
    assertValidEnum,
    assertCitasF2,
    assertMapaStaff,
    assertServiciosCatalogo,
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

const LEDGER_SCHEMA_VERSION_AEAT = INTEGRITY.LEDGER_SCHEMA_VERSION;

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

function _isGuid(value) {
    return isValidGuid(value);
}

function _isFiniteNonNegative(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0;
}

function _isImmutableStatus(status) {
    return IMMUTABLE_ENTRY_STATUSES.has(_safeTrim(status).toUpperCase());
}

function _schemaError(message) {
    throw new Error(`SCHEMA_VIOLATION: ${message}`);
}

function _fiscalError(message) {
    throw new Error(`FISCAL_VIOLATION: ${message}`);
}

function _roundItem(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function _isV5Fiscal(item) {
    return _safeTrim(item?.schemaVersion) === LEDGER_SCHEMA_VERSION_AEAT;
}

// C-01: rechazo explicito del campo 'active' en cualquier coleccion activa
function _rejectActiveField(item, collectionName) {
    if (item && typeof item === "object" && "active" in item) {
        _schemaError(
            `${collectionName}.active prohibido (ANEXO v8.1 C-01). Use 'status' o 'recordType' para ciclo de vida.`
        );
    }
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
                        sum + Number(d.chargedTaxAmount ?? d.cuotaRepercutida ?? d.cuota ?? 0),
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
    if (_readInvoiceType(item) !== TIPO_FACTURA.F1) return;

    const pf = item.fiscalPayload || item.payloadFiscal || {};
    const taxId = _readRecipientTaxId(item) || _safeTrim(pf.nifDestinatario);
    const legalName =
        _readRecipientLegalName(item) || _safeTrim(pf.nombreRazonDestinatario);
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
    if (_safeTrim(item.eventType).toUpperCase() !== EVENT_TYPE.AJUSTE) return;
    if (!_safeTrim(item.previousInvoiceId)) {
        _schemaError("eventType=AJUSTE exige previousInvoiceId");
    }
}

function _validateFiscalRole(item) {
    const role = _safeTrim(item.fiscalRole).toUpperCase();
    if (!role) return;
    assertValidEnum(role, FISCAL_ROLE, "fiscalRole");
}

function _validateRectificativa(item) {
    const tipo = _safeTrim(item.tipoFactura).toUpperCase();
    if (!tipo.startsWith("R")) return;
    assertValidEnum(tipo, TIPO_FACTURA, "tipoFactura");
    if (item.tipoRectificativa !== undefined && item.tipoRectificativa !== null) {
        assertValidEnum(
            _safeTrim(item.tipoRectificativa).toUpperCase(),
            TIPO_RECTIFICATIVA,
            "tipoRectificativa"
        );
    }
    if (!_safeTrim(item.previousInvoiceId)) {
        _schemaError("Factura rectificativa R1-R5 exige previousInvoiceId");
    }
}

function _validateFiscalPayload(item) {
    if (!_isV5Fiscal(item)) return;

    const eventType = _safeTrim(item.eventType).toUpperCase();
    if (!eventType) return;

    assertValidEnum(eventType, EVENT_TYPE, "eventType");

    if (eventType !== EVENT_TYPE.CIERRE_Z) {
        if (!_isGuid(item.thirdPartyId)) {
            _schemaError("thirdPartyId obligatorio (FK DatosFiscales)");
        }
        if (!item.fiscalPayload || typeof item.fiscalPayload !== "object") {
            _schemaError("fiscalPayload obligatorio (snapshot AEAT)");
        }
    }

    if (
        [
            EVENT_TYPE.VENTA_LINEA,
            EVENT_TYPE.COMPRA_LINEA,
            EVENT_TYPE.RECTIFICATIVA,
            EVENT_TYPE.MOV_STOCK,
        ].includes(eventType)
    ) {
        if (!_isGuid(item.catalogId)) {
            _schemaError("catalogId obligatorio (FK ServiciosCatalogo)");
        }
    }

    if (
        !Number.isFinite(Number(item.sequenceNumber)) ||
        Number(item.sequenceNumber) <= 0
    ) {
        _schemaError("sequenceNumber obligatorio (> 0)");
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

    _rejectActiveField(item, "MovimientosCaja");

    const taxId = _readRecipientTaxId(item);
    if (taxId && !isValidNifOrEuVat(taxId)) {
        _schemaError("recipientTaxId/nifDestinatario no tiene formato valido (NIF/VAT-UE)");
    }

    const { base, tax } = _readBreakdownBaseAndTax(item);
    const finalBase = base > 0 ? base : _readTaxableBase(item);
    const finalTax = tax > 0 ? tax : _readTaxAmount(item);

    const withholding =
        Number(item.irpfWithholdingAmount || item.importeRetencionIRPF) || 0;
    const surcharge = _readSurchargeAmount(item);
    const total = _readTotalAmount(item);

    if (finalBase > 0 || finalTax > 0 || withholding > 0 || surcharge > 0) {
        const role =
            _safeTrim(item.fiscalRole || item.rolFiscal).toUpperCase() ||
            FISCAL_ROLE.EMISOR;
        const withholdingFactor = role === FISCAL_ROLE.RECEPTOR ? 1 : -1;

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
    _validateFiscalRole(item);
    _validateFiscalPayload(item);

    if (Array.isArray(item.detailedBreakdown) && item.detailedBreakdown.length > 0) {
        let sumBase = 0;
        let sumTax = 0;
        for (const d of item.detailedBreakdown) {
            sumBase += Number(d.taxableBaseOrNonSubjectAmount ?? d.base ?? 0);
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
    if (_safeTrim(item.schemaVersion) !== LEDGER_SCHEMA_VERSION_AEAT) {
        _schemaError(`schemaVersion debe ser "${LEDGER_SCHEMA_VERSION_AEAT}"`);
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
    _rejectActiveField(item, "HistoricoCierresZ");

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
        _schemaError(`endSequence (${end}) debe ser >= startSequence (${start})`);
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
    _rejectActiveField(item, "RegistrosHorariosStaff");

    // C-04: valida memberId (no staffMemberId)
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
    _rejectActiveField(item, "CajaActual");

    const id = _safeTrim(item._id);
    if (id !== "CAJA_PRINCIPAL" && id !== "CAJA_SEQ") {
        _schemaError(
            "CajaActual._id debe ser CAJA_PRINCIPAL o CAJA_SEQ (singleton, ADR-11)"
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

    if (changed && _safeTrim(item?._id) !== "CAJA_SEQ") {
        _schemaError(
            "sequenceCounters solo modificable en documento _id=CAJA_SEQ (ADR-12)"
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
// BLOQUE 6 - ServiciosCatalogo (ANEXO v8.1 C-05/C-06)
// =============================================================================

export function ServiciosCatalogo_beforeInsert(item) {
    _rejectActiveField(item, "ServiciosCatalogo");
    return _validateServiciosCatalogoSchema(item);
}

export function ServiciosCatalogo_beforeUpdate(item) {
    _rejectActiveField(item, "ServiciosCatalogo");
    return _validateServiciosCatalogoSchema(item);
}

export function ServiciosCatalogo_beforeRemove(item) {
    // Solo Admin. Verificacion de referencias activas en CitasF2 se hace
    // a nivel de webMethod (reservas.web.js) antes de invocar remove.
    return item;
}

function _validateServiciosCatalogoSchema(item) {
    if (!item || typeof item !== "object") return item;

    // Delega en assertServiciosCatalogo (validacion centralizada SSOT-07)
    assertServiciosCatalogo(item);

    // Calculo canonico de totalDuration (sin fallback 30, BIBLIA 2.1)
    const phase1 = Number(item.phase1Duration) || 0;
    const exposure = Number(item.exposureDuration) || 0;
    const phase2 = Number(item.phase2Duration) || 0;

    if (item.allowCombine === true) {
        item.totalDuration = phase1 + exposure + phase2;
    } else if (phase1 > 0) {
        item.totalDuration = phase1;
    }

    if (!_isFiniteNonNegative(item.totalDuration)) {
        _schemaError("totalDuration debe ser un numero no negativo");
    }

    return item;
}

// =============================================================================
// BLOQUE 7 - MapaStaff (ANEXO v8.1 C-02/C-03)
// =============================================================================

export async function MapaStaff_beforeInsert(item) {
    _rejectActiveField(item, "MapaStaff");
    return _validateMapaStaffUniqueness(item);
}

export async function MapaStaff_beforeUpdate(item) {
    _rejectActiveField(item, "MapaStaff");
    return _validateMapaStaffUniqueness(item);
}

export function MapaStaff_beforeRemove(item) {
    // Solo Admin. La verificacion de referencias activas (RegistrosHorariosStaff,
    // CitasF2) se realiza a nivel de webMethod antes de invocar remove.
    return item;
}

async function _validateMapaStaffUniqueness(item) {
    if (!item || typeof item !== "object") return item;

    // C-02/C-03: valida memberId, rolBookings, rolWebsite (no staffMemberId/staffRole)
    assertMapaStaff(item);

    const itemId = _safeTrim(item._id);
    const resourceId = _safeTrim(item.resourceId);
    const memberId = _safeTrim(item.memberId);
    const email = _safeTrim(item.email).toLowerCase();

    if (resourceId) {
        const existingByResource = await wixData
            .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
            .eq("resourceId", resourceId)
            .ne("_id", itemId)
            .limit(1)
            .find({ suppressAuth: true });

        if (existingByResource?.items?.length > 0) {
            _schemaError("resourceId duplicado en MapaStaff");
        }
    }

    // C-03: unicidad por memberId (antes staffMemberId)
    if (memberId) {
        const existingByMember = await wixData
            .query(BUSINESS_COLLECTIONS.MAPA_STAFF)
            .eq("memberId", memberId)
            .ne("_id", itemId)
            .limit(1)
            .find({ suppressAuth: true });

        if (existingByMember?.items?.length > 0) {
            _schemaError("memberId duplicado en MapaStaff (ANEXO v8.1 C-03)");
        }
    }

    if (email) {
        // ADR-03: email NO unico (permite correos compartidos de empresa)
        log.warn("MapaStaff email registrado (ADR-03: indice no unico)", {
            emailDomain: email.split("@")[1] || "",
        });
    }

    return item;
}

// =============================================================================
// BLOQUE 8 - LibroAsientosContablesDetalle (LEDGER CONTABLE, ADR-10)
// =============================================================================

export function LibroAsientosContablesDetalle_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    _rejectActiveField(item, "LibroAsientosContablesDetalle");

    const code = _safeTrim(item.accountCode || item.cuentaContable);
    if (code && !/^\d{6}$/.test(code)) {
        _schemaError(`accountCode "${code}" no tiene formato PGC (6 digitos)`);
    }

    if (_isV5Fiscal(item) || _safeTrim(item.sourceEventId || item.eventoOrigenId)) {
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
            _schemaError("lineNumber >= 1");
        }

        if (!Number.isFinite(Number(item.units)) || Number(item.units) <= 0) {
            _schemaError("units > 0");
        }

        const opDesc = _safeTrim(item.operationDescription || item.descripcionOperacion);
        if (!opDesc) {
            _schemaError("operationDescription obligatoria en lineas v5");
        }
    }

    if (!_safeTrim(item.traceId)) {
        _schemaError("LibroAsientosContablesDetalle.traceId obligatorio (SSOT-12)");
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
    if (parentStatus && _isImmutableStatus(parentStatus)) {
        _fiscalError(
            "No se puede modificar o eliminar una linea de asiento POSTED o LOCKED"
        );
    }
    return item;
}

// =============================================================================
// BLOQUE 9 - DatosFiscales (ANEXO v8.1 C-01/C-03)
// =============================================================================

export function DatosFiscales_beforeInsert(item) {
    _rejectActiveField(item, "DatosFiscales");
    return _validateDatosFiscalesSchema(item);
}

export function DatosFiscales_beforeUpdate(item) {
    _rejectActiveField(item, "DatosFiscales");
    return _validateDatosFiscalesSchema(item);
}

export function DatosFiscales_beforeRemove(item) {
    const id = _safeTrim(item?._id);
    if (id === "CONFIG_SISTEMA_FISCAL") {
        _fiscalError(
            "CONFIG_SISTEMA_FISCAL es singleton protegido. No se puede eliminar."
        );
    }
    return item;
}

function _validateDatosFiscalesSchema(item) {
    if (!item || typeof item !== "object") return item;

    // Delega en assertDatosFiscales (valida taxId, recordType, thirdPartyType,
    // memberId en STAFF, rechazo de 'active')
    assertDatosFiscales(item);

    // Validacion adicional CONFIG_SISTEMA
    if (_safeTrim(item.recordType) === RECORD_TYPE.CONFIG_SISTEMA) {
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
// BLOQUE 10 - ComplementosCatalogo (SSOT-17, ADR-04 v2)
// =============================================================================

export function ComplementosCatalogo_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    _rejectActiveField(item, "ComplementosCatalogo");

    if (!_safeTrim(item.addOnId)) {
        _schemaError("ComplementosCatalogo.addOnId obligatorio");
    }
    if (!_isFiniteNonNegative(item.price)) {
        _schemaError("ComplementosCatalogo.price debe ser >= 0");
    }
    if (!_safeTrim(item.traceId)) {
        _schemaError("ComplementosCatalogo.traceId obligatorio (SSOT-12)");
    }

    return item;
}

export function ComplementosCatalogo_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;
    _rejectActiveField(item, "ComplementosCatalogo");
    return item;
}

export function ComplementosCatalogo_beforeRemove(item) {
    // Solo Admin. Verificacion de referencias en ServiciosCatalogo.addOnOptions
    // se realiza a nivel de webMethod antes de invocar remove.
    return item;
}

// =============================================================================
// BLOQUE 11 - CitasF2 (PROYECCION BOOKINGS)
// =============================================================================

export function CitasF2_beforeInsert(item) {
    if (!item || typeof item !== "object") return item;
    _rejectActiveField(item, "CitasF2");

    assertCitasF2(item);

    return item;
}

export function CitasF2_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;
    _rejectActiveField(item, "CitasF2");

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
    _rejectActiveField(item, "MovimientosInventario");

    assertMovimientosInventario(item);

    if (item.magnitude === undefined || item.magnitude === null || item.magnitude === "") {
        item.magnitude = expectedInventoryMagnitude(
            item.movementType,
            item.quantityDelta
        );
    }

    const token = _safeTrim(item.movementToken);
    const existing = await wixData
        .query(OPERATIONAL_COLLECTIONS.MOVIMIENTOS_INVENTARIO)
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
    _rejectActiveField(item, "ControlOperativo");

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
    _rejectActiveField(item, "InventarioStockVenta");
    return _validateStockCoherence(item);
}

export function InventarioStockVenta_beforeUpdate(item) {
    if (!item || typeof item !== "object") return item;
    _rejectActiveField(item, "InventarioStockVenta");
    return _validateStockCoherence(item);
}

export function InventarioStockVenta_beforeRemove(item) {
    return item;
}

function _validateStockCoherence(item) {
    const stockOnHand = Number(item.stockOnHand);
    const stockReserved = Number(item.stockReserved ?? 0);
    const stockAvailable = Number(item.stockAvailable);

    if (Number.isFinite(stockOnHand) && stockOnHand < 0) {
        _schemaError("stockOnHand no puede ser negativo");
    }
    if (Number.isFinite(stockReserved) && stockReserved < 0) {
        _schemaError("stockReserved no puede ser negativo");
    }
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
    _fiscalError("FacturasRecibidas prohibida (SSOT-09): no se admiten actualizaciones.");
}

export function FacturasRecibidas_beforeRemove() {
    _fiscalError("FacturasRecibidas prohibida (SSOT-09): no se admiten eliminaciones.");
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
