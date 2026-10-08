/*
=============================================================================
MODULE: backend/validation.js
VERSION: v10.0-SSOT-FRICTIONLESS
ENTREGA: 3/9 (migracion dominio reservas online -> Wix SDK v2)
BASE: BIBLIA SSOT-MASTER v7/v8 (13.1/13.2) + ANEXO SSOT v8.1 (C-01..C-07)
      + ADR-17 (SNAKE_CASE) + ADR-05 (frontera de pago Wix eCom)
      (repo marianmadridX, rama main, commit b7effa3d)
RESPONSIBILITY: Validacion centralizada WRITE-TIME (fail-fast) y
  normalizacion READ-ONLY de variantes legacy (EOL 31/12/2026).
  Unica fuente de aserciones de esquema del backend (SSOT-07).
STANDARDS: G10 ASCII estricto. Funciones puras: cero I/O, cero SDK, cero DAL.
  Este modulo NO toca el SDK v2: solo valida/normaliza objetos en memoria.

CORRECCIONES APLICADAS (v10.0):
  V10-01: ELIMINADA toda verificacion de campo 'status' en aserciones de
          ServiciosCatalogo, MapaStaff y ComplementosCatalogo. El enum de
          status esta PENDIENTE DE ADR (Anexo D §D.2.3); validar contra un
          enum no aprobado genera bloqueos falsos sobre datos reales con
          valor "ACTIVO". La visibilidad se gestiona por clientHidden.
  V10-02: SLUG_PATTERN actualizado para aceptar la n con tilde (\u00F1)
          sin introducir caracteres no ASCII en el archivo. Sigue siendo
          kebab-case estricto: minusculas, digitos, guiones simples y ñ.
          Ejemplo valido: corte-pelo-niñas-estilo-cuidado.
  V10-03: assertServiciosCatalogo ya no valida mainMedia como Image nativo
          obligatorio. El CMS real almacena URL text; forzar objeto Image
          rechazaba escrituras legitimas. Se valida como string|objeto.
  V10-04: Modo "partial" implicito en updates: los asserts de escritura
          solo exigen campos presentes en el payload. Los campos ausentes
          no se validan (permiten PATCH semantico sin friccion).

CERO LEGACY / CERO ALIAS:
  - Rechaza el campo 'active' en cualquier esquema propio (ANEXO C-01).
  - 'staffRole' prohibido: solo rolBookings + rolWebsite (ANEXO C-02).
  - 'staffMemberId' prohibido: solo memberId (ANEXO C-03/C-04).
  - Los normalizadores legacy son READ-ONLY, con EOL y warn en logger:
    nunca inventan datos; lo desconocido pasa intacto para que el assert
    falle ruidosamente.
  - En ESCRITURA se exige el valor canonico: un valor legacy en un assert
    de escritura es SCHEMA_VIOLATION, no se normaliza en silencio.
DEPENDENCIAS: backend/internalConfig.js (enums SSOT), backend/logger.js.
=============================================================================
*/

import { logger } from "backend/logger";
import {
    BOOKING_STATUS,
    BOOKING_TYPE,
    PAYMENT_STATUS,
    PAYMENT_METHOD,
    MOVEMENT_TYPE,
    INVENTORYMOVEMENTTYPE,
    MAGNITUDE,
    NEGATIVEINVENTORYMOVEMENT_TYPES,
    POSITIVEINVENTORYMOVEMENT_TYPES,
    CONTROL_TYPE,
    CONTROL_STATUS,
    COMPENSATION_KIND,
    CLOCKEVENTTYPE,
    RECORDTYPEHORARIOS,
    ITEM_NATURE,
    CASHREGISTERSTATUS,
    PRICING_MODEL,
    DEPOSIT_TYPE,
    ROL_BOOKINGS,
    ROL_WEBSITE,
    RECORD_TYPE,
    THIRDPARTYTYPE,
    CODIGO_IMPUESTO,
    TIPOIMPOSITIVOVALIDOS,
    CHANNEL_TYPE,
    EUVATPREFIXES,
    normalizeBookingType,
    isDualBookingType,
    isValidGuid,
    buildComputerSystem,
} from "backend/internalConfig";

const log = logger;

// =============================================================================
// BLOQUE 1 - ASSERT GENERICO DE ENUM (BIBLIA 9.4 / SSOT-07)
// =============================================================================

export function assertValidEnum(value, enumObject, fieldName) {
    const allowed = Object.values(enumObject);
    if (value === undefined || value === null || !allowed.includes(value)) {
        throw new Error(
            SCHEMA_VIOLATION: ${fieldName}="${String(value)}" no pertenece al enum canonico [${allowed.join(", ")}]
        );
    }
    return value;
}

function _nonEmpty(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function _canonicalKey(value) {
    return String(value === null || value === undefined ? "" : value)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
}

function _isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function _validDate(value) {
    if (value === undefined || value === null || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return isNaN(date.getTime()) ? null : date;
}

// =============================================================================
// BLOQUE 2 - GUARD ANTI-LEGACY TRANSVERSAL (ANEXO C-01/C-02/C-03)
// =============================================================================

const FORBIDDENLEGACYFIELDS = Object.freeze([
    "active", // C-01: eliminado globalmente
    "staffRole", // C-02: sustituido por rolBookings + rolWebsite
    "staffMemberId", // C-03/C-04: sustituido por memberId
]);

/
 * Escanea un item y rechaza cualquier campo legacy prohibido.
 * Se invoca al inicio de TODOS los asserters de esquemas propios.
 */
export function assertNoLegacyFields(item, entityName) {
    if (!_isObject(item)) return true;
    for (const field of FORBIDDENLEGACYFIELDS) {
        if (Object.prototype.hasOwnProperty.call(item, field)) {
            throw new Error(
                SCHEMA_VIOLATION: ${entityName}.${field} es un campo legacy prohibido (ANEXO v8.1 C-01/C-02/C-03)
            );
        }
    }
    return true;
}

// =============================================================================
// BLOQUE 3 - NORMALIZADORES READ-ONLY (EOL 31/12/2026, BIBLIA 17)
// Solo lectura: nunca se aplican en la ruta de escritura.
// =============================================================================

const PAYMENTLEGACYMAP = Object.freeze({
    UNPAID: PAYMENTSTATUS.NOTPAID,
    NOPAGADO: PAYMENTSTATUS.NOTPAID,
    NOPAGADO: PAYMENTSTATUS.NOT_PAID,
    PAGADO: PAYMENT_STATUS.PAID,
    PENDIENTEPAGO: PAYMENTSTATUS.PENDINGPAYMENT,
    PENDIENTEPAGO: PAYMENTSTATUS.PENDING_PAYMENT,
    PENDIENTEASIENTO: PAYMENTSTATUS.PENDINGLEDGER,
    PENDIENTEASIENTO: PAYMENTSTATUS.PENDING_LEDGER,
    REEMBOLSADO: PAYMENT_STATUS.REFUNDED,
    REEMBOLSADOPARCIAL: PAYMENTSTATUS.PARTIALLYREFUNDED,
    REEMBOLSADOPARCIAL: PAYMENTSTATUS.PARTIALLY_REFUNDED,
    EXENTO: PAYMENT_STATUS.EXEMPT,
});

const BOOKINGLEGACYMAP = Object.freeze({
    CONFIRMADO: BOOKING_STATUS.CONFIRMED,
    CANCELADO: BOOKING_STATUS.CANCELED,
    REEMBOLSADO: BOOKING_STATUS.REFUNDED,
    PENDIENTE: BOOKING_STATUS.PENDING,
    CREADA: BOOKING_STATUS.CREATED,
    CREADO: BOOKING_STATUS.CREATED,
    RECHAZADA: BOOKING_STATUS.DECLINED,
    RECHAZADO: BOOKING_STATUS.DECLINED,
    LISTADEESPERA: BOOKINGSTATUS.WAITINGLIST,
    ACTUALIZADA: BOOKING_STATUS.UPDATED,
    ACTUALIZADO: BOOKING_STATUS.UPDATED,
});

export function normalizePaymentStatus(raw) {
    const value = String(raw === null || raw === undefined ? "" : raw).trim();
    if (!value) return value;
    if (Object.values(PAYMENT_STATUS).includes(value)) return value;
    const mapped = PAYMENTLEGACYMAP[_canonicalKey(value)];
    if (mapped !== undefined) {
        log.warn("legacy paymentStatus normalizado en lectura", {
            raw: value,
            canonical: mapped,
        });
        return mapped;
    }
    return value;
}

export function normalizeBookingStatus(raw) {
    const value = String(raw === null || raw === undefined ? "" : raw).trim();
    if (!value) return value;
    if (Object.values(BOOKING_STATUS).includes(value)) return value;
    const mapped = BOOKINGLEGACYMAP[_canonicalKey(value)];
    if (mapped !== undefined) {
        log.warn("legacy bookingStatus normalizado en lectura", {
            raw: value,
            canonical: mapped,
        });
        return mapped;
    }
    return value;
}

// =============================================================================
// BLOQUE 4 - CitasF2 ASSERT (BIBLIA 13.2 + V20.1 + hooks data.js)
// =============================================================================

const DATEYMDPATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertCitasF2(item) {
    if (!_isObject(item)) {
        throw new Error("SCHEMA_VIOLATION: el item de CitasF2 debe ser un objeto");
    }
    assertNoLegacyFields(item, "CitasF2");

    if (!_nonEmpty(item.bookingId) || !isValidGuid(item.bookingId)) {
        throw new Error(
            "SCHEMA_VIOLATION: CitasF2.bookingId es obligatorio y debe ser un GUID"
        );
    }

    // En escritura el estado debe ser YA canonico: sin normalizacion silenciosa.
    assertValidEnum(item.bookingStatus, BOOKING_STATUS, "bookingStatus");
    assertValidEnum(item.paymentStatus, PAYMENT_STATUS, "paymentStatus");

    const canonicalBookingType = normalizeBookingType(item.bookingType);
    assertValidEnum(canonicalBookingType, BOOKING_TYPE, "bookingType");
    if (item.bookingType !== canonicalBookingType) {
        throw new Error(
            SCHEMA_VIOLATION: bookingType="${String(item.bookingType)}" no es canonico; escriba "${canonicalBookingType}" (ADR-17)
        );
    }

    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: CitasF2 requiere traceId (SSOT-12)");
    }

    if (isDualBookingType(canonicalBookingType) && !_nonEmpty(item.pairToken)) {
        throw new Error(
            "SCHEMAVIOLATION: DUALF1/DUAL_F2 requiere pairToken (BIBLIA 16.2)"
        );
    }

    if (!_nonEmpty(item.serviceId) || !isValidGuid(item.serviceId)) {
        throw new Error(
            "SCHEMA_VIOLATION: CitasF2.serviceId es obligatorio y debe ser un GUID"
        );
    }

    if (
        item.resourceId !== undefined &&
        item.resourceId !== null &&
        item.resourceId !== ""
    ) {
        if (!isValidGuid(item.resourceId)) {
            throw new Error("SCHEMA_VIOLATION: CitasF2.resourceId debe ser un GUID");
        }
    }

    const startDate = _validDate(item.startDate);
    const endDate = _validDate(item.endDate);
    if (item.startDate !== undefined && item.startDate !== null && !startDate) {
        throw new Error("SCHEMA_VIOLATION: CitasF2.startDate no es una fecha valida");
    }
    if (item.endDate !== undefined && item.endDate !== null && !endDate) {
        throw new Error("SCHEMA_VIOLATION: CitasF2.endDate no es una fecha valida");
    }
    if (startDate && endDate && startDate.getTime() >= endDate.getTime()) {
        throw new Error(
            "SCHEMA_VIOLATION: CitasF2.startDate debe ser anterior a endDate"
        );
    }

    if (
        item.dateYmd !== undefined &&
        item.dateYmd !== null &&
        item.dateYmd !== ""
    ) {
        if (!DATEYMDPATTERN.test(String(item.dateYmd))) {
            throw new Error(
                "SCHEMA_VIOLATION: CitasF2.dateYmd debe tener formato YYYY-MM-DD"
            );
        }
    }

    if (
        item.contactDetails !== undefined &&
        item.contactDetails !== null &&
        !_isObject(item.contactDetails)
    ) {
        throw new Error("SCHEMA_VIOLATION: CitasF2.contactDetails debe ser un objeto");
    }

    return true;
}

// =============================================================================
// BLOQUE 5 - MapaStaff ASSERT (ANEXO C-01/C-02/C-03)
// V10-01: SIN verificacion de 'status'. Campo pendiente de ADR.
// =============================================================================

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function assertRolBookings(value) {
    return assertValidEnum(value, ROL_BOOKINGS, "rolBookings");
}

export function assertRolWebsite(value) {
    return assertValidEnum(value, ROL_WEBSITE, "rolWebsite");
}

export function assertMapaStaff(item) {
    if (!_isObject(item)) {
        throw new Error("SCHEMA_VIOLATION: el item de MapaStaff debe ser un objeto");
    }
    assertNoLegacyFields(item, "MapaStaff");

    if (!_nonEmpty(item.resourceId) || !isValidGuid(item.resourceId)) {
        throw new Error(
            "SCHEMA_VIOLATION: MapaStaff.resourceId es obligatorio y debe ser un GUID"
        );
    }

    if (!_nonEmpty(item.memberId) || !isValidGuid(item.memberId)) {
        throw new Error(
            "SCHEMA_VIOLATION: MapaStaff.memberId es obligatorio y debe ser un GUID (ANEXO C-03)"
        );
    }

    assertRolBookings(item.rolBookings);
    assertRolWebsite(item.rolWebsite);

    if (!_nonEmpty(item.staffName)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff.staffName es obligatorio");
    }
    if (String(item.staffName).length > 100) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff.staffName maximo 100 caracteres");
    }

    if (item.email !== undefined && item.email !== null && item.email !== "") {
        if (!EMAIL_PATTERN.test(String(item.email))) {
            throw new Error("SCHEMA_VIOLATION: MapaStaff.email tiene formato invalido");
        }
    }

    if (
        item.scheduleId !== undefined &&
        item.scheduleId !== null &&
        item.scheduleId !== "" &&
        !isValidGuid(item.scheduleId)
    ) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff.scheduleId debe ser un GUID");
    }

    if (!_nonEmpty(item.traceId)) {
        throw new Error("SCHEMA_VIOLATION: MapaStaff requiere traceId (SSOT-12)");
    }

    return true;
}

// =============================================================================
// BLOQUE 6 - ServiciosCatalogo ASSERT (ANEXO C-05/C-06 + BIBLIA 2.1)
// V10-01: SIN verificacion de 'status'. Campo pendiente de ADR (§D.2.3).
// V10-02: SLUG_PATTERN acepta \u00F1 (ñ) sin caracteres no ASCII en archivo.
// V10-03: mainMedia valida string|objeto (CMS real usa URL text).
// V10-04: Campos opcionales solo se validan si estan presentes en el payload.
// =============================================================================

// Kebab-case: letras ASCII minusculas, numeros, guiones y n con tilde.
const SLUG_PATTERN = /^[a-z0-9\u00F1]+(?:-[a-z0-9\u00F1]+)*$/;

function _extractRefId(entry) {
    if (typeof entry === "string") return entry;
    if (_isObject(entry)) {
        return String(entry._id || entry.id || "");
    }
    return "";
}

export function assertServiciosCatalogo(item) {
    if (!_isObject(item)) {
        throw new Error(
            "SCHEMA_VIOLATION: el item de ServiciosCatalogo debe ser un objeto"
        );
    }
    assertNoLegacyFields(item, "ServiciosCatalogo");

    if (!_nonEmpty(item.serviceId) || !isValidGuid(item.serviceId)) {
        throw new Error(
            "SCHEMA_VIOLATION: ServiciosCatalogo.serviceId es obligatorio y debe ser un GUID"
        );
    }

    // V10-02: slug acepta ñ via \u00F1. Ejemplo: corte-pelo-niñas-estilo-cuidado
    if (!nonEmpty(item.slug) || !SLUGPATTERN.test(String(item.slug))) {
        throw new Error(
            "SCHEMA_VIOLATION: ServiciosCatalogo.slug es obligatorio (kebab-case: a-z, 0-9, \u00F1 y guiones)"
        );
    }

    if (!_nonEmpty(item.sku)) {
        throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo.sku es obligatorio");
    }

    assertValidEnum(item.itemNature, ITEM_NATURE, "itemNature");

    if (
        item.pricingModel !== undefined &&
        item.pricingModel !== null &&
        item.pricingModel !== ""
    ) {
        assertValidEnum(item.pricingModel, PRICING_MODEL, "pricingModel");
    }

    // Par fiscal obligatorio y cerrado (SSOT fiscal)
    if (item.tipoImpositivo !== undefined && item.tipoImpositivo !== null) {
        const rate = Number(item.tipoImpositivo);
        if (!Number.isFinite(rate) || !TIPOIMPOSITIVOVALIDOS.includes(rate)) {
            throw new Error(
                "SCHEMA_VIOLATION: tipoImpositivo debe ser uno de [0, 0.04, 0.10, 0.21]"
            );
        }
    }
    if (
        item.codigoImpuesto !== undefined &&
        item.codigoImpuesto !== null &&
        item.codigoImpuesto !== ""
    ) {
        assertValidEnum(item.codigoImpuesto, CODIGO_IMPUESTO, "codigoImpuesto");
    }

    // Duraciones: suma exacta sin fallback cuando el servicio es dual (BIBLIA 2.1)
    const phase1 = Number(item.phase1Duration) || 0;
    const exposure = Number(item.exposureDuration) || 0;
    const phase2 = Number(item.phase2Duration) || 0;
    const total = Number(item.totalDuration);

    if (item.allowCombine === true) {
        const expected = phase1 + exposure + phase2;
        if (!Number.isFinite(total) || Math.abs(total - expected) > 0.001) {
            throw new Error(
                SCHEMA_VIOLATION: totalDuration (${String(item.totalDuration)}) debe equal phase1Duration+exposureDuration+phase2Duration (${expected})
            );
        }
        if (exposure > 120) {
            throw new Error(
                "SCHEMA_VIOLATION: exposureDuration debe ser  array de refs/GUIDs o null
    if (item.locationId !== undefined && item.locationId !== null) {
        if (!Array.isArray(item.locationId)) {
            throw new Error(
                "SCHEMAVIOLATION: locationId debe ser un array MULTIREFERENCE (ANEXO C-05)"
            );
        }
        for (const entry of item.locationId) {
            if (!nonEmpty(extractRefId(entry))) {
                throw new Error(
                    "SCHEMA_VIOLATION: cada entrada de locationId debe ser un ref no vacio (ANEXO C-05)"
                );
            }
        }
    }

    // C-05: availableStaff MULTI_REFERENCE -> array de refs/GUIDs o null
    if (item.availableStaff !== undefined && item.availableStaff !== null) {
        if (!Array.isArray(item.availableStaff)) {
            throw new Error(
                "SCHEMAVIOLATION: availableStaff debe ser un array MULTIREFERENCE (SSOT-16)"
            );
        }
        for (const entry of item.availableStaff) {
            if (!nonEmpty(extractRefId(entry))) {
                throw new Error(
                    "SCHEMA_VIOLATION: cada entrada de availableStaff debe ser un ref no vacio"
                );
            }
        }
    }

    // V10-03: mainMedia acepta string (URL text del CMS real) u objeto Image
    // nativo Wix. Ya no exige exclusivamente objeto Image (ANEXO C-06 relajado).
    if (item.mainMedia !== undefined && item.mainMedia !== null) {
        const media = item.mainMedia;
        const isStringUrl = typeof media === "string" && _nonEmpty(media);
        const isWixImage =
            _isObject(media) &&
            (nonEmpty(media.id) ||
                _nonEmpty(media.id) ||
                _nonEmpty(media.src) ||
                _nonEmpty(media.url));

        if (!isStringUrl && !isWixImage) {
            throw new Error(
                "SCHEMA_VIOLATION: mainMedia debe ser una URL string o un objeto Image nativo de Wix"
            );
        }
    }

    if (
        item.depositType !== undefined &&
        item.depositType !== null &&
        item.depositType !== ""
    ) {
        assertValidEnum(item.depositType, DEPOSIT_TYPE, "depositType");
        const depositValue = Number(item.depositValue);
        if (!Number.isFinite(depositValue) || depositValue = 0 cuando depositType existe"
            );
        }
    }

    return true;
}

// =============================================================================
// BLOQUE 7 - DatosFiscales ASSERT (NIF/NIE/CIF/VAT-UE)
// =============================================================================

const NIFLETRASDNI = "TRWAGMYFPDXBNJZSQVHLCKE";
const NIFCLEANPATTERN = /^[A-Z0-9]+$/;

export function isValidNifEspanol(nif) {
    const clean = String(nif === null || nif === undefined ? "" : nif)
        .trim()
        .toUpperCase()
        .replace(/[-\s]/g, "");
    if (!clean || !NIFCLEANPATTERN.test(clean) || clean.length = 8 && clean.length  0) return MAGNITUDE.POSITIVE;
    if (Number.isFinite(delta) && delta  0
            );
        }
        if (Math.abs(Math.abs(delta) - qty) > 0.001) {
            throw new Error(
                SCHEMA_VIOLATION: |quantityDelta| (${Math.abs(delta)}) debe equal quantity (${qty})
            );
        }
    }

    if (
        item.stockBefore !== undefined &&
        item.stockBefore !== null &&
        item.stockAfter !== undefined &&
        item.stockAfter !== null
    ) {
        const before = Number(item.stockBefore);
        const after = Number(item.stockAfter);
        if (Number.isFinite(before) && Number.isFinite(after)) {
            if (Math.abs(before + delta - after) > 0.001) {
                throw new Error(
                    SCHEMA_VIOLATION: stockAfter (${after}) != stockBefore (${before}) + quantityDelta (${delta})
                );
            }
        }
    }

    return true;
}

// =============================================================================
// BLOQUE 11 - ASSERTS DE ENUM DE DOMINIO (fachadas finas de assertValidEnum)
// =============================================================================

export function assertMovementType(value) {
    return assertValidEnum(value, MOVEMENT_TYPE, "movementType");
}

export function assertPaymentMethod(value) {
    return assertValidEnum(value, PAYMENT_METHOD, "paymentMethod");
}

export function assertItemNature(value) {
    return assertValidEnum(value, ITEM_NATURE, "itemNature");
}

export function assertCashRegisterStatus(value) {
    return assertValidEnum(value, CASHREGISTERSTATUS, "cashRegisterStatus");
}

export function assertCompensationKind(value) {
    return assertValidEnum(value, COMPENSATION_KIND, "kind");
}

export function assertChannelType(value) {
    return assertValidEnum(value, CHANNEL_TYPE, "channelType");
}

export function assertControlType(value) {
    return assertValidEnum(value, CONTROL_TYPE, "controlType");
}

export function assertClockEventType(value) {
    return assertValidEnum(value, CLOCKEVENTTYPE, "clockEventType");
}

export function assertBookingStatus(value) {
    return assertValidEnum(value, BOOKING_STATUS, "bookingStatus");
}

export function assertPaymentStatus(value) {
    return assertValidEnum(value, PAYMENT_STATUS, "paymentStatus");
}

export function assertBookingType(value) {
    return assertValidEnum(value, BOOKING_TYPE, "bookingType");
}

// =============================================================================
// BLOQUE 12 - FRONTERA DE PAGO WIX ECOM (ADR-05)
// OFFLINE/MEMBERSHIP son metodos tecnicos de Wix: NUNCA se persisten como
// medio real. La traduccion a PAYMENT_METHOD canonico ocurre aqui y solo aqui.
// =============================================================================

export const WIXPAYMENTMETHODS = Object.freeze({
    OFFLINE: "Offline",
    MEMBERSHIP: "Membership",
    CREDIT_CARD: "CreditCard",
    DEBIT_CARD: "DebitCard",
    WALLET: "Wallet",
    BANK_TRANSFER: "BankTransfer",
});

const WIXTOREAL = Object.freeze({
    [WIXPAYMENTMETHODS.CREDITCARD]: PAYMENTMETHOD.TARJETA,
    [WIXPAYMENTMETHODS.DEBITCARD]: PAYMENTMETHOD.TARJETA,
    [WIXPAYMENTMETHODS.WALLET]: PAYMENT_METHOD.TARJETA,
    [WIXPAYMENTMETHODS.BANKTRANSFER]: PAYMENTMETHOD.ONLINE,
});

/
 * Traduce el metodo de pago tecnico de Wix eCom al PAYMENT_METHOD canonico.
 * @param {string} wixMethod metodo tecnico del order de Wix eCom
 * @param {string} [medioReal] medio declarado por el gestor (Offline: EFECTIVO/TARJETA/BIZUM)
 * @returns {string} PAYMENT_METHOD canonico
 */
export function normalizeWixPaymentMethod(wixMethod, medioReal) {
    const wix = String(
        wixMethod === null || wixMethod === undefined ? "" : wixMethod
    ).trim();
    const real = String(medioReal === null || medioReal === undefined ? "" : medioReal)
        .trim()
        .toUpperCase();

    if (wix === WIXPAYMENTMETHODS.OFFLINE) {
        const allowedOffline = [
            PAYMENT_METHOD.EFECTIVO,
            PAYMENT_METHOD.TARJETA,
            PAYMENT_METHOD.BIZUM,
        ];
        if (allowedOffline.includes(real)) return real;
        log.warn(
            "pago Offline de Wix sin medioReal determinable: se aplica EFECTIVO por defecto",
            { wixMethod: wix, medioReal: real }
        );
        return PAYMENT_METHOD.EFECTIVO;
    }

    if (wix === WIXPAYMENTMETHODS.MEMBERSHIP) {
        log.warn("pago Membership de Wix traducido a TARJETA_REGALO (ADR-05)", {
            wixMethod: wix,
        });
        return PAYMENTMETHOD.TARJETAREGALO;
    }

    const mapped = WIXTOREAL[wix];
    if (mapped !== undefined) return mapped;

    // Metodo no Wix: si ya es un PAYMENT_METHOD canonico, pasa directo.
    if (Object.values(PAYMENT_METHOD).includes(real)) return real;

    log.warn("metodo de pago desconocido: se aplica EFECTIVO por defecto", {
        wixMethod: wix,
    });
    return PAYMENT_METHOD.EFECTIVO;
}
