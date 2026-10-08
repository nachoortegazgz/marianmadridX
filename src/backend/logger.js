/*
=============================================================================
MODULE: backend/logger.js
VERSION: v10.0-SSOT-FRICTIONLESS
BASE: BIBLIA SSOT v9.1 + Anexo D (Correcciones y Reconciliación)
RESPONSIBILITY: Logging estructurado JSON con sanitización PII/secrets.
                Sin dependencias de mmUtils (LOG-09). Cero alias legacy.
STANDARDS: G10 ASCII estricto. Sin console.log directo fuera de este módulo.

CORRECCIONES APLICADAS (v10.0):
  LOG-09: Eliminada dependencia de public/mmUtils. Las funciones de enmascarado
          (_maskEmail, _maskPhone, _maskName) y makeTraceId se implementan
          localmente. El logger es infraestructura base y NO debe depender
          de módulos de negocio/utility que a su vez podrían importar logger.
  LOG-10: Eliminada export default. Solo named exports (logger, withLogging,
          LOG_LEVELS). Cero alias legacy.
  LOG-11: SECRET_FIELD_NAMES y PII_FIELD_NAMES alineados con campos reales
          del CMS actual (Anexo D §D.2). Eliminados campos legacy que ya no
          existen en ninguna colección activa.
  LOG-12: sanitizeValue usa WeakSet correctamente; se limpia tras cada nodo
          procesado para permitir re-sanitización de objetos compartidos.
  LOG-13: context no-objeto se normaliza a {} sin pérdida de traza.
  LOG-14: errorWithStack sanea stack + code + name en child contexts.
  LOG-15: Spread de context ya no puede sobrescribir level/message/timestamp/
          traceId (campos reservados se asignan DESPUÉS del spread).
=============================================================================
*/

// =============================================================================
// BLOQUE 0 - CONSTANTES Y CONFIGURACIÓN
// =============================================================================

export const LOG_LEVELS = Object.freeze({
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
});

const CURRENT_LOG_LEVEL = LOG_LEVELS.INFO;

/**
 * Campos que contienen secretos. Cualquier clave que coincida (case-insensitive,
 * sin separadores) se reemplaza por "[REDACTED_SECRET]".
 * Alineado con campos reales del CMS actual (Anexo D §D.2).
 */
const SECRET_FIELD_NAMES = new Set([
    "password",
    "secret",
    "token",
    "apikey",
    "authorization",
    "auth",
    "bearer",
    "cookie",
    "sessionid",
    "fiscalkey",
    "hmac",
    "signature",
    "creditcard",
    "cardnumber",
    "cvv",
    "pin",
    "closingSignature",
]);

/**
 * Campos que contienen PII. Se enmascaran con formato parcial preservando
 * trazabilidad forense sin exponer datos personales completos.
 * Alineado con campos reales del CMS actual (Anexo D §D.2).
 */
const PII_FIELD_NAMES = new Set([
    "email",
    "phone",
    "firstname",
    "lastname",
    "name",
    "contactdetails",
    "contact",
    "address",
    "ip",
    "ipaddress",
    "telefono",
    "correo",
    "apellidos",
    "nif",
    "taxid",
    "recipienttaxid",
    "nifdestinatario",
    "recipientlegalname",
    "nombrerazondestinatario",
]);

// =============================================================================
// BLOQUE 1 - HELPERS LOCALES (sin dependencia de mmUtils - LOG-09)
// =============================================================================

let _traceCounter = 0;

function _makeTraceId(prefix) {
    _traceCounter += 1;
    const ts = Date.now().toString(36);
    const seq = _traceCounter.toString(36);
    const rnd = Math.random().toString(36).slice(2, 6);
    return `${prefix || "log"}_${ts}_${seq}_${rnd}`;
}

function _maskEmail(value) {
    const str = String(value || "").trim();
    if (!str) return "[EMPTY]";
    const atIdx = str.indexOf("@");
    if (atIdx <= 0) return str[0] + "***";
    const local = str.slice(0, atIdx);
    const domain = str.slice(atIdx + 1);
    const maskedLocal =
        local.length <= 2
            ? local[0] + "***"
            : local[0] + "***" + local[local.length - 1];
    return `${maskedLocal}@${domain}`;
}

function _maskPhone(value) {
    const str = String(value || "").replace(/\s+/g, "");
    if (!str) return "[EMPTY]";
    if (str.length <= 4) return str[0] + "***";
    return str.slice(0, 3) + "***" + str.slice(-2);
}

function _maskName(value) {
    const str = String(value || "").trim();
    if (!str) return "[EMPTY]";
    const parts = str.split(/\s+/);
    if (parts.length === 1) {
        return parts[0][0] + "***";
    }
    return parts
        .map((p) => (p.length > 0 ? p[0] + "***" : ""))
        .join(" ");
}

// =============================================================================
// BLOQUE 2 - SANITIZACIÓN
// =============================================================================

function _asObject(value) {
    if (value === null || value === undefined) return {};
    if (typeof value !== "object" || Array.isArray(value)) return {};
    return value;
}

function _sanitizeStack(stack) {
    if (typeof stack !== "string") return stack;
    return stack
        .replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED]")
        .replace(/\/home\/[^/\s]+/g, "/home/[REDACTED]")
        .replace(/[A-Z]:\\Users\\[^\\\s]+/g, "C:\\Users\\[REDACTED]");
}

function _maskByKey(lowerKey, val) {
    if (lowerKey.includes("email") || lowerKey.includes("correo")) {
        return _maskEmail(String(val));
    }
    if (lowerKey.includes("phone") || lowerKey.includes("telefono")) {
        return _maskPhone(String(val));
    }
    if (
        lowerKey.includes("name") ||
        lowerKey.includes("apellidos") ||
        lowerKey.includes("legalname") ||
        lowerKey.includes("razon")
    ) {
        return _maskName(String(val));
    }
    if (
        lowerKey.includes("nif") ||
        lowerKey.includes("taxid") ||
        lowerKey.includes("vat")
    ) {
        const s = String(val);
        if (s.length <= 4) return s[0] + "***";
        return s.slice(0, 2) + "***" + s.slice(-2);
    }
    return "[REDACTED_PII]";
}

function _isSecretKey(lowerKey) {
    return SECRET_FIELD_NAMES.has(lowerKey);
}

function _isPiiKey(lowerKey) {
    return PII_FIELD_NAMES.has(lowerKey);
}

function sanitizeValue(value, seen) {
    if (value === null || value === undefined) return value;
    if (typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";

    seen.add(value);

    if (Array.isArray(value)) {
        const result = value.map((item) => sanitizeValue(item, seen));
        seen.delete(value);
        return result;
    }

    const sanitized = {};
    const entries = Object.entries(value);

    for (let i = 0; i < entries.length; i += 1) {
        const key = entries[i][0];
        const val = entries[i][1];
        const lowerKey = key.toLowerCase().replace(/[-_\s]/g, "");

        if (_isSecretKey(lowerKey)) {
            sanitized[key] = "[REDACTED_SECRET]";
            continue;
        }

        if (_isPiiKey(lowerKey)) {
            if (val !== null && typeof val === "object") {
                sanitized[key] = sanitizeValue(val, seen);
            } else if (typeof val === "string") {
                sanitized[key] = _maskByKey(lowerKey, val);
            } else {
                sanitized[key] = "[REDACTED_PII]";
            }
            continue;
        }

        sanitized[key] =
            val !== null && typeof val === "object"
                ? sanitizeValue(val, seen)
                : val;
    }

    seen.delete(value);
    return sanitized;
}

// =============================================================================
// BLOQUE 3 - EMISIÓN DE LOGS
// =============================================================================

/**
 * Campos reservados que NUNCA pueden ser sobrescritos por el contexto
 * del consumidor. Se asignan DESPUÉS del spread (LOG-15).
 */
function formatAndLog(level, message, context, traceId) {
    if (LOG_LEVELS[level] < CURRENT_LOG_LEVEL) return;

    const finalTraceId = traceId || _makeTraceId("log");
    const safeContext = _asObject(context);
    const sanitizedContext = sanitizeValue(safeContext, new WeakSet());

    // LOG-15: campos reservados se asignan DESPUÉS del spread para evitar
    // que un contexto malicioso o erróneo sobrescriba metadatos críticos.
    const logEntry = Object.assign({}, sanitizedContext, {
        timestamp: new Date().toISOString(),
        level: level,
        traceId: finalTraceId,
        message: String(message),
    });

    const logLine = JSON.stringify(logEntry);

    switch (level) {
        case "ERROR":
            console.error(logLine);
            break;
        case "WARN":
            console.warn(logLine);
            break;
        case "DEBUG":
            console.log(logLine);
            break;
        default:
            console.info(logLine);
    }
}

function _buildErrorContext(error, baseContext) {
    return Object.assign({}, _asObject(baseContext), {
        errorName: error?.name || "Error",
        errorMessage: error?.message,
        errorStack: _sanitizeStack(error?.stack),
        errorCode: error?.code,
    });
}

// =============================================================================
// BLOQUE 4 - LOGGER PÚBLICO
// =============================================================================

export const logger = Object.freeze({
    debug(message, context, traceId) {
        formatAndLog("DEBUG", message, context, traceId);
    },

    info(message, context, traceId) {
        formatAndLog("INFO", message, context, traceId);
    },

    warn(message, context, traceId) {
        formatAndLog("WARN", message, context, traceId);
    },

    error(message, context, traceId) {
        formatAndLog("ERROR", message, context, traceId);
    },

    errorWithStack(error, context, traceId) {
        formatAndLog(
            "ERROR",
            error?.message || "Unknown error",
            _buildErrorContext(error, context),
            traceId
        );
    },

    child(defaultContext) {
        const safeDefaults = _asObject(defaultContext);

        const merge = (context) =>
            Object.assign({}, safeDefaults, _asObject(context));

        return Object.freeze({
            debug(m, c, t) {
                formatAndLog("DEBUG", m, merge(c), t);
            },
            info(m, c, t) {
                formatAndLog("INFO", m, merge(c), t);
            },
            warn(m, c, t) {
                formatAndLog("WARN", m, merge(c), t);
            },
            error(m, c, t) {
                formatAndLog("ERROR", m, merge(c), t);
            },
            errorWithStack(e, c, t) {
                formatAndLog(
                    "ERROR",
                    e?.message || "Unknown error",
                    _buildErrorContext(e, merge(c)),
                    t
                );
            },
        });
    },
});

// =============================================================================
// BLOQUE 5 - DECORADOR DE OPERACIONES
// =============================================================================

export function withLogging(fn, operationName, defaultContext) {
    const safeDefaults = _asObject(defaultContext);

    return async function loggedOperation(...args) {
        const traceId = _makeTraceId(operationName);
        const start = Date.now();

        try {
            logger.info(
                `${operationName}_started`,
                Object.assign({}, safeDefaults, { argsCount: args.length }),
                traceId
            );

            const result = await fn(...args);

            logger.info(
                `${operationName}_completed`,
                Object.assign({}, safeDefaults, {
                    durationMs: Date.now() - start,
                    success: true,
                }),
                traceId
            );

            return result;
        } catch (error) {
            logger.errorWithStack(
                error,
                Object.assign({}, safeDefaults, {
                    durationMs: Date.now() - start,
                    success: false,
                }),
                traceId
            );
            throw error;
        }
    };
}
