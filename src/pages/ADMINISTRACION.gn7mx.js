/*
=============================================================================
MODULE: pages/ADMINISTRACION.gn7mx.js
VERSION: v21.1-RESTORED
BASE: v21.0-CLEAN
RESPONSIBILITY: Controlador de la pagina de administracion Marian.
STANDARDS: G10 ASCII Strict.

CHANGELOG v21.1:
  - Restaurada accion INVENTORY_QUEUE (import dinamico defensivo).
  - Restaurados isAdmin e isCajero en el context (llamadas reales a
    checkAdminAccess y checkCajeroAccess de security.web).
  - Restaurado inventoryQueue en el context (via accion importada).
=============================================================================
*/

import wixMembersFrontend from "wix-members-frontend";
import wixLocation from "wix-location";

import {
    checkStaffCollaboratorAccess,
    checkAdminAccess,
    checkCajeroAccess,
} from "backend/security.web";
import {
    getCashierState,
    registerManualTransaction,
    registerXCount,
    registerZClosing,
} from "backend/cajas.web";
import { getInventoryDashboard } from "backend/inventario.web";
import {
    getQuarterlyTaxSummary,
    getLibroRegistroFacturasExpedidas,
} from "backend/fiscalAggregator.web";
import { askMarianAssistant } from "backend/marianAssistant.web";
import {
    previewManagerPackage,
    createManagerPackageVersion,
    getManagerPackageHistory,
    getPreparedManagerPackages,
    downloadManagerPackageVersion,
    emailManagerPackageVersion,
} from "backend/fiscalDocuments.web";

import {
    URLS,
    MONEY,
    makeTraceId,
    _safeTrim,
    _isValidEmail,
    _toDateSafe,
} from "public/mmUtils";
import { createWidgetBridge } from "public/widgetBridge";

// =============================================================================
// HELPERS DE VALIDACION
// =============================================================================

function _readYear(value) {
    const year = Number(value);
    return Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : null;
}

function _readQuarter(value) {
    const quarter = Number(value);
    return [1, 2, 3, 4].includes(quarter) ? quarter : null;
}

function _readEmail(value) {
    const email = _safeTrim(value).toLowerCase();
    return _isValidEmail(email) ? email : null;
}

function _readPositiveAmount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function _readDateKey(value) {
    const raw = _safeTrim(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const parsed = _toDateSafe(`${raw}T12:00:00`);
    return parsed ? raw : null;
}

function _readDocumentId(value) {
    const id = _safeTrim(value);
    const pattern = /^DOC_GESTORIA_(20\d{2}|21\d{2})_(T[1-4]|M(0[1-9]|1[0-2]))_PAQUETE_GESTORIA_V\d{4}$/;
    return pattern.test(id) ? id : null;
}

function _readPeriodParams(payload) {
    const year = _readYear(payload?.year);
    const quarter = _readQuarter(payload?.quarter);
    if (!year || !quarter) return null;
    return { year, quarter };
}

function _err(code, message) {
    return { status: "ERROR", data: null, error: { code, message } };
}

// =============================================================================
// IMPORT DINAMICO DEFENSIVO — getInventoryReconciliationQueue
// =============================================================================

async function _safeGetInventoryReconciliationQueue() {
    try {
        const mod = await import("backend/inventario.web");
        if (typeof mod.getInventoryReconciliationQueue !== "function") {
            return _err(
                "BACKEND_NOT_IMPLEMENTED",
                "getInventoryReconciliationQueue no esta exportada en inventario.web.js."
            );
        }
        return await mod.getInventoryReconciliationQueue();
    } catch (error) {
        return _err(
            "BACKEND_IMPORT_FAILED",
            error?.message || "No se pudo importar el backend de inventario."
        );
    }
}

// =============================================================================
// MAPA DE ACCIONES
// =============================================================================

const ACTIONS = Object.freeze({
    CASHIER_STATE: ({ payload, traceId }) =>
        getCashierState({ traceId, diaKey: _readDateKey(payload?.diaKey) }),

    INVENTORY_DASH: () => getInventoryDashboard(),

    INVENTORY_QUEUE: () => _safeGetInventoryReconciliationQueue(),

    TPV_TX: async ({ payload, traceId }) => {
        const amount = _readPositiveAmount(payload?.amount);
        const paymentMethod = _safeTrim(payload?.paymentMethod).toUpperCase();
        const transactionKind = _safeTrim(payload?.transactionKind).toUpperCase() || "VENTA";
        const concept = _safeTrim(payload?.concept);

        if (!amount) return _err("INVALID_INPUT", "Importe invalido.");
        if (!["EFECTIVO", "TARJETA", "BIZUM"].includes(paymentMethod)) {
            return _err("INVALID_INPUT", "Forma de pago invalida.");
        }
        if (!["VENTA", "PROPINA"].includes(transactionKind)) {
            return _err("INVALID_INPUT", "Naturaleza invalida.");
        }
        if (!concept) return _err("INVALID_INPUT", "Concepto obligatorio.");

        return registerManualTransaction({
            amount,
            paymentMethod,
            tipoMovimiento: transactionKind === "PROPINA" ? "PROPINA" : "",
            concept,
            resourceId: null,
            traceId,
        });
    },

    X_COUNT: async ({ payload, traceId }) => {
        const diaKey = _readDateKey(payload?.diaKey);
        const metalicoCaja = Number(payload?.metalicoCaja);
        if (!diaKey) return _err("INVALID_INPUT", "Fecha invalida.");
        if (!Number.isFinite(metalicoCaja) || metalicoCaja < 0) {
            return _err("INVALID_INPUT", "Efectivo contado invalido.");
        }
        return registerXCount(diaKey, { metalicoCaja, traceId });
    },

    Z_CLOSING: async ({ payload, traceId }) => {
        const diaKey = _readDateKey(payload?.diaKey);
        if (!diaKey) return _err("INVALID_INPUT", "Fecha de cierre obligatoria.");
        return registerZClosing(diaKey, { traceId });
    },

    FISCAL_SUMMARY: async ({ payload, traceId }) => {
        const period = _readPeriodParams(payload);
        if (!period) return _err("INVALID_INPUT", "Ejercicio/trimestre invalidos.");
        return getQuarterlyTaxSummary(period.year, period.quarter, { traceId });
    },

    FISCAL_BOOK: async ({ payload, traceId }) => {
        const period = _readPeriodParams(payload);
        if (!period) return _err("INVALID_INPUT", "Ejercicio/trimestre invalidos.");
        return getLibroRegistroFacturasExpedidas(period.year, period.quarter, { traceId });
    },

    DOCUMENT_PREVIEW: ({ payload }) => {
        const period = _readPeriodParams(payload);
        if (!period) return _err("INVALID_INPUT", "Ejercicio/trimestre invalidos.");
        return previewManagerPackage(period);
    },

    DOCUMENT_CREATE: ({ payload }) => {
        const period = _readPeriodParams(payload);
        if (!period) return _err("INVALID_INPUT", "Ejercicio/trimestre invalidos.");
        return createManagerPackageVersion(period);
    },

    DOCUMENT_HISTORY: ({ payload }) => {
        const period = _readPeriodParams(payload);
        if (!period) return _err("INVALID_INPUT", "Ejercicio/trimestre invalidos.");
        return getManagerPackageHistory(period);
    },

    DOCUMENT_PREPARED: () => getPreparedManagerPackages(),

    DOCUMENT_DOWNLOAD: ({ payload }) => {
        const documentId = _readDocumentId(payload?.documentId);
        if (!documentId) return _err("INVALID_INPUT", "Documento invalido.");
        return downloadManagerPackageVersion({ documentId });
    },

    DOCUMENT_EMAIL: ({ payload }) => {
        const documentId = _readDocumentId(payload?.documentId);
        const recipient = _readEmail(payload?.recipient);
        if (!documentId) return _err("INVALID_INPUT", "Documento invalido.");
        if (!recipient) return _err("INVALID_INPUT", "Email invalido.");
        if (payload?.confirmed !== true) {
            return _err("CONFIRMATION_REQUIRED", "Confirma el envio antes de continuar.");
        }
        return emailManagerPackageVersion({ documentId, recipient, confirmed: true });
    },

    AI_CHAT: ({ payload, traceId }) => {
        const message = _safeTrim(payload?.message);
        const history = Array.isArray(payload?.history) ? payload.history : [];
        if (!message) return _err("INVALID_INPUT", "Escribe una consulta.");
        return askMarianAssistant({ message, history, traceId });
    },
});

// =============================================================================
// ON READY
// =============================================================================

$w.onReady(async function () {
    const traceId = makeTraceId("admin-page");

    const widget = $w("#htmlAdmin") || $w("#htmlAdministracion");
    if (!widget || typeof widget.postMessage !== "function") {
        console.error("[ADMINISTRACION] HTML widget no encontrado.");
        return;
    }

    const member = await wixMembersFrontend.currentMember
        .getMember()
        .catch(() => null);

    if (!member) {
        await wixMembersFrontend.authentication.promptLogin();
        return;
    }

    const [accessRes, adminRes, cajeroRes] = await Promise.all([
        checkStaffCollaboratorAccess({ traceId }).catch(() => null),
        checkAdminAccess({ traceId }).catch(() => null),
        checkCajeroAccess({ traceId }).catch(() => null),
    ]);

    const access = accessRes?.status === "SUCCESS" ? accessRes.data : null;
    const isAdmin = adminRes?.status === "SUCCESS" ? adminRes.data?.isAdmin === true : false;
    const isCajero = cajeroRes?.status === "SUCCESS" ? cajeroRes.data?.isCajero === true : false;

    if (!access?.isMarianManager) {
        wixLocation.to(URLS.SERVICIOS);
        return;
    }

    const memberName = member?.profile?.nickname
        || member?.contactDetails?.firstName
        || "Marian";

    createWidgetBridge(widget, {
        slug: "administracion",
        traceId,

        onContextReady: async () => {
            const [cashierRes, invRes, queueRes] = await Promise.all([
                getCashierState({ traceId }).catch(() => null),
                getInventoryDashboard().catch(() => null),
                _safeGetInventoryReconciliationQueue().catch(() => null),
            ]);

            const today = new Date().toLocaleDateString("sv-SE", {
                timeZone: "Europe/Madrid",
            });

            return {
                isMarianManager: true,
                isStaffCollaborator: access.isStaffCollaborator === true,
                isAdmin,
                isCajero,
                memberName,
                timeZone: "Europe/Madrid",
                currencyCode: MONEY.DISPLAY_CURRENCY,
                today,
                cashierState: cashierRes?.status === "SUCCESS" ? cashierRes.data : null,
                inventory: invRes?.status === "SUCCESS" ? invRes.data : null,
                inventoryQueue: queueRes?.status === "SUCCESS"
                    ? (queueRes.data?.items || [])
                    : [],
            };
        },

        onWidgetMessage: async (msg, reply) => {
            const type = String(msg?.type || "").trim().toUpperCase();
            const handler = ACTIONS[type];

            if (!handler) {
                reply(`${type}_RES`, _err("UNKNOWN_ACTION", "Accion no reconocida."));
                return;
            }

            try {
                const result = await handler({
                    payload: msg?.payload || {},
                    traceId,
                });
                reply(`${type}_RES`, result);
            } catch (error) {
                reply(`${type}_RES`, _err(
                    error?.code || "ACTION_FAILED",
                    error?.message || String(error)
                ));
            }
        },

        onError: (error) => {
            console.error("[ADMINISTRACION] Bridge error:", error?.message);
        },
    });
});
