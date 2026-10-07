/*
=============================================================================
MODULE: backend/booking/bookingUtils.js
VERSION: v9.0-SDKV2-ZERO-LEGACY
ENTREGA: 5/9 (migracion dominio reservas online -> Wix SDK v2)
BASE: BIBLIA SSOT-MASTER v7/v8 + ANEXO SSOT v8.1 + ADR-17
      (repo marianmadridX, rama main, commit b7effa3d)
RESPONSIBILITY: Helpers PUROS del dominio de reservas: tiempo Madrid
  determinista (sin依赖 de Intl), normalizacion de fechas Wix, huellas y
  tokens deterministas (pairToken / slotToken / lockKey), contacto canonico,
  envelope de respuesta unico y rate limiter RAM reutilizable.
STANDARDS: G10 ASCII estricto. Cero I/O. Cero SDK. Cero secretos.
  Unicas dependencias: backend/internalConfig.js (constantes).
CERO LEGACY / CERO ALIAS:
  - Un solo envelope de respuesta (status/data/error): buildSuccess/buildError.
  - Un solo generador de traceId (SSOT-12).
  - Tokens SNAKE_CASE deterministas; ninguna variante legacy de estado.
=============================================================================
*/

import { SDK_CONFIG, BOOKINGS_ADDON_CONFIG } from "backend/internalConfig";

// =============================================================================
// BLOQUE 1 - HASH E IDENTIFICADORES DETERMINISTAS
// =============================================================================

/**
 * FNV-1a doble vuelta -> string base36 estable (12-14 chars).
 * Determinista entre instancias: apto para ids de control, tokens y locks.
 */
export function fnv1a36(input) {
  const str = String(input === null || input === undefined ? "" : input);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = (h2 + Math.imul(h2 ^ c, 2246822519)) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 14);
}

function _randomBase36(length) {
  let out = "";
  while (out.length < length) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, length);
}

/** Unico generador de traceId del dominio (SSOT-12). */
export function makeTraceId(prefix) {
  const p = String(prefix || "bk").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 16);
  return `${p}_${Date.now().toString(36)}_${_randomBase36(10)}`;
}

export function safeTrim(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeGuid(value) {
  return typeof value === "string" && GUID_PATTERN.test(value.trim());
}

export function roundMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// =============================================================================
// BLOQUE 2 - TIEMPO MADRID DETERMINISTA (regla UE: ultimo domingo mar/oct)
// Sin dependencias de Intl ni de librerias de timezone.
// =============================================================================

function _pad2(n) {
  return String(n).padStart(2, "0");
}

function _lastSundayUtc(year, monthIndex) {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  lastDay.setUTCDate(lastDay.getUTCDate() - lastDay.getUTCDay());
  return lastDay;
}

/** Offset Madrid en minutos para un instante UTC: 60 (CET) o 120 (CEST). */
export function getMadridOffsetMinutes(utcDate) {
  const d = utcDate instanceof Date ? utcDate : new Date(utcDate);
  const year = d.getUTCFullYear();
  const dstStart = _lastSundayUtc(year, 2);
  dstStart.setUTCHours(1, 0, 0, 0);
  const dstEnd = _lastSundayUtc(year, 9);
  dstEnd.setUTCHours(1, 0, 0, 0);
  const t = d.getTime();
  return t >= dstStart.getTime() && t < dstEnd.getTime() ? 120 : 60;
}

export function toMadridParts(utcDate) {
  const d = utcDate instanceof Date ? utcDate : new Date(utcDate);
  const offsetMinutes = getMadridOffsetMinutes(d);
  const local = new Date(d.getTime() + offsetMinutes * 60000);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hours: local.getUTCHours(),
    minutes: local.getUTCMinutes(),
    seconds: local.getUTCSeconds(),
    offsetMinutes,
  };
}

export function toMadridYmd(utcDate) {
  const p = toMadridParts(utcDate);
  return `${p.year}-${_pad2(p.month)}-${_pad2(p.day)}`;
}

/** Formato localDateTime de Wix: "YYYY-MM-DDTHH:mm:ss" en hora Madrid. */
export function formatMadridLocalDateTime(utcDate) {
  const p = toMadridParts(utcDate);
  return (
    `${p.year}-${_pad2(p.month)}-${_pad2(p.day)}` +
    `T${_pad2(p.hours)}:${_pad2(p.minutes)}:${_pad2(p.seconds)}`
  );
}

const YMD_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidMadridYmd(ymd) {
  const m = YMD_PATTERN.exec(safeTrim(ymd));
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2020 || year > 2100) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/**
 * Interpreta componentes de pared Madrid y devuelve el instante UTC.
 * Doble iteracion para resolver la ambiguedad del cambio de hora.
 */
export function parseMadridWallTimeToUtc(ymd, hours = 0, minutes = 0, seconds = 0) {
  const m = YMD_PATTERN.exec(safeTrim(ymd));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const wallUtc = Date.UTC(year, month - 1, day, Number(hours) || 0, Number(minutes) || 0, Number(seconds) || 0);
  let instant = wallUtc;
  for (let i = 0; i < 2; i += 1) {
    const offset = getMadridOffsetMinutes(new Date(instant));
    instant = wallUtc - offset * 60000;
  }
  return new Date(instant);
}

/** "YYYY-MM-DDTHH:mm:ss" (pared Madrid) -> instante UTC. */
export function parseMadridLocalDateTime(localDateTime) {
  const s = safeTrim(localDateTime);
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  return parseMadridWallTimeToUtc(m[1], Number(m[2]), Number(m[3]), Number(m[4] || 0));
}

export function addMinutes(utcDate, minutes) {
  return new Date(utcDate.getTime() + Number(minutes || 0) * 60000);
}

export function diffMinutes(startDate, endDate) {
  return Math.round((endDate.getTime() - startDate.getTime()) / 60000);
}

/** Gap en minutos entre fin de F1 y comienzo de F2 (>= 0). */
export function computeGapMinutes(endDate1, startDate2) {
  if (!(endDate1 instanceof Date) || !(startDate2 instanceof Date)) return 0;
  return Math.max(0, diffMinutes(endDate1, startDate2));
}

export function nowMadridYmd() {
  return toMadridYmd(new Date());
}

// =============================================================================
// BLOQUE 3 - NORMALIZACION DE FECHAS WIX
// =============================================================================

/**
 * Acepta: Date | ISO string | { localDateTime, timeZone } (contrato Wix v2).
 * Devuelve instante UTC o null. Un localDateTime sin sufijo Z se interpreta
 * en Europe/Madrid (unica timezone del negocio, SDK_CONFIG.TZ).
 */
export function normalizeWixDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "object") {
    const ldt = value.localDateTime || value.date || value.time;
    if (typeof ldt === "string") {
      const tz = safeTrim(value.timeZone) || SDK_CONFIG.TZ;
      if (tz === "Europe/Madrid") return parseMadridLocalDateTime(ldt);
      const withZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(ldt) ? ldt : `${ldt}Z`;
      const parsed = new Date(withZone);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) && !/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
      return parseMadridLocalDateTime(s);
    }
    const parsed = new Date(s);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

// =============================================================================
// BLOQUE 4 - NORMALIZACION DE SLOTS DE DISPONIBILIDAD (Bookings v2)
// =============================================================================

/**
 * Convierte una entrada de listAvailabilityTimeSlots en un wrapper interno:
 *  - slot: objeto PRISTINO devuelto por Wix (se reutiliza tal cual en
 *    createBooking; nunca se reconstruye: BIBLIA 2.2).
 *  - metadatos normalizados en UTC/Madrid para emparejado y DTOs.
 */
export function normalizeAvailabilityEntry(timeSlot, serviceId) {
  if (!timeSlot || typeof timeSlot !== "object") return null;
  const slot =
    timeSlot.slot && typeof timeSlot.slot === "object"
      ? timeSlot.slot
      : timeSlot;
  const bookable = timeSlot.bookable !== false && slot.bookable !== false;
  const startDate = normalizeWixDate(slot.startDate || timeSlot.startDate);
  const endDate = normalizeWixDate(slot.endDate || timeSlot.endDate);
  if (!startDate || !endDate || endDate.getTime() <= startDate.getTime()) {
    return null;
  }
  const resource = slot.resource && typeof slot.resource === "object" ? slot.resource : null;
  const resourceId = safeTrim(
    (resource && (resource.id || resource._id)) || timeSlot.resourceId || ""
  );
  return {
    slot,
    serviceId: safeTrim(serviceId),
    scheduleId: safeTrim(slot.scheduleId || (slot.schedule && slot.schedule.id) || ""),
    resourceId,
    resourceName: safeTrim((resource && resource.name) || ""),
    startDateIso: startDate.toISOString(),
    endDateIso: endDate.toISOString(),
    startDateMadrid: formatMadridLocalDateTime(startDate),
    endDateMadrid: formatMadridLocalDateTime(endDate),
    dateYmd: toMadridYmd(startDate),
    durationMinutes: diffMinutes(startDate, endDate),
    rate: timeSlot.rate || slot.rate || null,
    bookable,
  };
}

/** resourceId compartido entre dos wrappers o null (emparejado dual). */
export function getSharedResourceId(wrapperF1, wrapperF2) {
  const r1 = safeTrim(wrapperF1 && wrapperF1.resourceId);
  const r2 = safeTrim(wrapperF2 && wrapperF2.resourceId);
  if (!r1 || !r2) return null;
  return r1 === r2 ? r1 : null;
}

// =============================================================================
// BLOQUE 5 - CLAVES Y TOKENS DETERMINISTAS
// =============================================================================

/** Clave de mutex de slot en ControlOperativo (SLOT_LOCK). */
export function buildSlotLockKey(serviceId, resourceId, startDateIso) {
  return [
    safeTrim(serviceId),
    safeTrim(resourceId),
    safeTrim(startDateIso),
  ].join("|");
}

/** Token publico de un slot simple certificado (cache DUAL_CACHE). */
export function buildSlotToken(serviceId, resourceId, startDateIso) {
  const base = buildSlotLockKey(serviceId, resourceId, startDateIso);
  return `SLOT_${fnv1a36(base)}_${fnv1a36(`${base}#2`)}`;
}

/**
 * Huella determinista del par dual: 8 campos obligatorios (BIBLIA 16.2).
 * Mismo par fisico => mismo pairToken => idempotencia real en CitasF2.
 */
export function buildPairFingerprint(input) {
  const fingerprint = {
    serviceId: safeTrim(input.serviceId),
    linkedPhases: safeTrim(input.linkedPhases),
    dateYmd: safeTrim(input.dateYmd),
    f1Start: safeTrim(input.f1Start),
    f1End: safeTrim(input.f1End),
    f2Start: safeTrim(input.f2Start),
    f2End: safeTrim(input.f2End),
    resourceId: safeTrim(input.resourceId),
  };
  return JSON.stringify(fingerprint);
}

export function buildPairTokenDeterministic(input) {
  const fp = buildPairFingerprint(input);
  return `PT_${fnv1a36(fp)}_${fnv1a36(`${fp}#2`)}`;
}

/** pairToken determinista para reserva SIMPLE (idempotencia por slot+contacto). */
export function buildSimplePairToken(input) {
  const base = [
    safeTrim(input.serviceId),
    safeTrim(input.resourceId),
    safeTrim(input.startDateIso),
    safeTrim(input.email).toLowerCase(),
  ].join("|");
  return `SIM_${fnv1a36(base)}_${fnv1a36(`${base}#2`)}`;
}

/** Limite de addOns por reserva (SSOT: BOOKINGS_ADDON_CONFIG). */
export function capAddOnIds(addOnIds) {
  if (!Array.isArray(addOnIds)) return [];
  const active = BOOKINGS_ADDON_CONFIG.ACTIVE_NATIVE_IDS;
  return addOnIds
    .map(safeTrim)
    .filter((id) => id && active.includes(id))
    .slice(0, BOOKINGS_ADDON_CONFIG.MAX_POR_RESERVA);
}

// =============================================================================
// BLOQUE 6 - CONTACTO CANONICO
// =============================================================================

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_PATTERN = /^\+?[0-9][0-9\s().-]{7,19}$/;

/**
 * Valida y normaliza el contacto para createBooking (Bookings v2).
 * Lanza Error con code=CONTACT_INVALID: nunca acepta datos parciales.
 */
export function buildContactDetails(input) {
  const src = input && typeof input === "object" ? input : {};
  const firstName = safeTrim(src.firstName).slice(0, 50);
  const lastName = safeTrim(src.lastName).slice(0, 50);
  const email = safeTrim(src.email).toLowerCase().slice(0, 254);
  const phone = safeTrim(src.phone).slice(0, 24);

  if (!firstName) {
    throw bookingError(ERROR_CODES.CONTACT_INVALID, "CONTACT_INVALID: firstName es obligatorio");
  }
  if (!lastName) {
    throw bookingError(ERROR_CODES.CONTACT_INVALID, "CONTACT_INVALID: lastName es obligatorio");
  }
  if (!EMAIL_PATTERN.test(email)) {
    throw bookingError(ERROR_CODES.CONTACT_INVALID, "CONTACT_INVALID: email con formato invalido");
  }
  if (!PHONE_PATTERN.test(phone)) {
    throw bookingError(ERROR_CODES.CONTACT_INVALID, "CONTACT_INVALID: telefono con formato invalido");
  }
  return Object.freeze({ firstName, lastName, email, phone });
}

// =============================================================================
// BLOQUE 7 - ENVELOPE UNICO DE RESPUESTA + ERRORES CODIFICADOS
// =============================================================================

export const ERROR_CODES = Object.freeze({
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
  INVALID_DATE: "INVALID_DATE",
  SERVICE_NOT_FOUND: "SERVICE_NOT_FOUND",
  SERVICE_NOT_ACTIVE: "SERVICE_NOT_ACTIVE",
  SERVICE_NOT_DUAL: "SERVICE_NOT_DUAL",
  DUAL_REQUIRED: "DUAL_REQUIRED",
  SLOT_TOKEN_EXPIRED: "SLOT_TOKEN_EXPIRED",
  SLOT_BUSY: "SLOT_BUSY",
  TOKEN_BUSY: "TOKEN_BUSY",
  STAFF_UNRESOLVED: "STAFF_UNRESOLVED",
  STAFF_MEMBER_ID_MISSING: "STAFF_MEMBER_ID_MISSING",
  CONTACT_INVALID: "CONTACT_INVALID",
  RATE_LIMITED: "RATE_LIMITED",
  BOOKING_CREATE_FAILED: "BOOKING_CREATE_FAILED",
  BOOKING_CANCEL_FAILED: "BOOKING_CANCEL_FAILED",
  BOOKING_CONFIRM_FAILED: "BOOKING_CONFIRM_FAILED",
  CITA_NOT_FOUND: "CITA_NOT_FOUND",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FORBIDDEN: "FORBIDDEN",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_NOT_PAID: "ORDER_NOT_PAID",
  INTERNAL: "INTERNAL",
});

/** Error de negocio con code estable: la saga lo traduce a envelope. */
export function bookingError(code, message) {
  const error = new Error(String(message || code));
  error.code = String(code);
  return error;
}

export function buildSuccess(data) {
  return Object.freeze({
    status: "SUCCESS",
    data: data === undefined ? null : data,
    error: null,
  });
}

export function buildError(code, message, details) {
  return Object.freeze({
    status: "ERROR",
    data: null,
    error: Object.freeze({
      code: String(code || ERROR_CODES.INTERNAL),
      message: String(message || ""),
      details: details === undefined ? null : details,
    }),
  });
}

/** true si el error lleva un code de negocio conocido (mensaje publicable). */
export function isKnownBusinessError(error) {
  return Boolean(
    error &&
      typeof error.code === "string" &&
      Object.values(ERROR_CODES).includes(error.code)
  );
}

// =============================================================================
// BLOQUE 8 - RATE LIMITER RAM (ventana fija, reutilizable por web methods)
// =============================================================================

/**
 * Crea un limitador de ventana fija en RAM por instancia.
 * Config canonica: SDK_CONFIG.RATE_LIMIT / SDK_CONFIG.SECURITY.
 * @returns {{check(key: string): {allowed: boolean, retryAfterMs: number, remaining: number}}}
 */
export function createRateLimiter(maxRequests, windowMs) {
  const max = Math.max(Number(maxRequests) || 1, 1);
  const window = Math.max(Number(windowMs) || 1000, 1000);
  const maxEntries = SDK_CONFIG.SECURITY.RATE_LIMIT_CACHE_MAX_ENTRIES;
  const cleanupTtl = SDK_CONFIG.SECURITY.RATE_LIMIT_CACHE_CLEANUP_TTL_MS;
  const buckets = new Map();
  let lastCleanup = Date.now();

  return Object.freeze({
    check(rawKey) {
      const now = Date.now();
      if (now - lastCleanup > cleanupTtl) {
        for (const [key, bucket] of buckets) {
          if (bucket.resetAt <= now) buckets.delete(key);
        }
        lastCleanup = now;
      }
      const key = safeTrim(rawKey) || "anon";
      let bucket = buckets.get(key);
      if (!bucket || now >= bucket.resetAt) {
        if (buckets.size >= maxEntries) {
          let oldestKey = null;
          let oldestReset = Infinity;
          for (const [k, b] of buckets) {
            if (b.resetAt < oldestReset) {
              oldestReset = b.resetAt;
              oldestKey = k;
            }
          }
          if (oldestKey !== null) buckets.delete(oldestKey);
        }
        bucket = { count: 0, resetAt: now + window };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      if (bucket.count > max) {
        return {
          allowed: false,
          retryAfterMs: Math.max(0, bucket.resetAt - now),
          remaining: 0,
        };
      }
      return { allowed: true, retryAfterMs: 0, remaining: max - bucket.count };
    },
  });
}
