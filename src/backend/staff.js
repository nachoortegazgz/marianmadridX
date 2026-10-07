/*
=============================================================================
MODULE: backend/staff.js
VERSION: v9.0-SDKV2-ZERO-LEGACY
ENTREGA: 4/9 (migracion dominio reservas online -> Wix SDK v2)
BASE: BIBLIA SSOT-MASTER v7/v8 + ANEXO SSOT v8.1 (C-02/C-03) + SSOT CMS
      (repo marianmadridX, rama main, commit b7effa3d)
RESPONSIBILITY: Resolucion de identidad de staff para el dominio de
  reservas: resourceId (Bookings) <-> memberId (Members) <-> roles
  (rolBookings/rolWebsite), con cache RAM acotada y DTO publico minimizado.
STANDARDS: G10 ASCII estricto. Sin console.log (logger SSOT). Sin secretos.
MIGRACION SDK v2:
  - Unico acceso a datos via backend/dataAccess.js (DAL elevado, items SDK v2).
  - Cero wix-data legacy, cero suppressAuth, cero suppressHooks.
  - Filtros WQL por objeto (constructores wql.*), orden por order.*.
CERO LEGACY / CERO ALIAS:
  - memberId es el unico vinculo con Members (ANEXO C-03). 'staffMemberId'
    no existe en este modulo.
  - Roles separados rolBookings/rolWebsite (ANEXO C-02). 'staffRole' no existe.
  - Sin campo 'active' (ANEXO C-01): la operacionalidad se deriva de
    rolWebsite dentro de STAFF_ACCESS.ALLOWED_ROLES.
RGPD:
  - El DTO publico es whitelist estricta. Nunca salen: notes, thirdPartyId,
    traceId, location, _id, _owner, email completo fuera del backend.
DEPENDENCIAS: backend/dataAccess.js, backend/internalConfig.js,
  backend/validation.js, backend/logger.js.
=============================================================================
*/

import {
  queryFirstItem,
  queryAllPages,
  wql,
  order,
  CONSISTENCY,
} from "backend/dataAccess";
import {
  BUSINESS_COLLECTIONS,
  MAPA_STAFF_FIELDS,
  STAFF,
  STAFF_ACCESS,
  STAFF_DEFAULT_NAME,
  SDK_CONFIG,
  isValidGuid,
} from "backend/internalConfig";
import { assertMapaStaff } from "backend/validation";
import { logger } from "backend/logger";

const log = logger;
const F = MAPA_STAFF_FIELDS;
const COLLECTION = BUSINESS_COLLECTIONS.MAPA_STAFF;

// =============================================================================
// BLOQUE 1 - CACHE RAM ACOTADA (TTL + LRU por expiracion)
// =============================================================================

const STAFF_TTL_MS = SDK_CONFIG.CACHE.STAFF_TTL_MS;
const MAX_CACHE_ENTRIES = SDK_CONFIG.CACHE.MAX_ENTRIES;

/** @type {Map<string, {value: *, expiresAt: number}>} */
const cache = new Map();

function _cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _cacheSet(key, value) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    let oldestKey = null;
    let oldestExpiry = Infinity;
    for (const [entryKey, entry] of cache) {
      if (entry.expiresAt < oldestExpiry) {
        oldestExpiry = entry.expiresAt;
        oldestKey = entryKey;
      }
    }
    if (oldestKey !== null) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + STAFF_TTL_MS });
}

/**
 * Invalidacion explicita (SSOT-11): tras cualquier alta/baja/modificacion en
 * MapaStaff el escritor debe llamar a invalidateStaffCache(resourceId o
 * memberId). Sin argumento, limpia la cache completa.
 */
export function invalidateStaffCache(identifier) {
  const id = String(identifier === null || identifier === undefined ? "" : identifier).trim();
  if (!id) {
    cache.clear();
    return;
  }
  cache.delete(`rid:${id}`);
  cache.delete(`mid:${id}`);
  cache.delete("list:operational");
}

// =============================================================================
// BLOQUE 2 - DTO PUBLICO (whitelist RGPD, minimizacion de datos)
// =============================================================================

const PUBLIC_DTO_FIELDS = Object.freeze([
  F.RESOURCE_ID,
  F.MEMBER_ID,
  F.STAFF_NAME,
  F.DISPLAY_NAME,
  F.EMAIL,
  F.PHONE,
  F.ROL_BOOKINGS,
  F.ROL_WEBSITE,
  F.SCHEDULE_ID,
]);

function _buildPublicDTO(record) {
  if (!record || typeof record !== "object") return null;
  const dto = {};
  for (const field of PUBLIC_DTO_FIELDS) {
    const value = record[field];
    if (value !== undefined && value !== null && value !== "") {
      dto[field] = value;
    }
  }
  return dto;
}

// =============================================================================
// BLOQUE 3 - FALLBACK HARDCODED SEGURO (solo display, nunca identidad)
// La lista dura STAFF.IDS es red de seguridad de DISPLAY: no inventa memberId,
// por lo que un fallback NUNCA satisface resolveStaffForBooking.
// =============================================================================

function _fallbackDisplayDto(resourceId) {
  const rid = String(resourceId === null || resourceId === undefined ? "" : resourceId).trim();
  if (!STAFF.IDS.includes(rid)) return null;
  const display = STAFF.RESOURCE_TO_DISPLAY[rid];
  if (!display) return null;
  return {
    resourceId: rid,
    staffName: display,
    displayName: display,
    memberId: null,
  };
}

// =============================================================================
// BLOQUE 4 - RESOLUCION POR resourceId (Bookings) Y memberId (Members)
// =============================================================================

function _consistencyOf(options) {
  return options && options.consistency === CONSISTENCY.STRONG
    ? CONSISTENCY.STRONG
    : CONSISTENCY.EVENTUAL;
}

/**
 * Obtiene el DTO publico de un staff por su resourceId de Bookings.
 * @param {string} resourceId GUID del resource en Bookings
 * @param {{traceId?: string, consistency?: string}} [options]
 * @returns {Promise<Object|null>} DTO publico, fallback display, o null.
 */
export async function getStaffByResourceId(resourceId, options = {}) {
  const rid = String(resourceId === null || resourceId === undefined ? "" : resourceId).trim();
  if (!isValidGuid(rid)) return null;

  const cacheKey = `rid:${rid}`;
  const cached = _cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const record = await queryFirstItem({
    dataCollectionId: COLLECTION,
    filter: wql.eq(F.RESOURCE_ID, rid),
    consistency: _consistencyOf(options),
  });

  let dto = null;
  if (record) {
    try {
      assertMapaStaff(record);
      dto = _buildPublicDTO(record);
    } catch (error) {
      log.error(
        "STAFF_SCHEMA_VIOLATION: registro MapaStaff invalido en lectura; se descarta",
        {
          resourceId: rid,
          message: String((error && error.message) || error || ""),
          traceId: options.traceId || null,
        }
      );
      dto = null;
    }
  }

  if (!dto) dto = _fallbackDisplayDto(rid);
  _cacheSet(cacheKey, dto);
  return dto;
}

/**
 * Obtiene el DTO publico de un staff por su memberId de Members (ANEXO C-03).
 * @param {string} memberId GUID del miembro
 * @param {{traceId?: string, consistency?: string}} [options]
 * @returns {Promise<Object|null>}
 */
export async function getStaffByMemberId(memberId, options = {}) {
  const mid = String(memberId === null || memberId === undefined ? "" : memberId).trim();
  if (!isValidGuid(mid)) return null;

  const cacheKey = `mid:${mid}`;
  const cached = _cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const record = await queryFirstItem({
    dataCollectionId: COLLECTION,
    filter: wql.eq(F.MEMBER_ID, mid),
    consistency: _consistencyOf(options),
  });

  let dto = null;
  if (record) {
    try {
      assertMapaStaff(record);
      dto = _buildPublicDTO(record);
    } catch (error) {
      log.error(
        "STAFF_SCHEMA_VIOLATION: registro MapaStaff invalido en lectura; se descarta",
        {
          memberId: mid,
          message: String((error && error.message) || error || ""),
          traceId: options.traceId || null,
        }
      );
      dto = null;
    }
  }

  _cacheSet(cacheKey, dto);
  return dto;
}

/**
 * Resolucion por email (vinculacion Members -> MapaStaff).
 * Compara en minusculas: el email canonico se almacena en minusculas.
 */
export async function getStaffByEmail(email, options = {}) {
  const raw = String(email === null || email === undefined ? "" : email).trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  const record = await queryFirstItem({
    dataCollectionId: COLLECTION,
    filter: wql.or(wql.eq(F.EMAIL, raw), wql.eq(F.EMAIL, lower)),
    consistency: _consistencyOf(options),
  });

  if (!record) return null;
  try {
    assertMapaStaff(record);
  } catch (error) {
    log.error(
      "STAFF_SCHEMA_VIOLATION: registro MapaStaff invalido en resolucion por email",
      {
        message: String((error && error.message) || error || ""),
        traceId: options.traceId || null,
      }
    );
    return null;
  }
  return _buildPublicDTO(record);
}

// =============================================================================
// BLOQUE 5 - LISTADO OPERACIONAL (sustituye al filtro legacy por 'active')
// =============================================================================

/**
 * Un staff esta operativo cuando su rolWebsite pertenece a
 * STAFF_ACCESS.ALLOWED_ROLES (ANEXO C-01: la operacionalidad NO vive en un
 * campo booleano 'active', vive en el rol canonico).
 */
export function isOperationalWebsiteRole(rolWebsite) {
  return STAFF_ACCESS.ALLOWED_ROLES.includes(rolWebsite);
}

/**
 * Lista el staff operativo para el canal website (agenda publica y panel).
 * Registros invalidos se descartan con error en logger (nunca rompen la lista).
 * @param {{traceId?: string}} [options]
 * @returns {Promise<Array<Object>>} DTOs publicos ordenados por staffName.
 */
export async function listOperationalStaff(options = {}) {
  const cacheKey = "list:operational";
  const cached = _cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const records = await queryAllPages({
    dataCollectionId: COLLECTION,
    filter: wql.in(F.ROL_WEBSITE, STAFF_ACCESS.ALLOWED_ROLES),
    sort: order.asc(F.STAFF_NAME),
    pageSize: 100,
    maxPages: 5,
    traceId: options.traceId || null,
  });

  const list = [];
  for (const record of records) {
    try {
      assertMapaStaff(record);
      const dto = _buildPublicDTO(record);
      if (dto) list.push(dto);
    } catch (error) {
      log.error(
        "STAFF_SCHEMA_VIOLATION: registro MapaStaff invalido; excluido del listado operativo",
        {
          resourceId: String((record && record.resourceId) || "UNKNOWN"),
          message: String((error && error.message) || error || ""),
          traceId: options.traceId || null,
        }
      );
    }
  }

  // Red de seguridad de DISPLAY: recursos hardcodeados ausentes del CMS.
  const knownResourceIds = new Set(
    list.map((dto) => String(dto.resourceId || "")).filter(Boolean)
  );
  for (const rid of STAFF.IDS) {
    if (!knownResourceIds.has(rid)) {
      const fallback = _fallbackDisplayDto(rid);
      if (fallback) list.push(fallback);
    }
  }

  list.sort((a, b) =>
    String(a.staffName || "").localeCompare(String(b.staffName || ""))
  );

  _cacheSet(cacheKey, list);
  return list;
}

// =============================================================================
// BLOQUE 6 - RESOLUCION PARA CREACION DE RESERVAS (ruta critica)
// =============================================================================

function _staffError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Resuelve la identidad completa requerida para crear/confirmar bookings:
 * resourceId + memberId (ANEXO C-03) + nombre + rol de Bookings + scheduleId.
 * Falla de forma explicita (fail-fast) si el recurso no existe o carece de
 * memberId: el fallback hardcoded es solo display y NUNCA valida aqui.
 *
 * @param {string} resourceId GUID del resource de Bookings
 * @param {{traceId?: string, consistency?: string}} [options]
 * @returns {Promise<Readonly<{resourceId: string, memberId: string,
 *   staffName: string|null, rolBookings: string|null, scheduleId: string|null}>>}
 * @throws {Error} code=STAFF_UNRESOLVED | STAFF_MEMBER_ID_MISSING
 */
export async function resolveStaffForBooking(resourceId, options = {}) {
  const dto = await getStaffByResourceId(resourceId, options);
  if (!dto) {
    throw _staffError(
      "STAFF_UNRESOLVED",
      `STAFF_UNRESOLVED: resourceId no resuelto en MapaStaff (traceId=${String(options.traceId || "null")})`
    );
  }
  if (!isValidGuid(String(dto.memberId || ""))) {
    throw _staffError(
      "STAFF_MEMBER_ID_MISSING",
      `STAFF_MEMBER_ID_MISSING: MapaStaff.memberId es obligatorio para operar (ANEXO C-03, resourceId=${dto.resourceId})`
    );
  }
  return Object.freeze({
    resourceId: dto.resourceId,
    memberId: dto.memberId,
    staffName: dto.staffName || dto.displayName || null,
    rolBookings: dto.rolBookings || null,
    scheduleId: dto.scheduleId || null,
  });
}

/**
 * Nombre visible para DTOs de reservas (agenda, confirmaciones, emails).
 * Nunca lanza: devuelve STAFF_DEFAULT_NAME si no hay resolucion.
 */
export async function getStaffDisplayName(resourceId, options = {}) {
  try {
    const dto = await getStaffByResourceId(resourceId, options);
    if (dto && (dto.staffName || dto.displayName)) {
      return String(dto.displayName || dto.staffName);
    }
  } catch (error) {
    log.warn("getStaffDisplayName: fallo no critico, se usa nombre por defecto", {
      resourceId: String(resourceId || ""),
      message: String((error && error.message) || error || ""),
    });
  }
  return STAFF_DEFAULT_NAME;
}

/**
 * Comprueba si un miembro (memberId) es staff operativo del canal website.
 * Usado por el panel de gestion antes de exponer acciones privilegiadas.
 */
export async function isOperationalMember(memberId, options = {}) {
  const dto = await getStaffByMemberId(memberId, options);
  if (!dto) return false;
  return isOperationalWebsiteRole(dto.rolWebsite);
}
