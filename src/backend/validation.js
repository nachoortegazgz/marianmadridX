/*
=============================================================================
MODULE: backend/validation.js
VERSION: v9.0-SDKV2-ZERO-LEGACY
ENTREGA: 3/9 (migracion dominio reservas online -> Wix SDK v2)
BASE: BIBLIA SSOT-MASTER v7/v8 (13.1/13.2) + ANEXO SSOT v8.1 (C-01..C-07)
      + ADR-17 (SNAKE_CASE) + ADR-05 (frontera de pago Wix eCom)
      (repo marianmadridX, rama main, commit b7effa3d)
RESPONSIBILITY: Validacion centralizada WRITE-TIME (fail-fast) y
  normalizacion READ-ONLY de variantes legacy (EOL 31/12/2026).
  Unica fuente de aserciones de esquema del backend (SSOT-07).
STANDARDS: G10 ASCII estricto. Funciones puras: cero I/O, cero SDK, cero DAL.
  Este modulo NO toca el SDK v2: solo valida/normaliza objetos en memoria.
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
  INVENTORY_MOVEMENT_TYPE,
  MAGNITUDE,
  NEGATIVE_INVENTORY_MOVEMENT_TYPES,
  POSITIVE_INVENTORY_MOVEMENT_TYPES,
  CONTROL_TYPE,
  CONTROL_STATUS,
  COMPENSATION_KIND,
  CLOCK_EVENT_TYPE,
  RECORD_TYPE_HORARIOS,
  ITEM_NATURE,
  CASH_REGISTER_STATUS,
  PRICING_MODEL,
  DEPOSIT_TYPE,
  ROL_BOOKINGS,
  ROL_WEBSITE,
  RECORD_TYPE,
  THIRD_PARTY_TYPE,
  CODIGO_IMPUESTO,
  TIPO_IMPOSITIVO_VALIDOS,
  CHANNEL_TYPE,
  EU_VAT_PREFIXES,
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
      `SCHEMA_VIOLATION: ${fieldName}="${String(value)}" no pertenece al enum canonico [${allowed.join(", ")}]`
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

const FORBIDDEN_LEGACY_FIELDS = Object.freeze([
  "active",          // C-01: eliminado globalmente
  "staffRole",       // C-02: sustituido por rolBookings + rolWebsite
  "staffMemberId",   // C-03/C-04: sustituido por memberId
]);

/**
 * Escanea un item y rechaza cualquier campo legacy prohibido.
 * Se invoca al inicio de TODOS los asserters de esquemas propios.
 */
export function assertNoLegacyFields(item, entityName) {
  if (!_isObject(item)) return true;
  for (const field of FORBIDDEN_LEGACY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item, field)) {
      throw new Error(
        `SCHEMA_VIOLATION: ${entityName}.${field} es un campo legacy prohibido (ANEXO v8.1 C-01/C-02/C-03)`
      );
    }
  }
  return true;
}

// =============================================================================
// BLOQUE 3 - NORMALIZADORES READ-ONLY (EOL 31/12/2026, BIBLIA 17)
// Solo lectura: nunca se aplican en la ruta de escritura.
// =============================================================================

const PAYMENT_LEGACY_MAP = Object.freeze({
  UNPAID: PAYMENT_STATUS.NOT_PAID,
  NOPAGADO: PAYMENT_STATUS.NOT_PAID,
  NO_PAGADO: PAYMENT_STATUS.NOT_PAID,
  PAGADO: PAYMENT_STATUS.PAID,
  PENDIENTEPAGO: PAYMENT_STATUS.PENDING_PAYMENT,
  PENDIENTE_PAGO: PAYMENT_STATUS.PENDING_PAYMENT,
  PENDIENTEASIENTO: PAYMENT_STATUS.PENDING_LEDGER,
  PENDIENTE_ASIENTO: PAYMENT_STATUS.PENDING_LEDGER,
  REEMBOLSADO: PAYMENT_STATUS.REFUNDED,
  REEMBOLSADOPARCIAL: PAYMENT_STATUS.PARTIALLY_REFUNDED,
  REEMBOLSADO_PARCIAL: PAYMENT_STATUS.PARTIALLY_REFUNDED,
  EXENTO: PAYMENT_STATUS.EXEMPT,
});

const BOOKING_LEGACY_MAP = Object.freeze({
  CONFIRMADO: BOOKING_STATUS.CONFIRMED,
  CANCELADO: BOOKING_STATUS.CANCELED,
  REEMBOLSADO: BOOKING_STATUS.REFUNDED,
  PENDIENTE: BOOKING_STATUS.PENDING,
  CREADA: BOOKING_STATUS.CREATED,
  CREADO: BOOKING_STATUS.CREATED,
  RECHAZADA: BOOKING_STATUS.DECLINED,
  RECHAZADO: BOOKING_STATUS.DECLINED,
  LISTADEESPERA: BOOKING_STATUS.WAITING_LIST,
  ACTUALIZADA: BOOKING_STATUS.UPDATED,
  ACTUALIZADO: BOOKING_STATUS.UPDATED,
});

export function normalizePaymentStatus(raw) {
  const value = String(raw === null || raw === undefined ? "" : raw).trim();
  if (!value) return value;
  if (Object.values(PAYMENT_STATUS).includes(value)) return value;
  const mapped = PAYMENT_LEGACY_MAP[_canonicalKey(value)];
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
  const mapped = BOOKING_LEGACY_MAP[_canonicalKey(value)];
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

const DATE_YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
      `SCHEMA_VIOLATION: bookingType="${String(item.bookingType)}" no es canonico; escriba "${canonicalBookingType}" (ADR-17)`
    );
  }

  if (!_nonEmpty(item.traceId)) {
    throw new Error("SCHEMA_VIOLATION: CitasF2 requiere traceId (SSOT-12)");
  }

  if (isDualBookingType(canonicalBookingType) && !_nonEmpty(item.pairToken)) {
    throw new Error(
      "SCHEMA_VIOLATION: DUAL_F1/DUAL_F2 requiere pairToken (BIBLIA 16.2)"
    );
  }

  if (!_nonEmpty(item.serviceId) || !isValidGuid(item.serviceId)) {
    throw new Error(
      "SCHEMA_VIOLATION: CitasF2.serviceId es obligatorio y debe ser un GUID"
    );
  }

  if (item.resourceId !== undefined && item.resourceId !== null && item.resourceId !== "") {
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

  if (item.dateYmd !== undefined && item.dateYmd !== null && item.dateYmd !== "") {
    if (!DATE_YMD_PATTERN.test(String(item.dateYmd))) {
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
// =============================================================================

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

  if (!_nonEmpty(item.slug) || !SLUG_PATTERN.test(String(item.slug))) {
    throw new Error(
      "SCHEMA_VIOLATION: ServiciosCatalogo.slug es obligatorio (kebab-case: a-z, 0-9, guiones)"
    );
  }

  if (!_nonEmpty(item.sku)) {
    throw new Error("SCHEMA_VIOLATION: ServiciosCatalogo.sku es obligatorio");
  }

  assertValidEnum(item.itemNature, ITEM_NATURE, "itemNature");

  if (item.pricingModel !== undefined && item.pricingModel !== null && item.pricingModel !== "") {
    assertValidEnum(item.pricingModel, PRICING_MODEL, "pricingModel");
  }

  // Par fiscal obligatorio y cerrado (SSOT fiscal)
  if (item.tipoImpositivo !== undefined && item.tipoImpositivo !== null) {
    const rate = Number(item.tipoImpositivo);
    if (!Number.isFinite(rate) || !TIPO_IMPOSITIVO_VALIDOS.includes(rate)) {
      throw new Error(
        "SCHEMA_VIOLATION: tipoImpositivo debe ser uno de [0, 0.04, 0.10, 0.21]"
      );
    }
  }
  if (item.codigoImpuesto !== undefined && item.codigoImpuesto !== null && item.codigoImpuesto !== "") {
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
        `SCHEMA_VIOLATION: totalDuration (${String(item.totalDuration)}) debe equal phase1Duration+exposureDuration+phase2Duration (${expected})`
      );
    }
    if (exposure > 120) {
      throw new Error(
        "SCHEMA_VIOLATION: exposureDuration debe ser <= 120 minutos"
      );
    }
    // linkedPhases: GUID del servicio F2, nunca slug (BIBLIA 2.1)
    if (!_nonEmpty(item.linkedPhases)) {
      throw new Error(
        "SCHEMA_VIOLATION: allowCombine=true requiere linkedPhases (GUID del servicio F2)"
      );
    }
    const linked = Array.isArray(item.linkedPhases)
      ? item.linkedPhases
      : [item.linkedPhases];
    for (const entry of linked) {
      if (!isValidGuid(_extractRefId(entry))) {
        throw new Error(
          "SCHEMA_VIOLATION: linkedPhases debe ser un GUID valido (nunca slug)"
        );
      }
    }
  }

  // C-05: locationId MULTI_REFERENCE -> array de refs/GUIDs o null
  if (item.locationId !== undefined && item.locationId !== null) {
    if (!Array.isArray(item.locationId)) {
      throw new Error(
        "SCHEMA_VIOLATION: locationId debe ser un array MULTI_REFERENCE (ANEXO C-05)"
      );
    }
    for (const entry of item.locationId) {
      if (!_nonEmpty(_extractRefId(entry))) {
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
        "SCHEMA_VIOLATION: availableStaff debe ser un array MULTI_REFERENCE (SSOT-16)"
      );
    }
    for (const entry of item.availableStaff) {
      if (!_nonEmpty(_extractRefId(entry))) {
        throw new Error(
          "SCHEMA_VIOLATION: cada entrada de availableStaff debe ser un ref no vacio"
        );
      }
    }
  }

  // C-06: mainMedia Image nativo Wix (objeto), nunca URL plana
  if (item.mainMedia !== undefined && item.mainMedia !== null) {
    const media = item.mainMedia;
    const src = _isObject(media) ? media.src : null;
    const isWixImage =
      _isObject(media) &&
      (_nonEmpty(media._id) ||
        _nonEmpty(media.id) ||
        (_isObject(src) && (_nonEmpty(src.id) || _nonEmpty(src.url))));
    if (!isWixImage) {
      throw new Error(
        "SCHEMA_VIOLATION: mainMedia debe ser un objeto Image nativo de Wix (ANEXO C-06)"
      );
    }
  }

  if (item.depositType !== undefined && item.depositType !== null && item.depositType !== "") {
    assertValidEnum(item.depositType, DEPOSIT_TYPE, "depositType");
    const depositValue = Number(item.depositValue);
    if (!Number.isFinite(depositValue) || depositValue < 0) {
      throw new Error(
        "SCHEMA_VIOLATION: depositValue debe ser un numero >= 0 cuando depositType existe"
      );
    }
  }

  return true;
}

// =============================================================================
// BLOQUE 7 - DatosFiscales ASSERT (NIF/NIE/CIF/VAT-UE)
// =============================================================================

const NIF_LETRAS_DNI = "TRWAGMYFPDXBNJZSQVHLCKE";
const NIF_CLEAN_PATTERN = /^[A-Z0-9]+$/;

export function isValidNifEspanol(nif) {
  const clean = String(nif === null || nif === undefined ? "" : nif)
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, "");
  if (!clean || !NIF_CLEAN_PATTERN.test(clean) || clean.length < 8) return false;

  // DNI: 8 digitos + letra de control
  if (/^\d{8}[A-Z]$/.test(clean)) {
    const numero = Number(clean.slice(0, 8));
    return clean.charAt(8) === NIF_LETRAS_DNI[numero % 23];
  }

  // NIE: X/Y/Z + 7 digitos + letra de control
  if (/^[XYZ]\d{7}[A-Z]$/.test(clean)) {
    const prefijos = { X: "0", Y: "1", Z: "2" };
    const numero = Number(prefijos[clean.charAt(0)] + clean.slice(1, 8));
    return clean.charAt(8) === NIF_LETRAS_DNI[numero % 23];
  }

  // CIF: letra org + 7 digitos + control [0-9A-J]
  if (/^[ABCDEFGHJKLMNPQRSUVW]\d{7}[0-9A-J]$/.test(clean)) {
    return true;
  }

  return false;
}

export function isValidNifOrEuVat(nif) {
  const clean = String(nif === null || nif === undefined ? "" : nif)
    .trim()
    .toUpperCase()
    .replace(/[-\s]/g, "");
  if (!clean) return false;

  if (isValidNifEspanol(clean)) return true;

  // VAT-UE: prefijo de 2 letras del listado SSOT + cuerpo alfanumerico
  if (clean.length >= 8 && clean.length <= 14) {
    const prefix = clean.slice(0, 2);
    const body = clean.slice(2);
    if (EU_VAT_PREFIXES.includes(prefix) && /^[A-Z0-9]{5,12}$/.test(body)) {
      return true;
    }
  }

  return false;
}

export function assertDatosFiscales(item) {
  if (!_isObject(item)) {
    throw new Error(
      "SCHEMA_VIOLATION: el item de DatosFiscales debe ser un objeto"
    );
  }
  assertNoLegacyFields(item, "DatosFiscales");

  assertValidEnum(item.recordType, RECORD_TYPE, "recordType");

  if (!_nonEmpty(item.taxId) || !isValidNifOrEuVat(item.taxId)) {
    throw new Error(
      "SCHEMA_VIOLATION: DatosFiscales.taxId debe ser un NIF/NIE/CIF/VAT-UE valido"
    );
  }

  if (!_nonEmpty(item.legalName)) {
    throw new Error("SCHEMA_VIOLATION: DatosFiscales.legalName es obligatorio");
  }

  if (item.recordType === RECORD_TYPE.TERCERO) {
    assertValidEnum(item.thirdPartyType, THIRD_PARTY_TYPE, "thirdPartyType");

    if (item.thirdPartyType === THIRD_PARTY_TYPE.STAFF) {
      if (!_nonEmpty(item.bookingsResourceId) || !isValidGuid(item.bookingsResourceId)) {
        throw new Error(
          "SCHEMA_VIOLATION: thirdPartyType=STAFF requiere bookingsResourceId GUID"
        );
      }
      if (!_nonEmpty(item.memberId) || !isValidGuid(item.memberId)) {
        throw new Error(
          "SCHEMA_VIOLATION: thirdPartyType=STAFF requiere memberId GUID (ANEXO C-03)"
        );
      }
    }
  }

  if (item.recordType === RECORD_TYPE.CONFIG_SISTEMA) {
    // buildComputerSystem lanza FISCAL_VIOLATION si falta nifProductor
    buildComputerSystem(item);
  }

  return true;
}

// =============================================================================
// BLOQUE 8 - ControlOperativo ASSERT (mutex, locks, webhooks, compensaciones)
// =============================================================================

const TTL_CONTROL_TYPES = Object.freeze([
  CONTROL_TYPE.SLOT_LOCK,
  CONTROL_TYPE.RATE_LIMIT,
  CONTROL_TYPE.DAYS_CACHE,
  CONTROL_TYPE.DUAL_CACHE,
]);

export function assertControlOperativo(item) {
  if (!_isObject(item)) {
    throw new Error(
      "SCHEMA_VIOLATION: el item de ControlOperativo debe ser un objeto"
    );
  }

  assertValidEnum(item.controlType, CONTROL_TYPE, "controlType");

  if (!_nonEmpty(item.dedupeKey)) {
    throw new Error("SCHEMA_VIOLATION: ControlOperativo.dedupeKey es obligatorio");
  }

  if (!_nonEmpty(item.traceId)) {
    throw new Error("SCHEMA_VIOLATION: ControlOperativo requiere traceId (SSOT-12)");
  }

  if (item.status !== undefined && item.status !== null && item.status !== "") {
    assertValidEnum(item.status, CONTROL_STATUS, "status");
  }

  if (item.controlType === CONTROL_TYPE.WEBHOOK_EVENT && !_nonEmpty(item.eventId)) {
    throw new Error(
      "SCHEMA_VIOLATION: WEBHOOK_EVENT requiere eventId (idempotencia ADR-05)"
    );
  }

  if (TTL_CONTROL_TYPES.includes(item.controlType)) {
    const expiresAt = _validDate(item.expiresAt);
    if (!expiresAt) {
      throw new Error(
        `SCHEMA_VIOLATION: ${item.controlType} requiere expiresAt valido`
      );
    }
  }

  if (item.controlType === CONTROL_TYPE.COMPENSATION && item.kind !== undefined && item.kind !== null) {
    assertValidEnum(item.kind, COMPENSATION_KIND, "kind");
  }

  return true;
}

// =============================================================================
// BLOQUE 9 - RegistrosHorariosStaff ASSERT (ANEXO C-04 + RD 8/2019)
// =============================================================================

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

export function assertRegistrosHorariosStaff(item) {
  if (!_isObject(item)) {
    throw new Error(
      "SCHEMA_VIOLATION: el item de RegistrosHorariosStaff debe ser un objeto"
    );
  }
  assertNoLegacyFields(item, "RegistrosHorariosStaff");

  assertValidEnum(item.clockEventType, CLOCK_EVENT_TYPE, "clockEventType");
  assertValidEnum(item.recordType, RECORD_TYPE_HORARIOS, "recordType");

  if (!_nonEmpty(item.traceId)) {
    throw new Error(
      "SCHEMA_VIOLATION: RegistrosHorariosStaff requiere traceId (SSOT-12)"
    );
  }

  if (!_nonEmpty(item.resourceId) || !isValidGuid(item.resourceId)) {
    throw new Error(
      "SCHEMA_VIOLATION: RegistrosHorariosStaff.resourceId debe ser un GUID"
    );
  }

  if (!_nonEmpty(item.memberId) || !isValidGuid(item.memberId)) {
    throw new Error(
      "SCHEMA_VIOLATION: RegistrosHorariosStaff.memberId debe ser un GUID (ANEXO C-04)"
    );
  }

  const recordedAt = _validDate(item.recordedAt);
  if (!recordedAt) {
    throw new Error(
      "SCHEMA_VIOLATION: RegistrosHorariosStaff.recordedAt debe ser un timestamp valido"
    );
  }

  const isAdjustment =
    item.recordType === RECORD_TYPE_HORARIOS.AJUSTE ||
    item.clockEventType === CLOCK_EVENT_TYPE.AJUSTE;
  if (isAdjustment && !_nonEmpty(item.adjustmentReason)) {
    throw new Error(
      "SCHEMA_VIOLATION: todo AJUSTE requiere adjustmentReason (RD 8/2019)"
    );
  }

  if (item.dayKey !== undefined && item.dayKey !== null && item.dayKey !== "") {
    if (!DAY_KEY_PATTERN.test(String(item.dayKey))) {
      throw new Error(
        "SCHEMA_VIOLATION: dayKey debe tener formato YYYY-MM-DD"
      );
    }
  }
  if (item.monthKey !== undefined && item.monthKey !== null && item.monthKey !== "") {
    if (!MONTH_KEY_PATTERN.test(String(item.monthKey))) {
      throw new Error(
        "SCHEMA_VIOLATION: monthKey debe tener formato YYYY-MM"
      );
    }
  }

  return true;
}

// =============================================================================
// BLOQUE 10 - MovimientosInventario ASSERT (BIBLIA 13.1, append-only)
// =============================================================================

const INVENTORY_LEGACY_TYPE_MAP = Object.freeze({
  ENTRADA: INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
  SALIDA: INVENTORY_MOVEMENT_TYPE.SALIDA_STOCK,
  STOCK_IN: INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
  STOCK_OUT: INVENTORY_MOVEMENT_TYPE.SALIDA_STOCK,
  COMPRA: INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
  PURCHASE: INVENTORY_MOVEMENT_TYPE.ENTRADA_STOCK,
  SALE: INVENTORY_MOVEMENT_TYPE.VENTA,
  WASTE: INVENTORY_MOVEMENT_TYPE.AJUSTE,
  MERMA: INVENTORY_MOVEMENT_TYPE.AJUSTE,
  AJUSTE_POSITIVO: INVENTORY_MOVEMENT_TYPE.AJUSTE,
  AJUSTE_NEGATIVO: INVENTORY_MOVEMENT_TYPE.AJUSTE,
  TRASLADO_ENTRADA: INVENTORY_MOVEMENT_TYPE.TRANSFERENCIA,
  TRASLADO_SALIDA: INVENTORY_MOVEMENT_TYPE.TRANSFERENCIA,
  ONLINE_SALE: INVENTORY_MOVEMENT_TYPE.VENTA,
  VENTA_ONLINE: INVENTORY_MOVEMENT_TYPE.VENTA,
});

/** READ-ONLY: normaliza variantes legacy de movementType (EOL 31/12/2026). */
export function normalizeInventoryMovementType(raw) {
  const value = String(raw === null || raw === undefined ? "" : raw)
    .trim()
    .toUpperCase();
  if (!value) return value;
  if (Object.values(INVENTORY_MOVEMENT_TYPE).includes(value)) return value;
  const mapped = INVENTORY_LEGACY_TYPE_MAP[_canonicalKey(value)];
  if (mapped !== undefined) {
    log.warn("legacy inventory movementType normalizado en lectura", {
      raw: value,
      canonical: mapped,
    });
    return mapped;
  }
  return value;
}

export function expectedInventoryMagnitude(movementType, quantityDelta) {
  const canonical = normalizeInventoryMovementType(movementType);
  if (POSITIVE_INVENTORY_MOVEMENT_TYPES.includes(canonical)) return MAGNITUDE.POSITIVE;
  if (NEGATIVE_INVENTORY_MOVEMENT_TYPES.includes(canonical)) return MAGNITUDE.NEGATIVE;
  const delta = Number(quantityDelta);
  if (Number.isFinite(delta) && delta > 0) return MAGNITUDE.POSITIVE;
  if (Number.isFinite(delta) && delta < 0) return MAGNITUDE.NEGATIVE;
  return MAGNITUDE.NEUTRAL;
}

export function assertMovimientosInventario(item) {
  if (!_isObject(item)) {
    throw new Error(
      "SCHEMA_VIOLATION: el item de MovimientosInventario debe ser un objeto"
    );
  }

  // Escritura: solo valor canonico. La normalizacion legacy es READ-ONLY.
  assertValidEnum(item.movementType, INVENTORY_MOVEMENT_TYPE, "movementType");

  if (!_nonEmpty(item.movementToken)) {
    throw new Error(
      "SCHEMA_VIOLATION: MovimientosInventario.movementToken es obligatorio (idempotencia)"
    );
  }

  if (!_nonEmpty(item.traceId)) {
    throw new Error(
      "SCHEMA_VIOLATION: MovimientosInventario requiere traceId (SSOT-12)"
    );
  }

  if (!_nonEmpty(item.sku)) {
    throw new Error("SCHEMA_VIOLATION: MovimientosInventario.sku es obligatorio");
  }

  if (item.movementType === INVENTORY_MOVEMENT_TYPE.AJUSTE && !_nonEmpty(item.operationDescription)) {
    throw new Error(
      "SCHEMA_VIOLATION: AJUSTE requiere operationDescription (trazabilidad RD 8/2019)"
    );
  }

  const delta = Number(item.quantityDelta);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new Error(
      `SCHEMA_VIOLATION: quantityDelta (${String(item.quantityDelta)}) no puede ser 0 ni NaN`
    );
  }

  if (item.quantity !== undefined && item.quantity !== null) {
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(
        `SCHEMA_VIOLATION: quantity (${String(item.quantity)}) debe ser > 0`
      );
    }
    if (Math.abs(Math.abs(delta) - qty) > 0.001) {
      throw new Error(
        `SCHEMA_VIOLATION: |quantityDelta| (${Math.abs(delta)}) debe equal quantity (${qty})`
      );
    }
  }

  if (item.stockBefore !== undefined && item.stockBefore !== null &&
      item.stockAfter !== undefined && item.stockAfter !== null) {
    const before = Number(item.stockBefore);
    const after = Number(item.stockAfter);
    if (Number.isFinite(before) && Number.isFinite(after)) {
      if (Math.abs(before + delta - after) > 0.001) {
        throw new Error(
          `SCHEMA_VIOLATION: stockAfter (${after}) != stockBefore (${before}) + quantityDelta (${delta})`
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
  return assertValidEnum(value, CASH_REGISTER_STATUS, "cashRegisterStatus");
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
  return assertValidEnum(value, CLOCK_EVENT_TYPE, "clockEventType");
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

export const WIX_PAYMENT_METHODS = Object.freeze({
  OFFLINE: "Offline",
  MEMBERSHIP: "Membership",
  CREDIT_CARD: "CreditCard",
  DEBIT_CARD: "DebitCard",
  WALLET: "Wallet",
  BANK_TRANSFER: "BankTransfer",
});

const WIX_TO_REAL = Object.freeze({
  [WIX_PAYMENT_METHODS.CREDIT_CARD]: PAYMENT_METHOD.TARJETA,
  [WIX_PAYMENT_METHODS.DEBIT_CARD]: PAYMENT_METHOD.TARJETA,
  [WIX_PAYMENT_METHODS.WALLET]: PAYMENT_METHOD.TARJETA,
  [WIX_PAYMENT_METHODS.BANK_TRANSFER]: PAYMENT_METHOD.ONLINE,
});

/**
 * Traduce el metodo de pago tecnico de Wix eCom al PAYMENT_METHOD canonico.
 * @param {string} wixMethod metodo tecnico del order de Wix eCom
 * @param {string} [medioReal] medio declarado por el gestor (Offline: EFECTIVO/TARJETA/BIZUM)
 * @returns {string} PAYMENT_METHOD canonico
 */
export function normalizeWixPaymentMethod(wixMethod, medioReal) {
  const wix = String(wixMethod === null || wixMethod === undefined ? "" : wixMethod).trim();
  const real = String(medioReal === null || medioReal === undefined ? "" : medioReal)
    .trim()
    .toUpperCase();

  if (wix === WIX_PAYMENT_METHODS.OFFLINE) {
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

  if (wix === WIX_PAYMENT_METHODS.MEMBERSHIP) {
    log.warn("pago Membership de Wix traducido a TARJETA_REGALO (ADR-05)", {
      wixMethod: wix,
    });
    return PAYMENT_METHOD.TARJETA_REGALO;
  }

  const mapped = WIX_TO_REAL[wix];
  if (mapped !== undefined) return mapped;

  // Metodo no Wix: si ya es un PAYMENT_METHOD canonico, pasa directo.
  if (Object.values(PAYMENT_METHOD).includes(real)) return real;

  log.warn("metodo de pago desconocido: se aplica EFECTIVO por defecto", {
    wixMethod: wix,
  });
  return PAYMENT_METHOD.EFECTIVO;
}
