// FILE: src/public/widgetBridge.js
/*
=============================================================================
MODULE: public/widgetBridge.js
VERSION: v6000-BRIDGE-CANONICAL
BASE NORMATIVA:
  - BIBLIA2 / BIBLIAV v5009-V20-FINAL-CONSOLIDATED-v4.2 (Bloque 1, D6, D10, R19)
  - CAMBIO.txt seccion 11 (cero duplicidades, cero alias)
  - Dossier CMS vivo 30/09/2026 (ServiciosCatalogo rev.88)
RESPONSABILIDAD: Frontera unica y segura entre paginas Velo y widgets HTML.
STANDARDS: G10 ASCII estricto. Modulo hoja (leaf). Sin dependencias.

RESTRICCION ACICLICA OBLIGATORIA
  widgetBridge.js NO debe importar public/mmUtils.js ni modulos de backend.
  mmUtils.js reexporta este protocolo como facade; el SSOT vive aqui.

CAMPOS CANONICOS DE MENSAJE (unicos admitidos en la frontera)
  type       string   SCREAMING_SNAKE. Obligatorio. Dentro de allowedTypes.
  payload    object   Plano. Opcional en entrada; se normaliza a {}.
  messageId  string   Opcional en entrada. Obligatorio en salida.
  requestId  string   Opcional. Si falta, replica messageId.
  version    integer  OBLIGATORIO. Debe ser exactamente PROTOCOL_VERSION.

  Cualquier otro campo entrante (source, status, meta, ...) se descarta en
  normalizeMessage(): el bridge reemite siempre un objeto congelado con los
  cinco campos canonicos y nada mas.

CAMBIOS ROMPIENTES DE ALINEACION (grep antes de desplegar)
  1. bridge.postMessage() ELIMINADO. Era alias de send() con argumentos
     invertidos y colisionaba semanticamente con widgetElement.postMessage().
     Duplicidad prohibida por CAMBIO.txt seccion 11, igual que replyToMessage().
     MIGRACION: bridge.send(type, payload)
  2. export default ELIMINADO. Era alias del named export.
     MIGRACION: import { createWidgetBridge } from "public/widgetBridge";
  3. ADMIN_RESPONSE_TYPE ELIMINADO. Backdoor hardcoded fuera del SSOT
     MESSAGE_TYPES que bypaseaba la whitelist desde v5011.
     MIGRACION: createWidgetBridge(el, { allowedTypes: [...MM, "MM_ADMIN"] })
  4. version pasa a ser OBLIGATORIO. Eliminado el default silencioso a
     PROTOCOL_VERSION cuando llegaba undefined/null/"". Es la misma clase de
     tolerancia de entrada ya eliminada para messageType/eventType/data/id.
     MIGRACION: el widget debe emitir version: 1 (integer) en todo mensaje.
  5. RESPONSE_TYPE_PATTERN corregido: {0,38} -> {0,35}. El patron anterior
     admitia 43 caracteres mientras safeType() trunca a MAX_TYPE_LENGTH (40),
     de modo que todo tipo _RES largo fallaba por truncamiento y no por
     whitelist: diagnostico falso TYPE_NOT_ALLOWED sobre tipos legitimos.
  6. CONSUMER_ERROR_HANDLER_FAILED deja de ser constante muerta. El fallo del
     onError del consumidor se registra y se contiene; nunca rompe el bridge.
  7. Set interno renombrado allowedTypes -> allowedTypeSet. Eliminada la
     sombra de nombre contra bridge.allowedTypes (Array congelado).
=============================================================================
*/

/* ============================================================================
 * 1. PROTOCOLO - SSOT
 * ==========================================================================*/

export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = Object.freeze({
  READY: "MM_READY",
  CONTEXT: "MM_CONTEXT",
  AVAIL: "MM_AVAIL",
  SELECT: "MM_SELECT",
  BOOK: "MM_BOOK",
  NAV: "MM_NAV"
});

export const PROTOCOL_URLS = Object.freeze({
  SERVICIOS: "/reserva-online",
  CALENDARIO_2: "/booking-calendar/calendario-2",
  PRIVACY_POLICY: "/politica-de-privacidad"
});

/**
 * Timings de frontera. HANDSHAKE_TIMEOUT_MS y CONTEXT_TIMEOUT_MS no son
 * configuracion muerta: los consume el watchdog de este modulo.
 * FRONTEND_API_TIMEOUT_MS lo consume la pagina Velo sobre el backend.
 */
export const PROTOCOL_UI = Object.freeze({
  FRONTEND_API_TIMEOUT_MS: 60000,
  HANDSHAKE_TIMEOUT_MS: 15000,
  CONTEXT_TIMEOUT_MS: 30000
});

/* ============================================================================
 * 2. CONSTANTES DE PROTOCOLO Y SEGURIDAD
 * ==========================================================================*/

const RESPONSE_TYPE_SUFFIX = "_RES";

/** Base <= MAX_TYPE_LENGTH - 4 = 36 chars: 1 inicial + {0,35}. */
const RESPONSE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,35}_RES$/;

const MAX_TYPE_LENGTH = 40;
const MAX_MESSAGE_ID_LENGTH = 120;
const MAX_MESSAGE_BYTES = 100000;
const MAX_PAYLOAD_KEYS = 400;

/** Allowlist por defecto de origenes Wix para el HTML Component. */
const DEFAULT_ALLOWED_ORIGIN_SUFFIXES = Object.freeze([
  ".parastorage.com",
  ".wix.com",
  ".wixsite.com",
  ".editorx.com"
]);

/**
 * El HTML Component de Wix se monta sobre iframe de origen opaco, por lo que
 * estos origenes se admiten por defecto y se rigen por allowOpaqueOrigin.
 */
const OPAQUE_ORIGIN_PREFIXES = Object.freeze([
  "blob:",
  "data:",
  "filesystem:"
]);

export const WIDGET_ERROR_CODE = Object.freeze({
  INVALID_WIDGET: "WIDGET_INVALID_HTML_COMPONENT",
  DESTROYED: "WIDGET_BRIDGE_DESTROYED",
  ORIGIN_REJECTED: "WIDGET_ORIGIN_REJECTED",
  ORIGIN_OPAQUE_REJECTED: "WIDGET_ORIGIN_OPAQUE_REJECTED",
  MESSAGE_TOO_LARGE: "WIDGET_MESSAGE_TOO_LARGE",
  PAYLOAD_TOO_COMPLEX: "WIDGET_PAYLOAD_TOO_COMPLEX",
  TYPE_MISSING: "WIDGET_MESSAGE_TYPE_MISSING",
  TYPE_NOT_ALLOWED: "WIDGET_MESSAGE_TYPE_NOT_ALLOWED",
  VERSION_UNSUPPORTED: "WIDGET_PROTOCOL_VERSION_UNSUPPORTED",
  MESSAGE_REJECTED: "WIDGET_MESSAGE_REJECTED",
  HANDSHAKE_TIMEOUT: "WIDGET_HANDSHAKE_TIMEOUT",
  CONTEXT_TIMEOUT: "WIDGET_CONTEXT_TIMEOUT",
  CONTEXT_FAILED: "WIDGET_CONTEXT_FAILED",
  LISTENER_FAILED: "WIDGET_MESSAGE_LISTENER_FAILED",
  HANDLER_FAILED: "WIDGET_MESSAGE_HANDLER_FAILED",
  CONSUMER_ERROR_HANDLER_FAILED: "WIDGET_ERROR_HANDLER_FAILED"
});

const DEFAULT_ALLOWED_TYPES = Object.freeze(Object.values(MESSAGE_TYPES));

const BRIDGE_DISCRIMINATOR = "WIX_HTML_COMPONENT_BRIDGE";

const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

let instanceCounter = 0;

/* ============================================================================
 * 3. HELPERS INTERNOS PUROS
 * ==========================================================================*/

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeType(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .slice(0, MAX_TYPE_LENGTH);
}

function safeMessageId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "_")
    .slice(0, MAX_MESSAGE_ID_LENGTH);
}

/**
 * Lectura estricta de version. Sin default: ausencia o valor no entero
 * positivo devuelve null y el mensaje se rechaza.
 */
function readProtocolVersion(value) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function estimateBytes(value) {
  let serialized;

  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    // Estructura circular o no serializable: se trata como exceso de tamano.
    return MAX_MESSAGE_BYTES + 1;
  }

  if (typeof serialized !== "string") {
    return MAX_MESSAGE_BYTES + 1;
  }

  return textEncoder ? textEncoder.encode(serialized).length : serialized.length;
}

function countKeys(value) {
  if (!value || typeof value !== "object") return 0;

  let total = 0;
  const stack = [value];

  while (stack.length > 0 && total <= MAX_PAYLOAD_KEYS) {
    const current = stack.pop();

    if (!current || typeof current !== "object") continue;

    const keys = Object.keys(current);
    total += keys.length;

    for (let index = 0; index < keys.length; index += 1) {
      const child = current[keys[index]];

      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }

  return total;
}

/**
 * Constructor canonico del tipo de respuesta de una peticion.
 * Unico punto del sistema que concatena RESPONSE_TYPE_SUFFIX.
 */
export function buildResponseType(type) {
  return `${safeType(type)}${RESPONSE_TYPE_SUFFIX}`;
}

function getResponseTypeBase(type) {
  return RESPONSE_TYPE_PATTERN.test(type)
    ? type.slice(0, -RESPONSE_TYPE_SUFFIX.length)
    : "";
}

function resolveOriginPolicy(options) {
  const exact = String(options.allowedOrigin ?? "").trim().toLowerCase();

  if (exact) {
    return Object.freeze({
      mode: "exact",
      exact,
      suffixes: Object.freeze([]),
      allowOpaqueOrigin: options.allowOpaqueOrigin !== false
    });
  }

  const custom = Array.isArray(options.allowedOriginSuffixes)
    ? options.allowedOriginSuffixes
        .map((suffix) => String(suffix ?? "").trim().toLowerCase())
        .filter(Boolean)
    : [];

  const strict = options.strictOrigin !== false;

  return Object.freeze({
    mode: strict ? "suffix" : "off",
    exact: "",
    suffixes: Object.freeze(
      custom.length > 0 ? custom : DEFAULT_ALLOWED_ORIGIN_SUFFIXES
    ),
    allowOpaqueOrigin: options.allowOpaqueOrigin !== false
  });
}

function classifyOrigin(rawOrigin) {
  const origin = String(rawOrigin ?? "").trim().toLowerCase();

  if (!origin || origin === "null") {
    return { opaque: true, value: origin };
  }

  const isOpaque = OPAQUE_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix));

  return { opaque: isOpaque, value: origin };
}

function getOriginHost(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch (error) {
    return origin
      .replace(/^[a-z0-9+.-]+:\/\//i, "")
      .split("/")[0]
      .toLowerCase();
  }
}

function isOriginAllowed(origin, policy) {
  if (policy.mode === "off") return true;

  if (policy.mode === "exact") return origin === policy.exact;

  const host = getOriginHost(origin);

  return policy.suffixes.some(
    (suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix)
  );
}

/**
 * Envuelve una promesa con timeout gestionado por el Set de timers del bridge,
 * de modo que destroy() cancele tambien los watchdogs pendientes.
 */
function withManagedTimeout(promise, timeoutMs, code, timers) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;
      timers.delete(timer);

      const error = new Error(code);
      error.code = code;

      reject(error);
    }, Math.max(1, Number(timeoutMs) || 1));

    timers.add(timer);

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        timers.delete(timer);

        resolve(value);
      },
      (error) => {
        if (settled) return;

        settled = true;
        clearTimeout(timer);
        timers.delete(timer);

        reject(error);
      }
    );
  });
}

function buildBridgeError(code, bridgeId, detail) {
  const error = new Error(code);

  error.code = code;
  error.bridgeId = bridgeId;

  if (detail !== null && detail !== undefined) {
    error.detail = detail;
  }

  return error;
}

/* ============================================================================
 * 4. FABRICA DEL BRIDGE
 * ==========================================================================*/

/**
 * @param {Object} widgetElement  $w.HtmlComponent con onMessage/postMessage.
 * @param {Object} [options]
 * @param {string[]}   [options.allowedTypes]           Whitelist de tipos.
 * @param {Function}   [options.onWidgetMessage]        Handler unico de negocio.
 * @param {Function}   [options.onContextReady]         Resuelve el contexto a publicar.
 * @param {Function}   [options.onError]                Handler de errores de frontera.
 * @param {boolean}    [options.strictOrigin=true]      Activa validacion por sufijos.
 * @param {string}     [options.allowedOrigin]          Origen exacto (tiene prioridad).
 * @param {string[]}   [options.allowedOriginSuffixes]  Sufijos propios.
 * @param {boolean}    [options.allowOpaqueOrigin=true] Admite blob:/data:/null.
 * @param {number}     [options.handshakeTimeoutMs]
 * @param {number}     [options.contextTimeoutMs]
 * @returns {Readonly<Object>} Bridge congelado.
 */
export function createWidgetBridge(widgetElement, options = {}) {
  if (
    !widgetElement ||
    typeof widgetElement.onMessage !== "function" ||
    typeof widgetElement.postMessage !== "function"
  ) {
    throw buildBridgeError(WIDGET_ERROR_CODE.INVALID_WIDGET, null, null);
  }

  const settings = safeObject(options);

  instanceCounter += 1;

  const bridgeId = `wbridge-${instanceCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const originPolicy = resolveOriginPolicy(settings);

  const allowedTypeSet = new Set(
    Array.isArray(settings.allowedTypes) && settings.allowedTypes.length > 0
      ? settings.allowedTypes.map(safeType).filter(Boolean)
      : DEFAULT_ALLOWED_TYPES
  );

  const handshakeTimeoutMs =
    Number(settings.handshakeTimeoutMs) > 0
      ? Number(settings.handshakeTimeoutMs)
      : PROTOCOL_UI.HANDSHAKE_TIMEOUT_MS;

  const contextTimeoutMs =
    Number(settings.contextTimeoutMs) > 0
      ? Number(settings.contextTimeoutMs)
      : PROTOCOL_UI.CONTEXT_TIMEOUT_MS;

  const onWidgetMessage =
    typeof settings.onWidgetMessage === "function" ? settings.onWidgetMessage : null;

  const onContextReady =
    typeof settings.onContextReady === "function" ? settings.onContextReady : null;

  const onError = typeof settings.onError === "function" ? settings.onError : null;

  let destroyed = false;
  let sequence = 0;
  let handshakeCompleted = false;
  let contextInFlight = false;
  let contextPublished = false;
  let bridge = null;

  const listeners = new Set();
  const timers = new Set();

  /* ---------------------------------------------------------------- */
  /* Politica de tipos                                                 */
  /* ---------------------------------------------------------------- */

  function isAllowedType(type) {
    if (allowedTypeSet.has(type)) return true;

    const base = getResponseTypeBase(type);

    return Boolean(base) && allowedTypeSet.has(base);
  }

  /* ---------------------------------------------------------------- */
  /* Errores y timers                                                  */
  /* ---------------------------------------------------------------- */

  function fail(code, detail = null) {
    const error = buildBridgeError(code, bridgeId, detail);

    if (!onError) return error;

    try {
      onError(error, detail);
    } catch (consumerError) {
      // El manejador del consumidor nunca debe romper el puente.
      console.error(
        `[widgetBridge] ${WIDGET_ERROR_CODE.CONSUMER_ERROR_HANDLER_FAILED}`,
        { bridgeId, code, message: consumerError?.message }
      );
    }

    return error;
  }

  function clearAllTimers() {
    timers.forEach((timer) => clearTimeout(timer));
    timers.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Validacion de entrada                                             */
  /* ---------------------------------------------------------------- */

  function extractEvent(event) {
    const classified = classifyOrigin(event?.origin);

    if (classified.opaque) {
      if (!originPolicy.allowOpaqueOrigin) {
        fail(WIDGET_ERROR_CODE.ORIGIN_OPAQUE_REJECTED, { origin: classified.value });
        return null;
      }
    } else if (!isOriginAllowed(classified.value, originPolicy)) {
      fail(WIDGET_ERROR_CODE.ORIGIN_REJECTED, { origin: classified.value });
      return null;
    }

    const message = safeObject(event?.data);

    if (estimateBytes(message) > MAX_MESSAGE_BYTES) {
      fail(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE, { bridgeId });
      return null;
    }

    if (countKeys(message) > MAX_PAYLOAD_KEYS) {
      fail(WIDGET_ERROR_CODE.PAYLOAD_TOO_COMPLEX, { bridgeId });
      return null;
    }

    return message;
  }

  function normalizeMessage(source) {
    const type = safeType(source.type);

    if (!type) {
      return { message: null, code: WIDGET_ERROR_CODE.TYPE_MISSING };
    }

    if (!isAllowedType(type)) {
      return { message: null, code: WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED, detail: { type } };
    }

    const version = readProtocolVersion(source.version);

    if (version !== PROTOCOL_VERSION) {
      return {
        message: null,
        code: WIDGET_ERROR_CODE.VERSION_UNSUPPORTED,
        detail: { received: source.version, expected: PROTOCOL_VERSION }
      };
    }

    const messageId = safeMessageId(source.messageId);

    return {
      message: Object.freeze({
        type,
        payload: Object.freeze(safeObject(source.payload)),
        messageId,
        requestId: safeMessageId(source.requestId) || messageId,
        version: PROTOCOL_VERSION,
        bridgeId
      }),
      code: null,
      detail: null
    };
  }

  /* ---------------------------------------------------------------- */
  /* Salida                                                            */
  /* ---------------------------------------------------------------- */

  function nextMessageId() {
    sequence += 1;

    return safeMessageId(
      `${bridgeId}-${Date.now().toString(36)}-${sequence.toString(36)}`
    );
  }

  /**
 * Emision canonica y unica hacia el widget.
 * @param {string} type               Tipo dentro de allowedTypes.
 * @param {Object} [payload]          Carga util plana.
 * @param {string|null} [messageId]   Id de correlacion de una peticion previa.
 * @returns {string} messageId emitido.
 */
  function send(type, payload = {}, messageId = null) {
    if (destroyed) {
      throw buildBridgeError(WIDGET_ERROR_CODE.DESTROYED, bridgeId, null);
    }

    const normalizedType = safeType(type);

    if (!isAllowedType(normalizedType)) {
      throw buildBridgeError(WIDGET_ERROR_CODE.TYPE_NOT_ALLOWED, bridgeId, {
        type: normalizedType
      });
    }

    const message = Object.freeze({
      type: normalizedType,
      payload: Object.freeze(safeObject(payload)),
      messageId: safeMessageId(messageId) || nextMessageId(),
      version: PROTOCOL_VERSION,
      bridgeId
    });

    if (estimateBytes(message) > MAX_MESSAGE_BYTES) {
      throw buildBridgeError(WIDGET_ERROR_CODE.MESSAGE_TOO_LARGE, bridgeId, {
        type: normalizedType
      });
    }

    widgetElement.postMessage(message);

    return message.messageId;
  }

  function resolveCorrelationId(requestMessage) {
    if (!requestMessage) return "";

    if (typeof requestMessage === "string") return safeMessageId(requestMessage);

    if (typeof requestMessage !== "object") return "";

    return (
      safeMessageId(requestMessage.messageId) || safeMessageId(requestMessage.requestId)
    );
  }

  /**
 * Respuesta correlacionada a un mensaje entrante.
 * @param {string} type
 * @param {Object} [payload]
 * @param {Object|string|null} [requestMessage] Mensaje original o su id.
 * @returns {string} messageId emitido.
 */
  function reply(type, payload = {}, requestMessage = null) {
    return send(type, payload, resolveCorrelationId(requestMessage) || null);
  }

  /* ---------------------------------------------------------------- */
  /* Suscripcion                                                       */
  /* ---------------------------------------------------------------- */

  function subscribe(callback) {
    if (destroyed || typeof callback !== "function") {
      return () => {};
    }

    listeners.add(callback);

    return () => {
      listeners.delete(callback);
    };
  }

  function notifyListeners(message) {
    listeners.forEach((listener) => {
      try {
        listener(message, bridge);
      } catch (error) {
        fail(WIDGET_ERROR_CODE.LISTENER_FAILED, error);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* Handshake y contexto                                              */
  /* ---------------------------------------------------------------- */

  /**
 * Publica el contexto una unica vez por bridge. Los reintentos de READY del
 * widget no provocan re-resolucion ni duplicidad de CONTEXT.
 */
  function publishContext(message) {
    if (!onContextReady || contextInFlight || contextPublished) return;

    contextInFlight = true;

    withManagedTimeout(
      Promise.resolve().then(() => onContextReady(message, bridge)),
      contextTimeoutMs,
      WIDGET_ERROR_CODE.CONTEXT_TIMEOUT,
      timers
    )
      .then((context) => {
        contextInFlight = false;

        if (destroyed || context === undefined || context === null) return;

        contextPublished = true;

        send(MESSAGE_TYPES.CONTEXT, context, message.messageId || null);
      })
      .catch((error) => {
        contextInFlight = false;

        fail(
          error?.code === WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
            ? WIDGET_ERROR_CODE.CONTEXT_TIMEOUT
            : WIDGET_ERROR_CODE.CONTEXT_FAILED,
          error
        );
      });
  }

  function armHandshakeWatchdog() {
    if (!onContextReady || handshakeTimeoutMs <= 0) return;

    const timer = setTimeout(() => {
      timers.delete(timer);

      if (destroyed || handshakeCompleted) return;

      fail(WIDGET_ERROR_CODE.HANDSHAKE_TIMEOUT, { bridgeId, handshakeTimeoutMs });
    }, handshakeTimeoutMs);

    timers.add(timer);
  }

  /* ---------------------------------------------------------------- */
  /* Listener unico sobre el HTML Component                            */
  /* ---------------------------------------------------------------- */

  const unsubscribeWidget = widgetElement.onMessage((event) => {
    if (destroyed) return;

    try {
      const extracted = extractEvent(event);

      if (!extracted) return;

      const normalized = normalizeMessage(extracted);

      if (!normalized.message) {
        fail(normalized.code || WIDGET_ERROR_CODE.MESSAGE_REJECTED, normalized.detail);
        return;
      }

      const message = normalized.message;

      if (message.type === MESSAGE_TYPES.READY) {
        handshakeCompleted = true;
      }

      notifyListeners(message);

      if (onWidgetMessage) {
        Promise.resolve()
          .then(() => onWidgetMessage(message, bridge))
          .catch((error) => {
            fail(error?.code || WIDGET_ERROR_CODE.HANDLER_FAILED, error);
          });
      }

      if (message.type === MESSAGE_TYPES.READY) {
        publishContext(message);
      }
    } catch (error) {
      fail(error?.code || WIDGET_ERROR_CODE.HANDLER_FAILED, error);
    }
  });

  armHandshakeWatchdog();

  /* ---------------------------------------------------------------- */
  /* Superficie publica congelada                                      */
  /* ---------------------------------------------------------------- */

  bridge = Object.freeze({
    type: BRIDGE_DISCRIMINATOR,
    bridgeId,
    protocolVersion: PROTOCOL_VERSION,
    widget: widgetElement,
    originPolicyMode: originPolicy.mode,
    allowedTypes: Object.freeze(Array.from(allowedTypeSet)),

    get destroyed() {
      return destroyed;
    },

    get handshakeCompleted() {
      return handshakeCompleted;
    },

    get contextPublished() {
      return contextPublished;
    },

    send,
    reply,
    subscribe,

    destroy() {
      if (destroyed) return;

      destroyed = true;

      listeners.clear();
      clearAllTimers();

      if (typeof unsubscribeWidget === "function") {
        try {
          unsubscribeWidget();
        } catch (error) {
          // El widget ya puede estar desmontado; la baja es idempotente.
        }
      }
    }
  });

  return bridge;
}
