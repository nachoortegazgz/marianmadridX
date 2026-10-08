/*
=============================================================================
MODULE: pages/servicio-2.js
VERSION: v6000-SERVICE-CATALOG-ALIGNED
-----------------------------------------------------------------------------
CONTRATO CANÓNICO (sin alias, sin legacy):

1) BACKEND  reservas.web.getServiceBySlugOrId(lookup)
   -> { status: "SUCCESS", data: { serviceId, slug, clientHidden, metadata } }

   metadata = {
     title, tagLine, description, location,
     price, currency,
     phase1Duration, exposureDuration, phase2Duration, totalDuration,
     mainMedia, addOnOptions, recomendaciones,
     linkedPhases, availableStaff, allowCombine
   }

2) PUENTE  public/widgetBridge -> protocolo v1.0
   { version, source, type, payload }
   version = "1.0" | source = "MM_WIDGET_SERVICE"

3) WIDGET  recibe el DTO tal cual (serviceId + slug + metadata).
   No existe campo `active` en la colección ni en el DTO: no se valida.
   La duración se resuelve con metadata.totalDuration; si falta, se deriva
   de la suma de fases. Nunca bloquea el renderizado.
=============================================================================
*/

import wixLocation from "wix-location-frontend";
import { getServiceBySlugOrId } from "backend/reservas.web.js";
import {
  MESSAGE_TYPES,
  URLS,
  makeTraceId,
  _safeTrim,
  _safeSlugOrId,
  _looksLikeGuid
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

/* ------------------------------------------------------------------ */
/* CONSTANTES DE CONTRATO                                              */
/* ------------------------------------------------------------------ */

const PROTOCOL = Object.freeze({
  VERSION: "1.0",
  WIDGET_SOURCE: "MM_WIDGET_SERVICE",
  MAX_ADDONS: 5
});

const ROUTES = Object.freeze({
  SERVICIOS: "/reserva-online",
  CALENDARIO: "/booking-calendar/calendario-2"
});

const NAV_TARGETS = Object.freeze({
  SERVICIOS: "SERVICIOS"
});

const RESERVED_SEGMENTS = Object.freeze(
  new Set(["servicio", "servicios"])
);

const WIDGET_SELECTOR = "#htmlWidgetCustomService";
const BANNER_SELECTOR = "#errorBanner";

const DEFAULT_CURRENCY = "EUR";
const DEFAULT_LOCATION = "Marian Madrid";
const REFERRER = "servicio";

/* ------------------------------------------------------------------ */
/* ESTADO                                                              */
/* ------------------------------------------------------------------ */

let bridge = null;
let resolvedService = null;

/* ------------------------------------------------------------------ */
/* NORMALIZADORES PRIMITIVOS                                           */
/* ------------------------------------------------------------------ */

function text(value, fallback = "") {
  return _safeTrim(value) || fallback;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Identificador canónico de colección Wix: string plano o referencia {_id}. */
function toId(value) {
  if (typeof value === "string") {
    return _safeTrim(value);
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return _safeTrim(value._id);
  }

  return "";
}

function getErrorMessage(error, fallback) {
  return text(error?.message, fallback);
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function showError(message) {
  const safeMessage = text(message, "No se pudo cargar el servicio.");

  console.error("[servicio] Error:", safeMessage);

  try {
    const banner = $w(BANNER_SELECTOR);
    if (!banner) return;

    banner.text = `Error: ${safeMessage}`;

    if (typeof banner.show === "function") {
      banner.show();
    }
  } catch (error) {
    console.warn(
      "[servicio] No se pudo mostrar el banner de error:",
      error?.message
    );
  }
}

/* ------------------------------------------------------------------ */
/* PROTOCOLO DE MENSAJES                                               */
/* ------------------------------------------------------------------ */

function isProtocolMessage(message) {
  return Boolean(
    message &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    message.version === PROTOCOL.VERSION &&
    message.source === PROTOCOL.WIDGET_SOURCE
  );
}

function getMessageType(message) {
  return text(message?.type).toUpperCase();
}

function getPayload(message) {
  const payload = message?.payload;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }

  return payload;
}

/* ------------------------------------------------------------------ */
/* NORMALIZACIÓN DEL DTO                                               */
/* ------------------------------------------------------------------ */

function normalizeAddOn(addOn) {
  const addOnId = toId(addOn?._id);

  if (!addOnId) {
    return null;
  }

  return {
    _id: addOnId,
    title: text(addOn?.title, "Complemento"),
    price: Math.max(0, toNumber(addOn?.price))
  };
}

function normalizeRecommendation(item) {
  if (typeof item === "string") {
    return _safeTrim(item);
  }

  return text(item?.title);
}

function normalizeDurations(metadata) {
  const phase1Duration = toNumber(metadata.phase1Duration);
  const exposureDuration = toNumber(metadata.exposureDuration);
  const phase2Duration = toNumber(metadata.phase2Duration);

  const totalDuration = toNumber(
    metadata.totalDuration,
    phase1Duration + exposureDuration + phase2Duration
  );

  return {
    phase1Duration,
    exposureDuration,
    phase2Duration,
    totalDuration
  };
}

function normalizeService(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("El servicio recibido no es válido.");
  }

  const serviceId = toId(data.serviceId);
  const slug = _safeSlugOrId(data.slug);
  const metadata = data.metadata;

  if (!_looksLikeGuid(serviceId)) {
    throw new Error("El servicio no tiene un serviceId válido.");
  }

  if (!slug) {
    throw new Error("El servicio no tiene un slug válido.");
  }

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("El servicio no tiene metadata válida.");
  }

  if (data.clientHidden === true || metadata.clientHidden === true) {
    throw new Error("El servicio no está disponible para reserva.");
  }

  const durations = normalizeDurations(metadata);

  const addOnOptions = toArray(metadata.addOnOptions)
    .slice(0, PROTOCOL.MAX_ADDONS)
    .map(normalizeAddOn)
    .filter(Boolean);

  const recomendaciones = toArray(metadata.recomendaciones)
    .map(normalizeRecommendation)
    .filter(Boolean);

  const availableStaff = toArray(metadata.availableStaff)
    .map(toId)
    .filter(Boolean);

  return {
    serviceId,
    slug,
    metadata: {
      title: text(metadata.title, "Servicio"),
      tagLine: text(metadata.tagLine),
      description: text(metadata.description),
      location: text(metadata.location, DEFAULT_LOCATION),
      price: Math.max(0, toNumber(metadata.price)),
      currency: text(metadata.currency, DEFAULT_CURRENCY).toUpperCase(),
      phase1Duration: durations.phase1Duration,
      exposureDuration: durations.exposureDuration,
      phase2Duration: durations.phase2Duration,
      totalDuration: durations.totalDuration,
      mainMedia: text(metadata.mainMedia),
      addOnOptions,
      recomendaciones,
      linkedPhases: toId(
        Array.isArray(metadata.linkedPhases)
          ? metadata.linkedPhases[0]
          : metadata.linkedPhases
      ),
      availableStaff,
      allowCombine: Boolean(metadata.allowCombine)
    }
  };
}

/* ------------------------------------------------------------------ */
/* RESOLUCIÓN DE RUTA Y CARGA                                          */
/* ------------------------------------------------------------------ */

function resolveServiceLookup() {
  const query = wixLocation.query || {};

  const fromQuery =
    _safeSlugOrId(query.slug) || _safeSlugOrId(query.serviceId);

  if (fromQuery) {
    return fromQuery;
  }

  const path = toArray(wixLocation.path);
  const segment = _safeSlugOrId(path[path.length - 1]);

  if (!segment || RESERVED_SEGMENTS.has(segment)) {
    return null;
  }

  return segment;
}

async function loadService(lookupValue, traceId) {
  const result = await getServiceBySlugOrId(lookupValue);

  if (
    result?.status !== "SUCCESS" ||
    !result.data ||
    typeof result.data !== "object"
  ) {
    console.error("[servicio] Respuesta inválida del backend", {
      traceId,
      lookup: lookupValue
    });

    throw new Error(
      text(result?.error?.message, "Servicio no encontrado.")
    );
  }

  return normalizeService(result.data);
}

/* ------------------------------------------------------------------ */
/* NAVEGACIÓN                                                          */
/* ------------------------------------------------------------------ */

function getRoute(key) {
  return text(URLS?.[key], ROUTES[key]);
}

function getAddOnIds(payload) {
  const uniqueIds = [
    ...new Set(
      toArray(payload?.addOnIds)
        .map(toId)
        .filter(Boolean)
    )
  ];

  return uniqueIds.slice(0, PROTOCOL.MAX_ADDONS);
}

function buildBookingUrl(service, payload) {
  const query = new URLSearchParams({
    slug: service.slug,
    serviceId: service.serviceId,
    referral: REFERRER
  });

  const addOnIds = getAddOnIds(payload);

  if (addOnIds.length > 0) {
    query.set("addOnIds", addOnIds.join(","));
  }

  return `${getRoute("CALENDARIO")}?${query.toString()}`;
}

/* ------------------------------------------------------------------ */
/* HANDLERS DEL PUENTE                                                 */
/* ------------------------------------------------------------------ */

function handleWidgetMessage(message, traceId) {
  if (!isProtocolMessage(message)) {
    console.warn("[servicio] Mensaje fuera de protocolo", { traceId });
    return;
  }

  const type = getMessageType(message);
  const payload = getPayload(message);

  if (type === MESSAGE_TYPES.READY || type === MESSAGE_TYPES.CONTEXT) {
    return;
  }

  if (!resolvedService) {
    console.warn("[servicio] Servicio aún no disponible", { traceId, type });
    return;
  }

  if (type === MESSAGE_TYPES.BOOK) {
    try {
      wixLocation.to(buildBookingUrl(resolvedService, payload));
    } catch (error) {
      showError(
        getErrorMessage(error, "No se pudo iniciar la reserva.")
      );
    }
    return;
  }

  if (type === MESSAGE_TYPES.NAV) {
    if (text(payload.target).toUpperCase() === NAV_TARGETS.SERVICIOS) {
      wixLocation.to(getRoute("SERVICIOS"));
      return;
    }

    console.warn("[servicio] Destino de navegación no soportado", {
      traceId,
      target: payload.target
    });
    return;
  }

  console.warn("[servicio] Mensaje no soportado", { traceId, type });
}

/* ------------------------------------------------------------------ */
/* ARRANQUE                                                            */
/* ------------------------------------------------------------------ */

$w.onReady(async () => {
  const traceId = makeTraceId("servicio");

  let widget;

  try {
    widget = $w(WIDGET_SELECTOR);
  } catch (error) {
    showError("El widget del servicio no está disponible.");
    return;
  }

  if (
    !widget ||
    typeof widget.postMessage !== "function" ||
    typeof widget.onMessage !== "function"
  ) {
    showError("El widget del servicio no está disponible.");
    return;
  }

  try {
    const lookupValue = resolveServiceLookup();

    if (!lookupValue) {
      showError("No se pudo localizar el servicio en la URL.");
      return;
    }

    bridge = createWidgetBridge(widget, {
      slug: lookupValue,
      traceId,
      protocolVersion: PROTOCOL.VERSION,

      onContextReady: async () => {
        resolvedService = await loadService(lookupValue, traceId);
        return resolvedService;
      },

      onWidgetMessage: async (message) => {
        handleWidgetMessage(message, traceId);
      },

      onError: (error) => {
        showError(
          getErrorMessage(error, "No se pudo cargar el servicio.")
        );
      }
    });

    if (!bridge) {
      showError("No se pudo inicializar el widget del servicio.");
    }
  } catch (error) {
    console.error("[servicio] Error de inicialización", {
      traceId,
      message: error?.message
    });

    showError(
      getErrorMessage(error, "No se pudo cargar el servicio.")
    );
  }
});
