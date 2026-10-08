/
 * ============================================================================
 * FILE: backend/reservas.web.js
 * VERSION: v10.0-SSOT-FRICTIONLESS
 * BASE: BIBLIA SSOT v9.1 + Anexo D (D.2.3 / D.7 / D.9) + dataAccess v10.0
 * RESPONSIBILITY: Availability engine, dual slots, staff pairing and caching.
 * STANDARDS: G10 ASCII Strict. Sin console.log directo (logger SSOT).
 *
 * CAMBIOS APLICADOS (v10.0):
 *  A1. DAL: migrado de backend/dataClient.js (legacy, pendiente de eliminacion)
 *      a backend/dataAccess.js v10.0. Desaparece el flag { suppressAuth: true }
 *      (R1/R5): toda operacion del DAL es elevada por diseno.
 *  A2. FILTROS: builder Velo (.eq/.limit/.find) sustituido por objeto nativo
       SDK v2 via wql. (R4). Cero concatenacion WQL, cero builder legacy.
 *  A3. STATUS: ninguna query filtra por 'status' en ServiciosCatalogo ni
 *      ComplementosCatalogo (Anexo D.2.3, pendiente de ADR; los datos reales
 *      contienen "ACTIVO" y el enum deseado aun no esta aprobado). La unica
 *      puerta de visibilidad publica es clientHidden === true.
 *  A4. ALIAS: eliminados todos los alias en castellano del DTO (titulo,
 *      tituloServicio, precio, duracionTotal, localizacion, resumenCorto,
 *      descripcionLarga, permitirCombinar, tiempoFase1, tiempoExposicion,
 *      tiempoFase2), los duplicados de add-on (name/title, _id/addOnId), los
 *      de staffOptions (value/label) y los contenedores redundantes
 *      metadata.pricing / metadata.timing. Un unico nombre por concepto.
 *  A5. DTO PUBLICO: _toPublicService pasa de blacklist a WHITELIST explicita.
 *      internalNotes, tipoImpositivo, sku, categoryId, locationId y
 *      clientHidden nunca salen al frontend (BIBLIA 15).
 *  A6. SEGURIDAD: se deja de filtrar err.message en webMethods
 *      Permissions.Anyone. Mensajes publicos fijos por codigo; el detalle
 *      real queda unicamente en el logger del backend.
 *  A7. FRICCION: allowCombine=true con linkedPhases invalido o autorreferenciado
 *      YA NO lanza excepcion (bloqueaba el servicio completo y vaciaba el
 *      catalogo). Se degrada a servicio simple con warn.
 *  A8. FRICCION: si la suma de fases es 0 (servicio sin datos de fase en CMS)
 *      se usa el totalDuration almacenado en lugar de devolver 0 min, que
 *      hacia fallar siempre la validacion de duracion de slot.
 *  A9. CACHE: la invalidacion borra TODAS las claves del mismo servicio
 *      (clave de busqueda + serviceId + slug). Antes solo borraba una y
 *      dejaba entradas fantasma vigentes hasta el TTL.
 *  A10. CARGA STAFF: _countStaffLoadForDay filtra en la propia query por
 *      dateYmd y resourceId (wql.in), con paginacion completa y lectura
 *      fuerte. Antes traia todas las citas del dia, filtraba en JS y aplicaba
 *      un limite fijo que truncaba el recuento y desbalanceaba el pairing.
 *  A11. ESTADO CITA: normalizacion unica via normalizeBookingStatus() sobre
 *      BOOKING_FIELDS.STATUS. Eliminado el triple chequeo CANCELED/CANCELLED
 *      y el warn por fila dentro del bucle (log spam N+1).
 *  A12. CONSISTENCIA: getConfirmedBookingForDisplay pasa a lectura fuerte.
 *      Con lectura eventual la pagina de confirmacion podia devolver
 *      NOT_FOUND sobre una cita recien creada.
 *  A13. CODIGO MUERTO: eliminados DIAS_LIMITE (sin uso), el wrapper duplicado
 *      _resolveAddonContextInternal y la rama de fallback GUID inalcanzable
 *      (isGuid se calcula ahora SOBRE la clave ya normalizada).
 *  A14. CONCURRENCIA: resolucion de resourceIds y display names en paralelo.
 * ============================================================================
 */

import { webMethod, Permissions } from "wix-web-module";
import { availabilityTimeSlots } from "@wix/bookings";

import {
    queryFirstItem,
    queryAllPages,
    wql,
    CONSISTENCY,
} from "backend/dataAccess";

import {
    BUSINESS_COLLECTIONS,
    SDK_CONFIG,
    SLOT_SEARCH,
    API,
    STAFFDEFAULTNAME,
    BOOKING_STATUS,
    BOOKING_FIELDS,
} from "backend/internalConfig";

import {
    makeTraceId,
    _safeTrim,
    _safeSlugOrId,
    _looksLikeGuid,
    _normalizeLocalIsoStr,
    getReferenceIds,
    getUtcDateFromMadridLocal,
    _executeWithRetry,
    withTimeout,
} from "public/mmUtils";

import {
    cleanGuidList,
    readDurationRange,
    resolveExpectedSlotMinutes,
    resolveLinkedPhase2Duration,
    computeGapMinutes,
    toUtcRange,
    pickStaffByLowestLoad,
} from "backend/booking/bookingUtils";

import { logger } from "backend/logger";

import {
    getStaffByMemberId,
    getStaffByResourceId,
    getStaffDisplayName,
} from "backend/staff";

import { normalizeBookingStatus } from "backend/validation";

const log = logger;

// =============================================================================
// BLOQUE 1 - CONSTANTES DE CONFIGURACION
// =============================================================================

const SERVICIOSCOL = BUSINESSCOLLECTIONS.SERVICIOS_CATALOGO;
const CITASCOL = BUSINESSCOLLECTIONS.CITAS_F2;

/
 * ANEXO D SSOT v9.1 (D.2.3 / D.9): el campo 'status' de ServiciosCatalogo y
 * ComplementosCatalogo esta PENDIENTE DE ADR. Los datos reales del CMS usan
 * valores legacy ("ACTIVO") que no pertenecen al enum deseado
 * (DRAFT | PUBLISHED | ARCHIVED). Por tanto:
 *   - NUNCA se filtra por status en lecturas publicas.
 *   - La visibilidad al cliente se determina EXCLUSIVAMENTE por clientHidden.
 *   - Este modulo funciona igual con datos ACTIVO hoy y con el enum futuro.
 */
const CLIENTHIDDENFIELD = "clientHidden";

const WATCHDOGTIMEOUTMS = SDKCONFIG.TIMEOUTS.WATCHDOGMS;
const APITIMEOUTMS = Number(SDKCONFIG?.TIMEOUTS?.APIMS) || 15000;
const SERVICECACHETTLMS = SDKCONFIG.CACHE.SERVICESTTLMS;
const CACHEMAXSIZE = SDKCONFIG.CACHE.MAXENTRIES;

const MAXDUALGAP_MINUTES = Math.max(
    0,
    Number(SLOTSEARCH?.MINUTOSMAXHUECODUAL) || 120
);

const STAFFRESOURCETYPEID = API.STAFFRESOURCETYPEID;

const STAFFLOADPAGE_SIZE = 200;
const STAFFLOADMAX_PAGES = 10;

const SDKRETRYATTEMPTS = 2;
const SDKRETRYDELAY_MS = 300;

/
 * Unica resolucion del estado cancelado. Se normaliza por la via central
 * (validation.normalizeBookingStatus) para no duplicar variantes ortograficas
 * CANCELED / CANCELLED en la logica de negocio.
 */
const CANCELLEDBOOKINGSTATUS = (() => {
    const raw = BOOKINGSTATUS?.CANCELLED ?? BOOKINGSTATUS?.CANCELED ?? "CANCELLED";
    const normalized = normalizeBookingStatus(raw);
    return _safeTrim(normalized).toUpperCase() || "CANCELLED";
})();

const CONFIGUREDLOCATIONTYPE = safeTrim(SDKCONFIG.LOCATIONTYPES?.TIMESLOTS);

const LOCATION_TS = Object.freeze({
    id: SDKCONFIG.LOCATIONID,
    locationType:
        !CONFIGUREDLOCATIONTYPE || CONFIGUREDLOCATIONTYPE === "BUSINESS"
            ? "OWNER_BUSINESS"
            : CONFIGUREDLOCATIONTYPE,
});

/
 * A5: whitelist explicita del DTO publico de servicio.
 * NUNCA anadir aqui: internalNotes, tipoImpositivo, sku, categoryId,
 * locationId, clientHidden, margen, recordHash, payloadFiscal, nifEmisor
  ni cuentaContable (BIBLIA 15 / frontend minimo).
 */
const PUBLICSERVICEFIELDS = Object.freeze([
    "serviceId",
    "slug",
    "title",
    "tagLine",
    "description",
    "location",
    "mainMedia",
    "price",
    "currency",
    "pricingModel",
    "serviceType",
    "depositAmount",
    "depositType",
    "onlinePayment",
    "inPersonPayment",
    "taxIncluded",
    "allowCombine",
    "linkedPhases",
    "phase1Duration",
    "exposureDuration",
    "phase2Duration",
    "totalDuration",
    "durationRange",
    "availableStaff",
    "staffOptions",
    "addOnOptions",
    "metadata",
]);

/
 * A5: whitelist del DTO de la pagina de confirmacion.
 */
const CONFIRMATIONDTOFIELDS = Object.freeze([
    "bookingId",
    "serviceId",
    "dateYmd",
    "slotStart",
    "slotEnd",
    "resourceId",
    "pairToken",
    "totalPrice",
]);

/
 * A6: mensajes publicos fijos. El detalle tecnico real nunca sale del backend.
 */
const PUBLICERRORMESSAGE = Object.freeze({
    SERVICENOTFOUND: "Service not found.",
    SERVICEISDUAL: "Use the dual slot endpoint for this service.",
    SERVICENOTDUAL: "Service is not configured as dual.",
    INVALID_DATE: "Invalid booking date.",
    INVALID_PAYLOAD: "The request payload is invalid.",
    INVALIDSLOTRECHECK: "Selected slot data is invalid.",
    SLOT_UNAVAILABLE: "Selected slot is no longer available.",
    SLOTDURATIONMISMATCH: "Selected slot duration does not match the service.",
    SLOTDURATIONOUTOFRANGE: "Selected slot duration is out of the allowed range.",
    STAFF_UNAVAILABLE: "Selected staff is no longer available.",
    AVAILABLESLOTSFAILED: "Could not load available slots.",
    AVAILABLEDAYSFAILED: "Could not load available days.",
    DUALSLOTSFAILED: "Could not load dual slots.",
    STAFFRESOLVEFAILED: "Could not resolve staff for the selected slot.",
    SERVICELOOKUPFAILED: "Could not load the service.",
    SERVICERESOLVEFAILED: "Could not resolve the service identifier.",
    BOOKINGIDREQUIRED: "Booking identifier is required.",
    NOT_FOUND: "Booking not found.",
    NOT_CONFIRMED: "Booking is not confirmed.",
    READ_FAILED: "Could not read the booking.",
    DURATIONRANGEWITH_ADDONS: "Services with a duration range cannot be combined with add-ons.",
    INTERNAL_ERROR: "Internal error.",
});

// =============================================================================
// BLOQUE 2 - HELPERS INTERNOS
// =============================================================================

function _publicMessage(code) {
    return PUBLICERRORMESSAGE[code] || PUBLICERRORMESSAGE.INTERNAL_ERROR;
}

/
 * Sobre de error canonico. Unica forma de error del modulo.
 */
function _errorEnvelope(code, traceId) {
    const error = { code, message: _publicMessage(code) };
    if (traceId) error.traceId = traceId;
    return { status: "ERROR", data: null, error };
}

/
 * A6: registra el detalle real en el logger del backend y devuelve un sobre
 * de error con mensaje publico fijo. Nunca propaga err.message al cliente.
 */
function _failPublic(code, traceId, context, error) {
    if (error) {
        log.warn("reservas.web public failure", Object.assign({}, context || {}, {
            traceId,
            code,
            internalMessage: error?.message,
        }));
    }
    return _errorEnvelope(code, traceId);
}

function _successEnvelope(data, traceId) {
    const envelope = { status: "SUCCESS", data, error: null };
    if (traceId) envelope.traceId = traceId;
    return envelope;
}

function _toFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function _toBoolean(value) {
    return value === true;
}

function _normalizeLookupKey(slugOrId) {
    const raw = _safeTrim(slugOrId);
    if (!raw) return "";
    return raw
        .split("?")[0]
        .split("#")[0]
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .trim();
}

function _normalizeAddon(addOn) {
    if (!addOn || typeof addOn !== "object") return null;

    // A4: '_id' es el identificador canonico de add-on (convencion Wix Data,
    // alineado con dataAccess R6). Se eliminan los alias addOnId/name.
    const addOnId = safeTrim(addOn.id || addOn.addOnId);
    const title = _safeTrim(addOn.title || addOn.name);
    const price = Number(addOn.price);

    if (!addOnId || !title || !Number.isFinite(price)) return null;

    const nativeId = _safeTrim(addOn.nativeId);

    return {
        _id: addOnId,
        title,
        price: Math.max(0, price),
        nativeId: _looksLikeGuid(nativeId) ? nativeId : null,
    };
}

// -----------------------------------------------------------------------------
// Cache en memoria de catalogo (LRV acotado por CACHEMAXSIZE)
// -----------------------------------------------------------------------------

const serviceCatalogRAM = new Map();

function _cacheSetBounded(map, key, value, maxSize) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    if (map.size  {
        const data = entry?.data;
        if (!data) {
            keysToDelete.push(key);
            return;
        }
        const matchesId = wantedServiceId && data.serviceId === wantedServiceId;
        const matchesSlug = wantedSlug && data.slug === wantedSlug;
        if (matchesId || matchesSlug) keysToDelete.push(key);
    });

    for (const key of keysToDelete) serviceCatalogRAM.delete(key);

    return keysToDelete.length;
}

// -----------------------------------------------------------------------------
// Slots
// -----------------------------------------------------------------------------

function _normalizeSlotShape(slot) {
    if (!slot || typeof slot !== "object") return null;
    if (slot.slot && typeof slot.slot === "object") {
        return Object.assign({}, slot.slot, slot);
    }
    return slot;
}

function _attachServiceId(slot, forcedServiceId, traceId, ctx) {
    const normalizedSlot = _normalizeSlotShape(slot);
    if (!normalizedSlot) return null;

    const serviceId = _safeTrim(forcedServiceId);
    if (!_looksLikeGuid(serviceId)) {
        log.error("_attachServiceId: invalid serviceId", { traceId, ctx, serviceId });
        return null;
    }

    const attached = Object.assign({}, normalizedSlot, { serviceId });

    if (normalizedSlot.slot && typeof normalizedSlot.slot === "object") {
        attached.slot = Object.assign({}, normalizedSlot.slot, { serviceId });
    }

    return attached;
}

function _getResourceIdsFromSlot(slot) {
    const normalizedSlot = _normalizeSlotShape(slot);
    if (!normalizedSlot) return [];

    let groups = [];

    if (Array.isArray(normalizedSlot.availableResources)) {
        groups = normalizedSlot.availableResources;
    } else if (Array.isArray(normalizedSlot.slot?.availableResources)) {
        groups = normalizedSlot.slot.availableResources;
    }

    if (groups.length > 0) {
        const staffGroup = groups.find(
            (group) => String(group?.resourceTypeId) === String(STAFFRESOURCETYPE_ID)
        );
        if (!staffGroup) return [];

        return Array.from(
            new Set(
                (staffGroup.resources || [])
                    .map((resource) =>
                        safeTrim(resource?.id || resource?.id || resource?.resourceId)
                    )
                    .filter((resourceId) => _looksLikeGuid(resourceId))
            )
        );
    }

    const directId = _safeTrim(
        normalizedSlot.resource?.id ||
            normalizedSlot.resource?._id ||
            normalizedSlot.resource?.resourceId ||
            normalizedSlot.resourceId
    );

    return _looksLikeGuid(directId) ? [directId] : [];
}

// -----------------------------------------------------------------------------
// Fechas y duraciones
// -----------------------------------------------------------------------------

function _isValidMadridYmd(value) {
    const ymd = _safeTrim(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!match) return false;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

function _minutesBetweenUtcDates(a, b) {
    if (!(a instanceof Date) || !(b instanceof Date)) return 0;

    const milliseconds = b.getTime() - a.getTime();
    if (!Number.isFinite(milliseconds) || milliseconds  startUtc.getTime());
}

// -----------------------------------------------------------------------------
// Recursos y staff
// -----------------------------------------------------------------------------

function _normalizeResourceIds(resourceId, traceId) {
    if (!resourceId) return [];

    const normalized = _safeTrim(resourceId);
    if (!normalized) return [];
    if (["all", "any"].includes(normalized.toLowerCase())) return [];
    if (_looksLikeGuid(normalized)) return [normalized];

    log.warn("_normalizeResourceIds: invalid resource identifier", {
        resourceId: normalized,
        traceId,
    });

    return [];
}

function _normalizeAddonIdList(addOnIds) {
    return Array.from(
        new Set(
            (Array.isArray(addOnIds) ? addOnIds : [])
                .map((id) => _safeTrim(id))
                .filter((id) => _looksLikeGuid(id))
        )
    ).sort();
}

async function _getStaffDisplayNamePublic(resourceId) {
    const id = _safeTrim(resourceId);
    if (!looksLikeGuid(id)) return STAFFDEFAULT_NAME;

    try {
        const name = await getStaffDisplayName(id);
        return safeTrim(name) || STAFFDEFAULT_NAME;
    } catch (error) {
        log.debug("Staff display name unavailable; using default", {
            resourceId: id,
            internalMessage: error?.message,
        });
        return STAFFDEFAULTNAME;
    }
}

/
 * A14: resolucion en paralelo. Las referencias del catalogo pueden apuntar a
 * Members; Bookings necesita siempre el resourceId nativo, nunca memberId ni
 * el _id de la referencia.
 */
async function _resolveAvailableStaffResourceIds(value, traceId) {
    const references = getReferenceIds(value).filter(_looksLikeGuid);
    if (references.length === 0) return [];

    const resolvedLists = await Promise.all(
        references.map(async (referenceId) => {
            try {
                const byResource = await getStaffByResourceId(referenceId, { traceId });
                if (_looksLikeGuid(byResource?.resourceId)) return byResource.resourceId;

                const byMember = await getStaffByMemberId(referenceId, { traceId });
                if (_looksLikeGuid(byMember?.resourceId)) return byMember.resourceId;
            } catch (error) {
                log.warn("Staff reference could not be resolved", {
                    traceId,
                    referenceId,
                    internalMessage: error?.message,
                });
            }
            return null;
        })
    );

    return Array.from(
        new Set(resolvedLists.filter((resourceId) => _looksLikeGuid(resourceId)))
    );
}

// -----------------------------------------------------------------------------
// Add-ons
// -----------------------------------------------------------------------------

/
 * MATRIZ A-E SSOT v7.0: los add-ons se leen unicamente de la proyeccion
 * canonica addOnOptions. No se consume ningun alias metadata.addons.
 */
function _getRequestedAddonContext(service, requestedAddonIds) {
    const requested = new Set(
        (Array.isArray(requestedAddonIds) ? requestedAddonIds : [])
            .map((id) => _safeTrim(id))
            .filter(Boolean)
    );

    const addOnOptions = Array.isArray(service?.addOnOptions) ? service.addOnOptions : [];

    const selected = addOnOptions.filter((addon) => {
        const id = safeTrim(addon?.id);
        const nativeId = _safeTrim(addon?.nativeId);
        return requested.has(id) || (nativeId && requested.has(nativeId));
    });

    return {
        nativeAddonIds: Array.from(
            new Set(
                selected
                    .map((addon) => safeTrim(addon?.nativeId || addon?.id))
                    .filter((id) => _looksLikeGuid(id))
            )
        ),
        addOnOptions: selected,
    };
}

// -----------------------------------------------------------------------------
// Payloads Bookings
// -----------------------------------------------------------------------------

function _buildListPayload({ serviceId, fromLocalDate, toLocalDate, resourceIds, nativeAddonIds }) {
    const payload = {
        serviceId: String(serviceId),
        fromLocalDate,
        toLocalDate,
        timeZone: SDK_CONFIG.TZ,
        bookable: true,
        locations: [LOCATION_TS],
        includeResourceTypeIds: [STAFFRESOURCETYPE_ID],
    };

    if (Array.isArray(resourceIds) && resourceIds.length > 0) {
        payload.resourceTypes = [
            { resourceTypeId: STAFFRESOURCETYPE_ID, resourceIds },
        ];
    }

    if (Array.isArray(nativeAddonIds) && nativeAddonIds.length > 0) {
        payload.customerChoices = { addOnIds: nativeAddonIds };
    }

    return payload;
}

function _callListTimeSlots(payload, label) {
    return _executeWithRetry(
        () =>
            withTimeout(
                () => availabilityTimeSlots.listAvailabilityTimeSlots(payload),
                WATCHDOGTIMEOUTMS,
                label
            ),
        SDKRETRYATTEMPTS,
        SDKRETRYDELAY_MS
    );
}

function _callGetTimeSlot(payload, label) {
    return _executeWithRetry(
        () =>
            withTimeout(
                () => availabilityTimeSlots.getAvailabilityTimeSlot(payload),
                WATCHDOGTIMEOUTMS,
                label
            ),
        SDKRETRYATTEMPTS,
        SDKRETRYDELAY_MS
    );
}

async function _verifyRequiredStaffViaGet({
    serviceId,
    start,
    end,
    requiredResourceId,
    nativeAddonIds,
    traceId,
}) {
    const getPayload = {
        serviceId: String(serviceId),
        localStartDate: start,
        localEndDate: end,
        location: LOCATION_TS,
        timeZone: SDK_CONFIG.TZ,
        resourceTypes: [
            {
                resourceTypeId: STAFFRESOURCETYPE_ID,
                resourceIds: [requiredResourceId],
            },
        ],
    };

    if (Array.isArray(nativeAddonIds) && nativeAddonIds.length > 0) {
        getPayload.customerChoices = { addOnIds: nativeAddonIds };
    }

    try {
        const result = await _callGetTimeSlot(getPayload, "exactSlot:verifyStaffGet");
        if (result?.timeSlot) return { ok: true, slot: result.timeSlot };
        return { ok: false, slot: null };
    } catch (error) {
        log.warn("getAvailabilityTimeSlot verification failed", {
            traceId,
            serviceId: String(serviceId),
            requiredResourceId,
            internalMessage: error?.message,
        });
        return { ok: false, slot: null };
    }
}

// =============================================================================
// BLOQUE 3 - CATALOGO DE SERVICIOS
// =============================================================================

/
 * A3: sin filtro por status. La unica puerta de visibilidad es clientHidden.
 * El filtro de visibilidad se aplica tras la lectura (no en la query) para no
 * introducir falsos negativos en filas donde el campo no este informado.
 */
async function _queryServiceByKey(cleanKey, isGuid) {
    const filter = isGuid ? wql.eq("serviceId", cleanKey) : wql.eq("slug", cleanKey);

    return withTimeout(
        () => queryFirstItem({ dataCollectionId: SERVICIOS_COL, filter }),
        WATCHDOGTIMEOUTMS,
        "getServiceBySlugOrId"
    );
}

export async function _getServiceBySlugOrIdInternal(slugOrId, externalTraceId = null) {
    const traceId = externalTraceId || makeTraceId("service");

    // A13: isGuid se calcula sobre la clave YA normalizada, lo que elimina la
    // rama de fallback GUID (antes solo alcanzable con barras residuales).
    const clean = _normalizeLookupKey(slugOrId);

    if (!clean) {
        return failPublic("SERVICENOT_FOUND", traceId, { phase: "lookup" });
    }

    const cached = serviceCatalogRAM.get(clean);
    if (cached && Date.now() - cached.timestamp  0) return phaseSum;

    const stored = _toFiniteNumber(service.totalDuration, 0);

    if (stored > 0) {
        log.warn("Phase durations are zero; using stored totalDuration", {
            traceId,
            serviceId,
            storedTotalDuration: stored,
        });
        return stored;
    }

    log.warn("Service without any duration data", { traceId, serviceId });
    return 0;
}

export async function _mapServiceImport2ToUX(service, traceId) {
    if (!service || typeof service !== "object") {
        throw new Error("Catalog service payload is not an object.");
    }

    const serviceId = _safeTrim(service.serviceId);
    if (!_looksLikeGuid(serviceId)) {
        throw new Error("Catalog serviceId is missing or invalid.");
    }

    const { allowCombine, linkedPhases } = await _resolveCombineConfig(
        service,
        serviceId,
        traceId
    );

    const phase1Duration = _toFiniteNumber(service.phase1Duration);
    const exposureDuration = _toFiniteNumber(service.exposureDuration);
    let phase2Duration = _toFiniteNumber(service.phase2Duration);

    if (allowCombine) {
        try {
            const resolved = await resolveLinkedPhase2Duration(
                linkedPhases,
                traceId,
                new Set([serviceId]),
                _getServiceBySlugOrIdInternal
            );
            if (resolved > 0) phase2Duration = resolved;
        } catch (error) {
            // A7: no se bloquea el servicio por un fallo de resolucion del
            // encadenado; se conserva la phase2Duration almacenada.
            log.warn("Linked phase2 duration could not be resolved", {
                traceId,
                serviceId,
                linkedPhases,
                internalMessage: error?.message,
            });
        }
    }

    const totalDuration = _resolveTotalDuration(
        service,
        allowCombine,
        phase1Duration,
        exposureDuration,
        phase2Duration,
        traceId,
        serviceId
    );

    const title = _safeTrim(service.title) || "Service";
    const tagLine = _safeTrim(service.tagLine) || null;
    const description = _safeTrim(service.description) || null;
    const location = _safeTrim(service.location) || null;
    const mainMedia = _safeTrim(service.mainMedia);
    const price = Math.max(0, _toFiniteNumber(service.price));
    const currency = _safeTrim(service.currency) || "EUR";

    const availableStaff = await _resolveAvailableStaffResourceIds(
        service.availableStaff,
        traceId
    );

    // A14 + A4: staffOptions canonico { id, name } (sin alias value/label).
    const staffOptions = await Promise.all(
        availableStaff.map(async (resourceId) => ({
            id: resourceId,
            name: await _getStaffDisplayNamePublic(resourceId),
        }))
    );

    const addOnOptions = (Array.isArray(service.addOnOptions) ? service.addOnOptions : [])
        .map(_normalizeAddon)
        .filter(Boolean);

    const durationRange = readDurationRange(service);

    return {
        serviceId,
        slug: _safeTrim(service.slug) || null,
        title,
        tagLine,
        description,
        location,
        mainMedia,
        price,
        currency,
        pricingModel: _safeTrim(service.pricingModel) || null,
        serviceType: _safeTrim(service.serviceType) || null,
        sku: _safeTrim(service.sku) || null,
        categoryId: _safeTrim(service.categoryId) || null,
        locationId: _safeTrim(service.locationId) || null,
        internalNotes: _safeTrim(service.internalNotes) || null,
        depositAmount: _toFiniteNumber(service.depositAmount),
        depositType: _safeTrim(service.depositType) || null,
        onlinePayment: _toBoolean(service.onlinePayment),
        inPersonPayment: _toBoolean(service.inPersonPayment),
        taxIncluded: _toBoolean(service.taxIncluded),
        // MATRIZ A-E SSOT v7.0: clave fiscal AEAT canonica. Sin alias taxRate.
        tipoImpositivo: _toFiniteNumber(service.tipoImpositivo),
        allowCombine,
        linkedPhases,
        phase1Duration,
        exposureDuration,
        phase2Duration,
        totalDuration,
        durationRange,
        availableStaff,
        staffOptions,
        addOnOptions,
        clientHidden: toBoolean(service[CLIENTHIDDEN_FIELD]),
        /
         * Contenedor canonico consumido por el widget HTML de servicio.
         * A4: sin alias en castellano, sin pricing/timing redundantes y sin
         * campos fiscales.
         */
        metadata: Object.freeze({
            title,
            tagLine,
            description,
            location,
            price,
            currency,
            mainMedia,
            addOnOptions,
            phase1Duration,
            exposureDuration,
            phase2Duration,
            totalDuration,
        }),
    };
}

export async function getServiceForBookingInternal(serviceId, traceId = null) {
    return _getServiceBySlugOrIdInternal(
        serviceId,
        traceId || makeTraceId("service-internal")
    );
}

/
 * A5: proyeccion publica por WHITELIST. Sustituye al destructuring blacklist
 * anterior, que dejaba escapar cualquier campo nuevo anadido al mapeo.
 */
export function _toPublicService(service) {
    if (!service || typeof service !== "object") return null;

    const dto = {};

    for (const field of PUBLICSERVICEFIELDS) {
        const value = service[field];
        if (value !== undefined && value !== null) dto[field] = value;
    }

    dto.linkedPhases =
        service.allowCombine === true ? service.linkedPhases || null : null;

    return dto;
}

// =============================================================================
// BLOQUE 4 - WEB METHODS DE SERVICIO
// =============================================================================

export const getServiceBySlugOrId = webMethod(
    Permissions.Anyone,
    async (slugOrId) => {
        const traceId = makeTraceId("wm-service");

        try {
            const result = await _getServiceBySlugOrIdInternal(slugOrId, traceId);

            if (result?.status !== "SUCCESS") {
                return result?.error?.code
                    ? _errorEnvelope(result.error.code, traceId)
                    : errorEnvelope("SERVICENOT_FOUND", traceId);
            }

            return successEnvelope(toPublicService(result.data));
        } catch (error) {
            return failPublic("SERVICELOOKUP_FAILED", traceId, {}, error);
        }
    }
);

export const resolveServiceId = webMethod(
    Permissions.Anyone,
    async (serviceIdRequest) => {
        const traceId = makeTraceId("wm-resolve-service");

        try {
            const resolved = await _resolveServiceIdInternal(serviceIdRequest);

            if (!resolved) return errorEnvelope("SERVICENOT_FOUND", traceId);

            return _successEnvelope(String(resolved));
        } catch (error) {
            return failPublic("SERVICERESOLVE_FAILED", traceId, {}, error);
        }
    }
);

// =============================================================================
// BLOQUE 5 - LECTURA PAGINA DE CONFIRMACION
// (SSOT-07: el codigo de pagina nunca consulta el CMS directamente)
// =============================================================================

function _toConfirmationDto(item) {
    if (!item || typeof item !== "object") return null;

    const dto = {};

    for (const key of CONFIRMATIONDTOFIELDS) {
        if (item[key] !== undefined && item[key] !== null) dto[key] = item[key];
    }

    // A11: lectura canonica unica sobre BOOKING_FIELDS.STATUS, normalizada por
    // la via central. La proyeccion NUNCA expone el campo fisico en crudo.
    dto.bookingStatus = normalizeBookingStatus(item[BOOKING_FIELDS.STATUS]);

    if (item.paymentStatus !== undefined && item.paymentStatus !== null) {
        dto.paymentStatus = item.paymentStatus;
    }

    return dto;
}

/
 * getConfirmedBookingForDisplay({ bookingId }) -> { ok, data, error }
 * Proyeccion de solo lectura de CitasF2 restringida a estados mostrables.
 * A12: lectura fuerte, obligatoria tras una creacion reciente.
 */
export const getConfirmedBookingForDisplay = webMethod(
    Permissions.Anyone,
    async ({ bookingId } = {}) => {
        const traceId = makeTraceId("confirmacion-booking");
        const cleanId = _safeTrim(bookingId);

        if (!cleanId) {
            return { ok: false, data: null, error: "BOOKINGIDREQUIRED" };
        }

        try {
            const item = await withTimeout(
                () =>
                    queryFirstItem({
                        dataCollectionId: CITAS_COL,
                        filter: wql.eq(BOOKINGFIELDS.BOOKINGID, cleanId),
                        consistency: CONSISTENCY.STRONG,
                    }),
                APITIMEOUTMS,
                "getConfirmedBookingForDisplay"
            );

            if (!item) {
                return { ok: false, data: null, error: "NOT_FOUND" };
            }

            const status = normalizeBookingStatus(item[BOOKING_FIELDS.STATUS]);

            if (
                status !== BOOKING_STATUS.CONFIRMED &&
                status !== BOOKING_STATUS.PENDING
            ) {
                return { ok: false, data: null, error: "NOT_CONFIRMED" };
            }

            return { ok: true, data: _toConfirmationDto(item), error: null };
        } catch (error) {
            log.warn("getConfirmedBookingForDisplay failed", {
                traceId,
                internalMessage: error?.message,
            });
            return { ok: false, data: null, error: "READ_FAILED" };
        }
    }
);

// =============================================================================
// BLOQUE 6 - DISPONIBILIDAD SINGLE
// =============================================================================

export const getAvailableSlots = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, resourceId, dateYmd, addOnIds = []) => {
        const traceId = makeTraceId("available-slots");

        try {
            const serviceResult = await _getServiceBySlugOrIdInternal(
                serviceIdOrSlug,
                traceId
            );

            const service = serviceResult?.data;
            const serviceId = _safeTrim(service?.serviceId);

            if (serviceResult?.status !== "SUCCESS" || !_looksLikeGuid(serviceId)) {
                return errorEnvelope("SERVICENOT_FOUND", traceId);
            }

            if (service.allowCombine === true) {
                log.warn("getAvailableSlots called for dual service", {
                    traceId,
                    serviceId,
                });
                return errorEnvelope("SERVICEIS_DUAL", traceId);
            }

            const ymd = _safeTrim(dateYmd);
            if (!_isValidMadridYmd(ymd)) {
                return errorEnvelope("INVALIDDATE", traceId);
            }

            const requestedResourceIds = _normalizeResourceIds(resourceId, traceId);
            const addonContext = _getRequestedAddonContext(service, addOnIds);

            if (addonContext.nativeAddonIds.length > 0 && service.durationRange) {
                return errorEnvelope("DURATIONRANGEWITHADDONS", traceId);
            }

            const payload = _buildListPayload({
                serviceId,
                fromLocalDate: ${ymd}T00:00:00,
                toLocalDate: ${ymd}T23:59:59,
                resourceIds: requestedResourceIds,
                nativeAddonIds: addonContext.nativeAddonIds,
            });

            const result = await _callListTimeSlots(payload, "getAvailableSlots");

            const timeSlots = Array.isArray(result?.timeSlots) ? result.timeSlots : [];

            const slots = timeSlots
                .filter((slot) => _toBoolean(slot?.bookable))
                .map((slot) => _attachServiceId(slot, serviceId, traceId, "getAvailableSlots"))
                .filter(Boolean);

            return _successEnvelope({
                slots,
                serviceId,
                dateYmd: ymd,
                resourceId: requestedResourceIds[0] || null,
            });
        } catch (error) {
            return _failPublic(
                "AVAILABLESLOTSFAILED",
                traceId,
                {
                    serviceIdOrSlug: _safeTrim(serviceIdOrSlug),
                    dateYmd: _safeTrim(dateYmd),
                },
                error
            );
        }
    }
);

// =============================================================================
// BLOQUE 7 - DISPONIBILIDAD DIAS
// =============================================================================

export const getAvailableDays = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, resourceId, year, month, addOnIds = []) => {
        const traceId = makeTraceId("available-days");

        try {
            // A3: sin filtro por status. _getServiceBySlugOrIdInternal ya
            // aplica la unica puerta de visibilidad vigente (clientHidden).
            const serviceResult = await _getServiceBySlugOrIdInternal(
                serviceIdOrSlug,
                traceId
            );

            const service = serviceResult?.data;
            const serviceId = _safeTrim(service?.serviceId);

            if (serviceResult?.status !== "SUCCESS" || !_looksLikeGuid(serviceId)) {
                return errorEnvelope("SERVICENOT_FOUND", traceId);
            }

            const y = Number(year);
            const m = Number(month);

            if (!Number.isFinite(y) || !Number.isFinite(m) || m  12) {
                return errorEnvelope("INVALIDDATE", traceId);
            }

            const monthStr = String(m).padStart(2, "0");
            const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();

            const requestedResourceIds = _normalizeResourceIds(resourceId, traceId);
            const addonContext = _getRequestedAddonContext(service, addOnIds);

            const payload = _buildListPayload({
                serviceId,
                fromLocalDate: ${y}-${monthStr}-01T00:00:00,
                toLocalDate: ${y}-${monthStr}-${String(lastDay).padStart(2, "0")}T23:59:59,
                resourceIds: requestedResourceIds,
                nativeAddonIds: service.durationRange ? [] : addonContext.nativeAddonIds,
            });

            const result = await _callListTimeSlots(payload, "getAvailableDays");

            const timeSlots = Array.isArray(result?.timeSlots) ? result.timeSlots : [];
            const daySet = new Set();

            for (const slot of timeSlots) {
                if (!_toBoolean(slot?.bookable)) continue;

                const localStart = _normalizeLocalIsoStr(
                    slot?.localStartDate || slot?.startDate
                );
                if (!localStart) continue;

                daySet.add(localStart.slice(0, 10));
            }

            return _successEnvelope({
                days: Array.from(daySet).sort(),
                serviceId,
                year: y,
                month: m,
                resourceId: requestedResourceIds[0] || null,
            });
        } catch (error) {
            return failPublic("AVAILABLEDAYS_FAILED", traceId, {}, error);
        }
    }
);

// =============================================================================
// BLOQUE 8 - CARGA DE STAFF POR DIA (CITAS_F2)
// =============================================================================

/
 * A10: el filtrado por dia y por recurso se hace EN LA QUERY (wql.in), con
 * paginacion completa y lectura fuerte. Se elimina el limite fijo que
 * truncaba el recuento y falseaba el balanceo de carga.
 */
async function _countStaffLoadForDay(dateYmd, resourceIds, traceId) {
    const ymd = _safeTrim(dateYmd);
    const ids = cleanGuidList(resourceIds);

    const loadByResource = {};
    for (const id of ids) loadByResource[id] = 0;

    if (!_isValidMadridYmd(ymd) || ids.length === 0) return loadByResource;

    try {
        const rows = await queryAllPages({
            dataCollectionId: CITAS_COL,
            filter: wql.and(wql.eq("dateYmd", ymd), wql.in("resourceId", ids)),
            consistency: CONSISTENCY.STRONG,
            pageSize: STAFFLOADPAGE_SIZE,
            maxPages: STAFFLOADMAX_PAGES,
            traceId,
        });

        let missingStatusRows = 0;

        for (const item of rows) {
            const rawStatus = item?.[BOOKING_FIELDS.STATUS];

            if (rawStatus === undefined || rawStatus === null) {
                missingStatusRows += 1;
            }

            const status = _safeTrim(normalizeBookingStatus(rawStatus)).toUpperCase();

            if (status === CANCELLEDBOOKINGSTATUS) continue;

            const resourceId = _safeTrim(item?.resourceId);
            if (!resourceId || !Object.prototype.hasOwnProperty.call(loadByResource, resourceId)) {
                continue;
            }

            loadByResource[resourceId] += 1;
        }

        // A11: un unico warn agregado en lugar de uno por fila.
        if (missingStatusRows > 0) {
            log.warn("CitasF2 rows without canonical booking status", {
                traceId,
                dateYmd: ymd,
                rows: missingStatusRows,
            });
        }
    } catch (error) {
        log.warn("_countStaffLoadForDay failed; using zero loads", {
            traceId,
            dateYmd: ymd,
            internalMessage: error?.message,
        });
    }

    return loadByResource;
}

// =============================================================================
// BLOQUE 9 - DISPONIBILIDAD DUAL
// =============================================================================

export async function _getCertifiedDualSlotsInternal(
    serviceId,
    resourceId,
    dateYmd,
    addOnIds = []
) {
    const traceId = makeTraceId("dual-slots");

    const serviceRes = await _getServiceBySlugOrIdInternal(serviceId, traceId);
    const service = serviceRes?.data;

    if (serviceRes?.status !== "SUCCESS" || !service) {
        return errorEnvelope("SERVICENOT_FOUND", traceId);
    }

    if (service.allowCombine !== true || !_looksLikeGuid(service.linkedPhases)) {
        return errorEnvelope("SERVICENOT_DUAL", traceId);
    }

    const ymd = _safeTrim(dateYmd);
    if (!_isValidMadridYmd(ymd)) {
        return errorEnvelope("INVALIDDATE", traceId);
    }

    const requestedResourceIds = _normalizeResourceIds(resourceId, traceId);
    const addonContext = _getRequestedAddonContext(service, addOnIds);

    if (addonContext.nativeAddonIds.length > 0 && service.durationRange) {
        return errorEnvelope("DURATIONRANGEWITHADDONS", traceId);
    }

    const sharedPayload = {
        fromLocalDate: ${ymd}T00:00:00,
        toLocalDate: ${ymd}T23:59:59,
        resourceIds: requestedResourceIds,
        nativeAddonIds: addonContext.nativeAddonIds,
    };

    const [f1Res, f2Res] = await Promise.all([
        _callListTimeSlots(
            _buildListPayload(Object.assign({ serviceId: service.serviceId }, sharedPayload)),
            "dual:listF1"
        ),
        _callListTimeSlots(
            _buildListPayload(Object.assign({ serviceId: service.linkedPhases }, sharedPayload)),
            "dual:listF2"
        ),
    ]);

    const f1Slots = (Array.isArray(f1Res?.timeSlots) ? f1Res.timeSlots : []).filter(
        (slot) => _toBoolean(slot?.bookable)
    );

    const f2Slots = (Array.isArray(f2Res?.timeSlots) ? f2Res.timeSlots : []).filter(
        (slot) => _toBoolean(slot?.bookable)
    );

    const staffPool = cleanGuidList(service.availableStaff || []);
    const loadByResource = await _countStaffLoadForDay(ymd, staffPool, traceId);

    const requestedResourceId = requestedResourceIds[0] || null;
    const pairs = [];

    for (const f1 of f1Slots) {
        const f1Start = _normalizeLocalIsoStr(f1?.localStartDate || f1?.startDate);
        const f1End = _normalizeLocalIsoStr(f1?.localEndDate || f1?.endDate);
        if (!f1Start || !f1End) continue;

        const range = toUtcRange(f1Start, f1End);
        if (!range) continue;

        const f1Resources = _getResourceIdsFromSlot(f1);
        if (f1Resources.length === 0) continue;

        const f1SlotRef = _attachServiceId(f1, service.serviceId, traceId, "dual:f1");
        if (!f1SlotRef) continue;

        for (const f2 of f2Slots) {
            const f2Start = _normalizeLocalIsoStr(f2?.localStartDate || f2?.startDate);
            const f2End = _normalizeLocalIsoStr(f2?.localEndDate || f2?.endDate);
            if (!f2Start || !f2End) continue;

            const f2StartUtc = getUtcDateFromMadridLocal(f2Start);
            if (!f2StartUtc) continue;

            const gapMinutes = computeGapMinutes(range.endUtc, f2StartUtc);
            if (gapMinutes  MAXDUALGAP_MINUTES) continue;

            const f2Resources = _getResourceIdsFromSlot(f2);
            const shared = f1Resources.filter((id) => f2Resources.includes(id));
            if (shared.length === 0) continue;

            const f2SlotRef = _attachServiceId(f2, service.linkedPhases, traceId, "dual:f2");
            if (!f2SlotRef) continue;

            const pairResourceId =
                requestedResourceId && shared.includes(requestedResourceId)
                    ? requestedResourceId
                    : pickStaffByLowestLoad(shared, loadByResource) || shared[0];

            pairs.push({
                fase1: { slotRef: f1SlotRef, resourceId: pairResourceId },
                fase2: { slotRef: f2SlotRef, resourceId: pairResourceId },
                pairToken: null,
                serviceId: service.serviceId,
                linkedPhases: service.linkedPhases,
                dateYmd: ymd,
                gapMinutes,
                exposureDuration: _toFiniteNumber(service.exposureDuration),
            });
        }
    }

    return _successEnvelope(pairs, traceId);
}

export const getCertifiedDualSlots = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, resourceId, dateYmd, addOnIds = []) => {
        const traceId = makeTraceId("wm-dual-slots");

        try {
            const resolved = await _resolveServiceIdInternal(serviceIdOrSlug);
            if (!resolved) return errorEnvelope("SERVICENOT_FOUND", traceId);

            return await _getCertifiedDualSlotsInternal(
                resolved,
                resourceId,
                dateYmd,
                addOnIds
            );
        } catch (error) {
            return failPublic("DUALSLOTS_FAILED", traceId, {}, error);
        }
    }
);

// =============================================================================
// BLOQUE 10 - RESOLUCION DE STAFF
// =============================================================================

export async function _resolveStaffForSlotInternal({
    serviceId,
    f1Start,
    f1End,
    f2Start,
    f2End,
    requestedResourceId,
    addOnIds = [],
    traceId,
}) {
    const activeTraceId = traceId || makeTraceId("staff-resolve");

    const resolved = await _resolveServiceIdInternal(serviceId);
    if (!resolved) return errorEnvelope("SERVICENOT_FOUND", activeTraceId);

    const normalizedAddonIds = _normalizeAddonIdList(addOnIds);

    const f1Result = await revalidateExactAvailabilitySlot({
        serviceId: resolved,
        localStartDate: f1Start,
        localEndDate: f1End,
        resourceId: requestedResourceId || null,
        nativeAddonIds: normalizedAddonIds,
        traceId: activeTraceId,
    });

    if (f1Result?.status !== "SUCCESS") return f1Result;

    const finalResourceId = f1Result.data?.resourceId || requestedResourceId || null;

    let f2Result = null;

    if (f2Start && f2End) {
        const serviceConfig = await _getServiceBySlugOrIdInternal(resolved, activeTraceId);
        const linkedPhases = _safeTrim(serviceConfig?.data?.linkedPhases);

        if (!_looksLikeGuid(linkedPhases)) {
            return errorEnvelope("INVALIDPAYLOAD", activeTraceId);
        }

        f2Result = await revalidateExactAvailabilitySlot({
            serviceId: linkedPhases,
            localStartDate: f2Start,
            localEndDate: f2End,
            resourceId: finalResourceId,
            nativeAddonIds: normalizedAddonIds,
            traceId: activeTraceId,
        });

        if (f2Result?.status !== "SUCCESS") return f2Result;
    }

    return _successEnvelope(
        {
            resourceId: finalResourceId,
            slotF1: f1Result.data?.slot || null,
            slotF2: f2Result?.data?.slot || null,
        },
        activeTraceId
    );
}

export const resolveStaffForSlot = webMethod(
    Permissions.Anyone,
    async (serviceIdOrSlug, start, resourceId, addOnIds = [], end = null) => {
        const traceId = makeTraceId("staff-resolve-wm");

        try {
            const resolved = await _resolveServiceIdInternal(serviceIdOrSlug);
            if (!resolved) return errorEnvelope("SERVICENOT_FOUND", traceId);

            return await _resolveStaffForSlotInternal({
                serviceId: resolved,
                f1Start: start,
                f1End: end,
                f2Start: null,
                f2End: null,
                requestedResourceId: resourceId,
                addOnIds,
                traceId,
            });
        } catch (error) {
            return failPublic("STAFFRESOLVE_FAILED", traceId, {}, error);
        }
    }
);

// =============================================================================
// BLOQUE 11 - REVALIDACION EXACTA
// =============================================================================

export async function revalidateExactAvailabilitySlot({
    serviceId,
    localStartDate,
    localEndDate,
    resourceId,
    nativeAddonIds = [],
    traceId,
}) {
    const activeTraceId = traceId || makeTraceId("exact-slot");

    const resolvedServiceId = await _resolveServiceIdInternal(serviceId);
    const start = _normalizeLocalIsoStr(localStartDate);
    const end = _normalizeLocalIsoStr(localEndDate);

    const rawResourceId = _safeTrim(resourceId);
    const requiredResourceId = _looksLikeGuid(rawResourceId) ? rawResourceId : "";

    if (!resolvedServiceId || !start || !end || !_isValidSlotRange(start, end)) {
        return errorEnvelope("INVALIDSLOT_RECHECK", activeTraceId);
    }

    try {
        const normalizedAddonIds = _normalizeAddonIdList(nativeAddonIds);

        const earlyServiceConfig = await _getServiceBySlugOrIdInternal(
            resolvedServiceId,
            activeTraceId
        );

        const config =
            earlyServiceConfig?.status === "SUCCESS" ? earlyServiceConfig.data : null;

        const durationRange = config?.durationRange || null;

        if (normalizedAddonIds.length > 0 && durationRange) {
            return errorEnvelope("DURATIONRANGEWITHADDONS", activeTraceId);
        }

        let rawSlot = null;

        if (normalizedAddonIds.length > 0) {
            // Con add-ons el endpoint get no admite customerChoices de forma
            // fiable: se lista el rango exacto y se busca la coincidencia.
            const listPayload = _buildListPayload({
                serviceId: resolvedServiceId,
                fromLocalDate: start,
                toLocalDate: end,
                resourceIds: requiredResourceId ? [requiredResourceId] : [],
                nativeAddonIds: normalizedAddonIds,
            });

            const listed = await _callListTimeSlots(listPayload, "exactSlot:list");

            rawSlot =
                (Array.isArray(listed?.timeSlots) ? listed.timeSlots : []).find((slot) => {
                    const slotStart = _normalizeLocalIsoStr(
                        slot?.localStartDate || slot?.startDate
                    );
                    const slotEnd = _normalizeLocalIsoStr(
                        slot?.localEndDate || slot?.endDate
                    );
                    return slotStart === start && slotEnd === end && _toBoolean(slot?.bookable);
                }) || null;
        } else {
            const getPayload = {
                serviceId: String(resolvedServiceId),
                localStartDate: start,
                localEndDate: end,
                location: LOCATION_TS,
                timeZone: SDK_CONFIG.TZ,
            };

            if (requiredResourceId) {
                getPayload.resourceTypes = [
                    {
                        resourceTypeId: STAFFRESOURCETYPE_ID,
                        resourceIds: [requiredResourceId],
                    },
                ];
            }

            const result = await _callGetTimeSlot(getPayload, "exactSlot:get");
            rawSlot = result?.timeSlot || null;
        }

        if (requiredResourceId) {
            const verification = await _verifyRequiredStaffViaGet({
                serviceId: resolvedServiceId,
                start,
                end,
                requiredResourceId,
                nativeAddonIds: normalizedAddonIds,
                traceId: activeTraceId,
            });

            if (!verification.ok) {
                return errorEnvelope("STAFFUNAVAILABLE", activeTraceId);
            }

            rawSlot = verification.slot;
        } else if (!rawSlot) {
            return errorEnvelope("SLOTUNAVAILABLE", activeTraceId);
        }

        const normalizedSlot = _attachServiceId(
            rawSlot,
            resolvedServiceId,
            activeTraceId,
            "revalidateExactAvailabilitySlot"
        );

        const availableResourceIds = _getResourceIdsFromSlot(normalizedSlot);

        if (
            !normalizedSlot ||
            !_toBoolean(normalizedSlot.bookable) ||
            availableResourceIds.length === 0
        ) {
            return errorEnvelope("SLOTUNAVAILABLE", activeTraceId);
        }

        if (requiredResourceId && !availableResourceIds.includes(requiredResourceId)) {
            return errorEnvelope("STAFFUNAVAILABLE", activeTraceId);
        }

        // Validacion de duracion contra la configuracion canonica del servicio.
        if (config) {
            const startUtc = getUtcDateFromMadridLocal(start);
            const endUtc = getUtcDateFromMadridLocal(end);
            const actualMinutes = _minutesBetweenUtcDates(startUtc, endUtc);

            if (durationRange && actualMinutes > 0) {
                const belowMin = durationRange.min > 0 && actualMinutes  durationRange.max;

                if (belowMin || aboveMax) {
                    return errorEnvelope("SLOTDURATIONOUTOF_RANGE", activeTraceId);
                }
            } else {
                const expectedMinutes = resolveExpectedSlotMinutes(config);

                if (expectedMinutes > 0 && actualMinutes > 0) {
                    if (Math.abs(actualMinutes - expectedMinutes) > 1) {
                        return errorEnvelope("SLOTDURATION_MISMATCH", activeTraceId);
                    }
                }
            }
        }

        let balancedResourceId = requiredResourceId || null;

        if (!balancedResourceId && availableResourceIds.length === 1) {
            balancedResourceId = availableResourceIds[0];
        } else if (!balancedResourceId && availableResourceIds.length > 1) {
            const dayKey = start.slice(0, 10);
            const loadMap = await _countStaffLoadForDay(
                dayKey,
                availableResourceIds,
                activeTraceId
            );
            balancedResourceId =
                pickStaffByLowestLoad(availableResourceIds, loadMap) ||
                availableResourceIds.slice().sort()[0];
        }

        return _successEnvelope(
            {
                slot: Object.assign({}, normalizedSlot, {
                    localStartDate: start,
                    localEndDate: end,
                }),
                resourceId: balancedResourceId,
                candidateResourceIds: availableResourceIds,
            },
            activeTraceId
        );
    } catch (error) {
        log.warn("Exact slot revalidation failed", {
            traceId: activeTraceId,
            serviceId: String(resolvedServiceId),
            start,
            end,
            internalMessage: error?.message,
        });

        return errorEnvelope("SLOTUNAVAILABLE", activeTraceId);
    }
}

// =============================================================================
// BLOQUE 12 - INVALIDACION DE CACHES
// =============================================================================

/
 * A9: invalidacion completa por servicio. Operacion puramente en memoria:
 * no requiere try/catch ni sobre de estado.
 */
export function _invalidateCachesInternal(serviceId, dateYmd, resourceId, traceId) {
    const sid = _safeTrim(serviceId);

    const removedKeys = _invalidateServiceCache(sid, null);

    log.info("Service cache invalidated", {
        traceId,
        serviceId: sid || null,
        dateYmd: _safeTrim(dateYmd) || null,
        resourceId: _safeTrim(resourceId) || null,
        removedKeys,
    });

    return { status: "SUCCESS", removedKeys };
}
