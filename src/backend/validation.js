/*
=============================================================================
MODULE: validation.js  (BIBLIA 16.1 mandatory central validator, SSOT-07)
Purpose: single source of truth for enum validation and READ-ONLY status
normalization. Normalizers here are transitional read adapters only with EOL
31/12/2026 (BIBLIA 20): they map legacy Spanish/alias values to canonical
English enums for INBOUND sanitization; new writes must use canonical enums
directly. No fallbacks for legacy fields are allowed outside this module.
G10 ASCII strict. No console.log. No secrets.
=============================================================================
*/

import { logger } from "backend/logger";
import {
    BOOKING_STATUS,
    BOOKING_TYPE,
    PAYMENT_STATUS,
    INVENTORY_MOVEMENT_TYPE,
    MAGNITUDE,
    NEGATIVE_INVENTORY_MOVEMENT_TYPES,
    POSITIVE_INVENTORY_MOVEMENT_TYPES,
    INVENTORY_MOVEMENT_ALIAS,
    normalizeBookingType,
} from "backend/internalConfig";

const log = logger;

// -----------------------------------------------------------------------------
// Generic enum assertion (BIBLIA 12.4)
// -----------------------------------------------------------------------------
export function assertValidEnum(value, enumObject, fieldName) {
    const allowed = Object.values(enumObject);
    if (value === undefined || value === null || !allowed.includes(value)) {
        throw new Error(
            `VALIDATION_ERROR: ${fieldName}="${String(value)}" not in canonical enum [${allowed.join(", ")}]`
        );
    }
    return value;
}

// -----------------------------------------------------------------------------
// Read-only normalizers (EOL 31/12/2026). They NEVER invent data: unknown
// values pass through untouched so downstream assert* rejects them loudly.
// -----------------------------------------------------------------------------
const PAYMENT_LEGACY_MAP = Object.freeze({
    UNPAID: PAYMENT_STATUS.NOT_PAID,
    NOPAGADO: PAYMENT_STATUS.NOT_PAID,
    PAGADO: PAYMENT_STATUS.PAID,
    PENDIENTEPAGO: PAYMENT_STATUS.PENDING_PAYMENT,
    PENDIENTEASIENTO: PAYMENT_STATUS.PENDING_LEDGER,
    REEMBOLSADO: PAYMENT_STATUS.REFUNDED,
    REEMBOLSADOPARCIAL: PAYMENT_STATUS.PARTIALLY_REFUNDED,
    EXENTO: PAYMENT_STATUS.EXEMPT,
});

const BOOKING_LEGACY_MAP = Object.freeze({
    CONFIRMADO: BOOKING_STATUS.CONFIRMED,
    CANCELADO: BOOKING_STATUS.CANCELED,
    REEMBOLSADO: BOOKING_STATUS.REFUNDED,
    PENDIENTE: BOOKING_STATUS.PENDING,
});

function _canonicalKey(value) {
    return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function normalizePaymentStatus(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return s;
    const direct = Object.values(PAYMENT_STATUS);
    if (direct.includes(s)) return s;
    const mapped = PAYMENT_LEGACY_MAP[_canonicalKey(s)];
    if (mapped !== undefined) {
        log.warn("legacy paymentStatus normalized on read", { raw: s, canonical: mapped });
        return mapped;
    }
    return s; // unknown: leave as-is, let assertValidEnum fail loudly
}

export function normalizeBookingStatus(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return s;
    const direct = Object.values(BOOKING_STATUS);
    if (direct.includes(s)) return s;
    const mapped = BOOKING_LEGACY_MAP[_canonicalKey(s)];
    if (mapped !== undefined) {
        log.warn("legacy bookingStatus normalized on read", { raw: s, canonical: mapped });
        return mapped;
    }
    return s;
}

// -----------------------------------------------------------------------------
// CitasF2 full assertion (hooks 13.2)
// -----------------------------------------------------------------------------
export function assertCitasF2(item) {
    if (!item || typeof item !== "object") {
        throw new Error("VALIDATION_ERROR: CitasF2 item must be an object");
    }
    assertValidEnum(normalizeBookingStatus(item.bookingStatus), BOOKING_STATUS, "bookingStatus");
    assertValidEnum(normalizePaymentStatus(item.paymentStatus), PAYMENT_STATUS, "paymentStatus");
    // BIBLIA 11.2: canonical enum is SIMPLE/DUALF1/DUALF2; legacy persisted
    // values are resolved by the READ-ONLY normalizer (EOL 31/12/2026).
    assertValidEnum(normalizeBookingType(item.bookingType), BOOKING_TYPE, "bookingType");
    if (!_nonEmpty(item.traceId)) {
        throw new Error("VALIDATION_ERROR: CitasF2 requires traceId (SSOT-12)");
    }
    if (!_nonEmpty(item.bookingId)) {
        throw new Error("VALIDATION_ERROR: CitasF2 requires bookingId");
    }
    const isDual = item.bookingType === BOOKING_TYPE.DUALF1 || item.bookingType === BOOKING_TYPE.DUALF2;
    if (isDual && !_nonEmpty(item.pairToken)) {
        throw new Error("VALIDATION_ERROR: DUALF1/DUALF2 requires pairToken");
    }
    return true;
}

function _nonEmpty(v) {
    return typeof v === "string" && v.trim().length > 0;
}

// -----------------------------------------------------------------------------
// Domain enums assertions (used by data.js hooks; enum objects passed in to
// avoid hardcoding string sets here - MATRIZ: producers+consumers together).
// -----------------------------------------------------------------------------
export function assertMovementType(value, movementTypeEnum) {
    return assertValidEnum(value, movementTypeEnum, "movementType");
}
export function assertPaymentMethod(value, paymentMethodEnum) {
    return assertValidEnum(value, paymentMethodEnum, "paymentMethod");
}
export function assertItemNature(value, itemNatureEnum) {
    return assertValidEnum(value, itemNatureEnum, "itemNature");
}
export function assertCashRegisterStatus(value, cashStatusEnum) {
    return assertValidEnum(value, cashStatusEnum, "cashRegisterStatus");
}
export function assertCatalogStatus(value, catalogStatusEnum) {
    return assertValidEnum(value, catalogStatusEnum, "catalogStatus");
}
export function assertCompensationKind(value, kindEnum) {
    return assertValidEnum(value, kindEnum, "compensationKind");
}
export function assertCompensationStatus(value, statusEnum) {
    return assertValidEnum(value, statusEnum, "compensationStatus");
}

// -----------------------------------------------------------------------------
// MovimientosInventario full assertion (SSOT 13.1, FASE4-INV).
// Canonical enum INVENTORY_MOVEMENT_TYPE; legacy aliases ENTRADA/SALIDA are
// already canonical values so no normalizer is required for them. magnitude
// must agree with the sign of quantityDelta per MAGNITUDE contract.
// -----------------------------------------------------------------------------
// Alias funcionales declarados en internalConfig (ADR-09): ONLINE_SALE y
// VENTA_ONLINE son tokens historicos del flujo de pedidos Wix que equivalen
// a SALIDA. Se mapean aqui (unica ubicacion permitida para adaptadores
// legacy) con warning; las escrituras nuevas deben usar el enum canonico.
const INVENTORY_LEGACY_TYPE_MAP = Object.freeze({
    COMPRA: INVENTORY_MOVEMENT_TYPE.ENTRADA,
    PURCHASE: INVENTORY_MOVEMENT_TYPE.ENTRADA,
    VENTA: INVENTORY_MOVEMENT_TYPE.SALIDA,
    SALE: INVENTORY_MOVEMENT_TYPE.SALIDA,
    STOCK_OUT: INVENTORY_MOVEMENT_TYPE.SALIDA,
    STOCK_IN: INVENTORY_MOVEMENT_TYPE.ENTRADA,
    WASTE: INVENTORY_MOVEMENT_TYPE.MERMA,
    ...INVENTORY_MOVEMENT_ALIAS,
});

export function normalizeInventoryMovementType(raw) {
    const s = String(raw ?? "").trim().toUpperCase();
    if (!s) return s;
    const direct = Object.values(INVENTORY_MOVEMENT_TYPE);
    if (direct.includes(s)) return s;
    const mapped = INVENTORY_LEGACY_TYPE_MAP[_canonicalKey(s)];
    if (mapped !== undefined) {
        log.warn("legacy inventory movementType normalized on read", { raw: s, canonical: mapped });
        return mapped;
    }
    return s; // unknown: leave as-is, let assertValidEnum fail loudly
}

export function expectedInventoryMagnitude(movementType, quantityDelta) {
    const t = normalizeInventoryMovementType(movementType);
    if (POSITIVE_INVENTORY_MOVEMENT_TYPES.includes(t)) return MAGNITUDE.POSITIVE;
    if (NEGATIVE_INVENTORY_MOVEMENT_TYPES.includes(t)) return MAGNITUDE.NEGATIVE;
    // AJUSTE generic not in enum; any other type -> magnitude follows delta sign
    const d = Number(quantityDelta);
    if (Number.isFinite(d) && d > 0) return MAGNITUDE.POSITIVE;
    if (Number.isFinite(d) && d < 0) return MAGNITUDE.NEGATIVE;
    return MAGNITUDE.NEUTRAL;
}

export function assertMovimientosInventario(item) {
    if (!item || typeof item !== "object") {
        throw new Error("VALIDATION_ERROR: MovimientosInventario item must be an object");
    }
    const canonicalType = normalizeInventoryMovementType(item.movementType);
    assertValidEnum(canonicalType, INVENTORY_MOVEMENT_TYPE, "movementType");
    // Cero fallback en escritura (MATRIZ H.2): tras la normalizacion del
    // hook se persiste SIEMPRE el valor canonico, nunca el alias legacy.
    item.movementType = canonicalType;
    if (!_nonEmpty(item.movementToken)) {
        throw new Error("VALIDATION_ERROR: MovimientosInventario requires movementToken (idempotencia)");
    }
    if (!_nonEmpty(item.traceId)) {
        throw new Error("VALIDATION_ERROR: MovimientosInventario requires traceId (SSOT-12)");
    }
    if (!_nonEmpty(item.operationDescription)) {
        throw new Error("VALIDATION_ERROR: MovimientosInventario requires operationDescription");
    }
    if (!_nonEmpty(item.sku)) {
        throw new Error("VALIDATION_ERROR: MovimientosInventario requires sku");
    }
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error(`VALIDATION_ERROR: quantity (${String(item.quantity)}) debe ser > 0`);
    }
    const delta = Number(item.quantityDelta);
    if (!Number.isFinite(delta) || delta === 0) {
        throw new Error(`VALIDATION_ERROR: quantityDelta (${String(item.quantityDelta)}) no puede ser 0`);
    }
    if (Math.abs(Math.abs(delta) - qty) > 0.001) {
        throw new Error(
            `VALIDATION_ERROR: |quantityDelta| (${Math.abs(delta)}) debe coincidir con quantity (${qty})`
        );
    }
    const before = Number(item.stockBefore);
    const after = Number(item.stockAfter);
    if (!Number.isFinite(before) || !Number.isFinite(after)) {
        throw new Error("VALIDATION_ERROR: stockBefore/stockAfter numericos obligatorios");
    }
    if (Math.abs((before + delta) - after) > 0.001) {
        throw new Error(
            `VALIDATION_ERROR: stockAfter (${after}) != stockBefore (${before}) + quantityDelta (${delta})`
        );
    }
    const expectedMag = expectedInventoryMagnitude(item.movementType, delta);
    if (item.magnitude !== undefined && Number(item.magnitude) !== expectedMag) {
        throw new Error(
            `VALIDATION_ERROR: magnitude (${String(item.magnitude)}) incoherente con movementType/quantityDelta; esperado ${expectedMag}`
        );
    }
    if (before + delta < -0.001 && expectedMag === MAGNITUDE.NEGATIVE) {
        throw new Error(
            `VALIDATION_ERROR: movimiento generaria stock negativo (${before} + ${delta})`
        );
    }
    return true;
}

// -----------------------------------------------------------------------------
// Wix eCom payment-method boundary (ADR-05).
// OFFLINE/MEMBERSHIP must NEVER be persisted as the real method.
// -----------------------------------------------------------------------------
export const WIX_PAYMENT_METHODS = Object.freeze({
    OFFLINE: "Offline",
    MEMBERSHIP: "Membership",
    CREDIT_CARD: "CreditCard",
    DEBIT_CARD: "DebitCard",
    WALLET: "Wallet",
    BANK_TRANSFER: "BankTransfer",
});

export const REAL_PAYMENT_METHODS = Object.freeze({
    EFECTIVO: "EFECTIVO",
    TARJETA: "TARJETA",
    BIZUM: "BIZUM",
    TRANSFERENCIA: "TRANSFERENCIA",
    ONLINE: "ONLINE",
});

export function normalizeWixPaymentMethod(wixMethod, medioReal) {
    const w = String(wixMethod ?? "").trim();
    const real = String(medioReal ?? "").trim().toUpperCase();
    if (w === WIX_PAYMENT_METHODS.OFFLINE) {
        if ([REAL_PAYMENT_METHODS.EFECTIVO, REAL_PAYMENT_METHODS.TARJETA, REAL_PAYMENT_METHODS.BIZUM].includes(real)) {
            return real;
        }
        log.warn("OFFLINE wix payment with indeterminable medioReal, defaulting EFECTIVO", { wixMethod: w, medioReal: real });
        return REAL_PAYMENT_METHODS.EFECTIVO;
    }
    if (w === WIX_PAYMENT_METHODS.MEMBERSHIP) {
        // ADR-05: membership settlement maps to TRANSFERENCIA until business
        // confirms; never persist MEMBERSHIP itself.
        log.warn("MEMBERSHIP wix payment normalized to TRANSFERENCIA per ADR-05", { wixMethod: w });
        return REAL_PAYMENT_METHODS.TRANSFERENCIA;
    }
    if (w === WIX_PAYMENT_METHODS.CREDIT_CARD || w === WIX_PAYMENT_METHODS.DEBIT_CARD || w === WIX_PAYMENT_METHODS.WALLET) {
        return REAL_PAYMENT_METHODS.TARJETA;
    }
    if (w === WIX_PAYMENT_METHODS.BANK_TRANSFER) {
        return REAL_PAYMENT_METHODS.TRANSFERENCIA;
    }
    if (real && real !== "OFFLINE" && real !== "MEMBERSHIP") return real;
    log.warn("unknown wix payment method, defaulting EFECTIVO with warn", { wixMethod: w });
    return REAL_PAYMENT_METHODS.EFECTIVO;
}
