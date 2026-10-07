/*
=============================================================================
MODULE: backend/responseUtils.js
VERSION: v5011-CLEAN-DEAD-EXPORTS
BASE: v5009-FISCAL-V20.1
RESPONSIBILITY: Respuestas publicas, errores controlados y normalizacion
                de resultados de web methods.
STANDARDS: G10 ASCII Strict.
           Sin dependencias de Node.js.
           Sin exposicion de stacks ni secretos.

FIXES APLICADOS v5011-CLEAN-DEAD-EXPORTS:
  - CLEAN-03: eliminados AppError, toWebMethodResult e isSuccess (cero
    importadores en el repo). Se conservan successResponse, errorResponse
    y _toPublicError, usados por security.web, cajas, fiscal*, inventario
    y marianAssistant.

FIXES APLICADOS v5009-FISCAL-V20.1:
  - V20-01: sin renombrados funcionales. El modulo importa _cloneDeep y
            _safeTrim de mmUtils (no renombrados) y opera sobre objetos
            genericos.

CORRECTIONS (heredadas):
  v5007.4.
=============================================================================
*/

import { _cloneDeep, _safeTrim } from "public/mmUtils";

const MAX_ERROR_MESSAGE_LENGTH = 500;
const DEFAULT_ERROR_CODE = "INTERNAL_ERROR";
const DEFAULT_ERROR_MESSAGE = "Error interno";
const UNKNOWN_ERROR_CODE = "UNKNOWN_ERROR";

function _cloneMeta(value) {
    if (!value || typeof value !== "object") {
        return value === undefined ? {} : { details: value };
    }
    try {
        return _cloneDeep(value);
    } catch {
        return { details: "Metadata could not be cloned safely." };
    }
}

function _normalizeMeta(metaExtra) {
    if (!metaExtra || typeof metaExtra !== "object") {
        return {};
    }
    return _cloneMeta(metaExtra);
}

function _truncateMessage(message) {
    const text = _safeTrim(message) || DEFAULT_ERROR_MESSAGE;
    if (text.length <= MAX_ERROR_MESSAGE_LENGTH) {
        return text;
    }
    return text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 3) + "...";
}

function _extractError(err) {
    if (!err) {
        return { code: DEFAULT_ERROR_CODE, message: DEFAULT_ERROR_MESSAGE };
    }
    if (typeof err === "string") {
        return { code: UNKNOWN_ERROR_CODE, message: err };
    }
    return {
        code: err.code || err.name || DEFAULT_ERROR_CODE,
        message: err.message || DEFAULT_ERROR_MESSAGE,
    };
}

export function successResponse(data = null, metaExtra = {}) {
    const extra = _normalizeMeta(metaExtra);
    return {
        status: "SUCCESS",
        meta: { timestamp: new Date().toISOString(), ...extra },
        data,
        error: null,
    };
}

export function errorResponse(
    codeOrError = DEFAULT_ERROR_CODE,
    message = DEFAULT_ERROR_MESSAGE,
    metaExtra = {}
) {
    const extracted =
        codeOrError && typeof codeOrError === "object"
            ? _extractError(codeOrError)
            : { code: codeOrError, message };
    const safeMessage = _truncateMessage(
        extracted.message || message || DEFAULT_ERROR_MESSAGE
    );
    const extra = _normalizeMeta(metaExtra);
    return {
        status: "ERROR",
        meta: { timestamp: new Date().toISOString(), ...extra },
        data: null,
        error: {
            code: String(extracted.code || DEFAULT_ERROR_CODE),
            message: safeMessage,
        },
    };
}

export function _toPublicError(
    err,
    fallbackCode = DEFAULT_ERROR_CODE,
    fallbackMessage = DEFAULT_ERROR_MESSAGE
) {
    const code = err?.code || fallbackCode;
    const message = err?.message || fallbackMessage;
    return {
        code: String(code),
        message: _truncateMessage(message) || fallbackMessage,
    };
}
