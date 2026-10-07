/*
=============================================================================
MODULE: backend/crons.js
VERSION: v5011-CRON-PAIR-SDKv2
BASE: v5009-FISCAL-V20.1 + Plan de correccion (jobs.config <-> export parity)
RESPONSIBILITY: Jobs programados (cron). 8 crons activos.
STANDARDS: G10 ASCII Strict.

FIXES APLICADOS SDK v2:
  - Eliminado { suppressAuth: true } de cancelBookingElevated en 
    _runOneCompensation.
=============================================================================
*/

import wixData from "backend/dataClient";
import {
    BUSINESS_COLLECTIONS,
    OPERATIONAL_COLLECTIONS,
    CONTROL_TYPE,
    CONTROL_STATUS,
    SDK_CONFIG,
    CONCURRENCY,
} from "backend/internalConfig";
import { makeTraceId, _safeTrim, _looksLikeGuid, withTimeout, _readDate } from "public/mmUtils";
import { logger } from "backend/logger";
import {
    verifyFiscalHashChainIntegrity,
    registerZClosing,
} from "backend/cajas.web.js";
import { cancelBookingElevated } from "backend/booking/bookingCore";

const log = logger;

const API_TIMEOUT_MS =
    Number(SDK_CONFIG?.TIMEOUTS?.API_MS) || 15000;

const MAX_COMPENSATION_ATTEMPTS =
    Math.max(1, Number(CONCURRENCY?.MAX_COMPENSATION_RETRIES) || 3);

// =============================================================================
// CRON 1: cleanExpiredLocks - 15 * * * *
// =============================================================================

export async function cleanExpiredLocks() {
    const traceId = makeTraceId("cron-locks");
    try {
        const now = new Date();
        const res = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.SLOT_LOCK)
            .lt("expiresAt", now)
            .limit(100)
            .find({ suppressAuth: true });

        let removed = 0;
        for (const item of res?.items || []) {
            await wixData
                .remove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id, { suppressAuth: true })
                .catch(() => null);
            removed++;
        }

        log.info("cleanExpiredLocks completed", { removed, traceId });
    } catch (err) {
        log.error("cleanExpiredLocks failed", { error: err?.message, traceId });
    }
}

// =============================================================================
// CRON 2: cleanupExpiredDualCache - 20 * * * *
// =============================================================================

export async function cleanupExpiredDualCache() {
    const traceId = makeTraceId("cron-dual-cache");
    try {
        const now = new Date();
        const limit =
            Number(SDK_CONFIG?.JOBS?.DUAL_CACHE_CLEANUP_LIMIT) || 100;

        const res = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.DUAL_CACHE)
            .lt("expiresAt", now)
            .limit(limit)
            .find({ suppressAuth: true });

        let removed = 0;
        for (const item of res?.items || []) {
            await wixData
                .remove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id, {
                    suppressAuth: true,
                })
                .catch(() => null);
            removed++;
        }

        log.info("cleanupExpiredDualCache completed", { removed, traceId });
    } catch (err) {
        log.error("cleanupExpiredDualCache failed", {
            error: err?.message,
            traceId,
        });
    }
}

// =============================================================================
// CRON 3: runPendingCompensationsJob - 30 * * * *
// =============================================================================

async function _runOneCompensation(comp, traceId) {
    const kind = _safeTrim(comp?.kind).toUpperCase();
    const bookingId = _safeTrim(comp?.bookingId);

    if (kind === "CANCEL_BOOKING") {
        if (!bookingId || !_looksLikeGuid(bookingId)) {
            throw new Error("CANCEL_BOOKING requires a valid bookingId GUID");
        }

        await withTimeout(
            // SDK v2: cancelBookingElevated ya está elevada, no necesita suppressAuth
            () => cancelBookingElevated(bookingId),
            API_TIMEOUT_MS,
            "cron:cancelBookingCompensation"
        );

        return { ok: true, action: "CANCEL_BOOKING", bookingId };
    }

    if (kind === "FISCAL_LEDGER" || kind === "RESYNC_LEDGER_ACCOUNTING") {
        try {
            const { registerBookingPayment } = await import("backend/cajas.web.js");
            const amount = Number(comp?.totalAmount);
            const hasAmount = Number.isFinite(amount) && amount !== 0;
            const transactionId = _safeTrim(comp?.transactionId);
            const bookingIds = comp?.bookingIds || comp?.bookingId || null;

            if (kind === "FISCAL_LEDGER" && hasAmount && transactionId) {
                const result = await withTimeout(
                    () =>
                    registerBookingPayment(bookingIds, amount, comp?.paymentMethod || "ONLINE", {
                        operationDescription: comp?.operationDescription || "Fiscal recovery retry",
                        transactionId: transactionId,
                        orderId: comp?.orderId || null,
                        refundId: comp?.refundId || null,
                        tipoMovimiento: comp?.movementType || null,
                        origen: "CRON_FISCAL_RECOVERY",
                        resourceId: "online",
                        traceId: traceId,
                    }),
                    API_TIMEOUT_MS,
                    "cron:fiscalLedgerRecovery"
                );

                if (result?.status === "SUCCESS") {
                    return { ok: true, action: kind, transactionId };
                }

                throw new Error(
                    (result && result.error && result.error.message) ||
                    "FISCAL_LEDGER recovery returned non-SUCCESS"
                );
            }

            throw new Error(
                kind +
                " requires manual or extended processor (payload incomplete or RESYNC)"
            );
        } catch (err) {
            throw err;
        }
    }

    throw new Error(`Unsupported compensation kind: ${kind || "UNKNOWN"}`);
}

export async function runPendingCompensationsJob() {
    const traceId = makeTraceId("cron-comp");
    try {
        const res = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.COMPENSATION)
            .in("status", [CONTROL_STATUS.PENDING, CONTROL_STATUS.FAILED])
            .lt("attempts", MAX_COMPENSATION_ATTEMPTS)
            .limit(
                Number(SDK_CONFIG?.JOBS?.FISCAL_RECOVERY_BATCH_SIZE) || 25
            )
            .find({ suppressAuth: true });

        let processed = 0;
        let failed = 0;

        for (const comp of res?.items || []) {
            try {
                await _runOneCompensation(comp, traceId);

                comp.status = CONTROL_STATUS.EXECUTED;
                comp.lastError = null;
                comp._updatedDate = new Date();
                await wixData.update(
                    OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
                    comp, { suppressAuth: true }
                );
                processed++;
            } catch (compErr) {
                const attempts = Number(comp.attempts || 0) + 1;
                comp.attempts = attempts;
                comp.lastError = compErr?.message || "UNKNOWN";
                comp.status =
                    attempts >= MAX_COMPENSATION_ATTEMPTS ? CONTROL_STATUS.FAILED : CONTROL_STATUS.PENDING;
                comp._updatedDate = new Date();

                await wixData
                    .update(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, comp, {
                        suppressAuth: true,
                    })
                    .catch(() => null);

                failed++;

                if (comp.status === "FAILED" || comp.alertRequired === true) {
                    await wixData
                        .insert(
                            OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
                                controlType: CONTROL_TYPE.ALERT,
                                dedupeKey: `ALERT:${traceId}:${comp._id || "na"}`,
                                alertType: String(comp.kind || "").includes("FISCAL") ||
                                    String(comp.kind || "").includes("RESYNC") ?
                                    "FISCAL_RECOVERY_FAILED" :
                                    "COMPENSATION_FAILED",
                                severity: "ERROR",
                                message: `Compensation ${comp.kind || "UNKNOWN"} failed for booking ${comp.bookingId || comp.transactionId || "n/a"}`,
                                status: "OPEN",
                                traceId,
                                meta: {
                                    compensationId: comp._id || null,
                                    bookingId: comp.bookingId || null,
                                    lastError: comp.lastError,
                                    attempts,
                                },
                                _createdDate: new Date(),
                            }, { suppressAuth: true }
                        )
                        .catch(() => null);
                }
            }
        }

        log.info("runPendingCompensationsJob completed", {
            processed,
            failed,
            traceId,
        });
    } catch (err) {
        log.error("runPendingCompensationsJob failed", {
            error: err?.message,
            traceId,
        });
    }
}

// =============================================================================
// CRON 4: cleanExpiredDaysCache - 0 1 * * *
// =============================================================================

export async function cleanExpiredDaysCache() {
    const traceId = makeTraceId("cron-days-cache");
    try {
        const now = new Date();
        const res = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .eq("controlType", CONTROL_TYPE.DAYS_CACHE)
            .lt("expiresAt", now)
            .limit(200)
            .find({ suppressAuth: true });

        let removed = 0;
        for (const item of res?.items || []) {
            await wixData
                .remove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item._id, {
                    suppressAuth: true,
                })
                .catch(() => null);
            removed++;
        }

        log.info("cleanExpiredDaysCache completed", { removed, traceId });
    } catch (err) {
        log.error("cleanExpiredDaysCache failed", {
            error: err?.message,
            traceId,
        });
    }
}

// =============================================================================
// CRON 5: cleanExpiredSlotsCache - 10 1 * * *
// =============================================================================

export async function cleanExpiredSlotsCache() {
    const traceId = makeTraceId("cron-slots-cache");
    try {
        log.info(
            "cleanExpiredSlotsCache completed (RAM cache auto-resets on cold start)", { traceId }
        );
    } catch (err) {
        log.error("cleanExpiredSlotsCache failed", {
            error: err?.message,
            traceId,
        });
    }
}

// =============================================================================
// CRON 6: systemHealthCheck - 0 7 * * *
// =============================================================================

export async function systemHealthCheck() {
    const traceId = makeTraceId("cron-health");
    try {
        const results = {
            timestamp: new Date().toISOString(),
            collections: {},
            fiscalChain: null,
            secrets: {},
        };

        const criticalCols = [
            BUSINESS_COLLECTIONS.CITAS_F2,
            BUSINESS_COLLECTIONS.MOVIMIENTOS_CAJA,
            BUSINESS_COLLECTIONS.MAPA_STAFF,
            OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO,
        ];

        for (const col of criticalCols) {
            try {
                const count = await wixData.query(col).limit(1).count();
                results.collections[col] = { accessible: true, count };
            } catch (_) {
                results.collections[col] = { accessible: false, count: 0 };
            }
        }

        try {
            const chainResult = await verifyFiscalHashChainIntegrity({
                traceId,
                limit: 100,
            });
            results.fiscalChain = chainResult.status;
        } catch (_) {
            results.fiscalChain = "ERROR";
        }

        log.info("systemHealthCheck completed", { results, traceId });

        const hasIssues =
            Object.values(results.collections).some((c) => !c.accessible) ||
            results.fiscalChain !== "SUCCESS";

        if (hasIssues) {
            await wixData
                .insert(
                    OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
                        controlType: CONTROL_TYPE.ALERT,
                        dedupeKey: `ALERT:HEALTH:${traceId}`,
                        alertType: "HEALTH_CHECK_ISSUES",
                        severity: "WARNING",
                        message: "systemHealthCheck detected issues",
                        status: CONTROL_STATUS.PENDING,
                        traceId,
                        _createdDate: new Date(),
                    }, { suppressAuth: true }
                )
                .catch(() => null);
        }
    } catch (err) {
        log.error("systemHealthCheck failed", { error: err?.message, traceId });
    }
}

// =============================================================================
// CRON 7: verifyNightlyZClosing - 20 1 * * *
// =============================================================================

export async function verifyNightlyZClosing() {
    const traceId = makeTraceId("cron-zclosing");
    try {
        const targetYmd = _readDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
        if (!targetYmd) {
            throw new Error("Unable to resolve previous day key (Europe/Madrid)");
        }

        const result = await withTimeout(
            () => registerZClosing(targetYmd, { traceId, approverUser: "CRON_NIGHTLY" }),
            API_TIMEOUT_MS,
            "cron:verifyNightlyZClosing"
        );

        if (result?.status === "SUCCESS") {
            log.info("verifyNightlyZClosing completed", {
                targetYmd,
                zId: result?.data?._id || `Z_${targetYmd}`,
                traceId,
            });
            return;
        }

        const code = result?.error?.code || "Z_CLOSING_FAIL";

        if (code === "NO_MOVEMENTS" || code === "Z_ALREADY_CLOSED") {
            log.info(`verifyNightlyZClosing benign outcome: ${code}`, { targetYmd, traceId });
            return;
        }

        if (code === "ACCESS_DENIED") {
            const zRow = await wixData
                .get(BUSINESS_COLLECTIONS.HISTORICO_CIERRES_Z, `Z_${targetYmd}`, { suppressAuth: true })
                .catch(() => null);
            if (zRow) {
                log.info("verifyNightlyZClosing verified closed by prior process", {
                    targetYmd,
                    closingSignatureStatus: zRow.closingSignatureStatus || null,
                    traceId,
                });
                return;
            }
            await wixData
                .insert(
                    OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
                        controlType: CONTROL_TYPE.ALERT,
                        dedupeKey: `ALERT:ZCLOSING:${targetYmd}`,
                        alertType: "NIGHTLY_Z_CLOSING_MANUAL_REQUIRED",
                        severity: "WARN",
                        message: `Nightly Z closing for ${targetYmd} needs a manual run by ADMIN/GESTION member`,
                        status: CONTROL_STATUS.PENDING,
                        meta: { targetYmd, errorCode: code },
                        traceId,
                        _createdDate: new Date(),
                    }, { suppressAuth: true }
                )
                .catch(() => null);
            log.warn("verifyNightlyZClosing requires manual action", { targetYmd, code, traceId });
            return;
        }

        await wixData
            .insert(
                OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, {
                    controlType: CONTROL_TYPE.ALERT,
                    dedupeKey: `ALERT:ZCLOSING:${targetYmd}`,
                    alertType: "NIGHTLY_Z_CLOSING_FAILED",
                    severity: "ERROR",
                    message: `Nightly Z closing failed for ${targetYmd}: ${code}`,
                    status: CONTROL_STATUS.PENDING,
                    meta: { targetYmd, errorCode: code },
                    traceId,
                    _createdDate: new Date(),
                }, { suppressAuth: true }
            )
            .catch(() => null);

        throw new Error(`verifyNightlyZClosing failed for ${targetYmd}: ${code}`);
    } catch (err) {
        log.error("verifyNightlyZClosing failed", { error: err?.message, traceId });
        throw err;
    }
}

// =============================================================================
// CRON 8: cleanAuditLogs - 0 2 * * 0
// =============================================================================

const AUDIT_RETENTION_DAYS =
    Number(SDK_CONFIG?.JOBS?.AUDIT_RETENTION_DAYS) || 90;
const AUDIT_CLEAN_BATCH_SIZE = 1000;

export async function cleanAuditLogs() {
    const traceId = makeTraceId("cron-audit-retention");
    try {
        const cutoff = new Date(Date.now() - AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

        const res = await wixData
            .query(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO)
            .lt("_createdDate", cutoff)
            .in("controlType", [
                CONTROL_TYPE.ALERT,
                CONTROL_TYPE.COMPENSATION,
                CONTROL_TYPE.WEBHOOK_EVENT,
            ])
            .limit(AUDIT_CLEAN_BATCH_SIZE)
            .find({ suppressAuth: true });

        let removed = 0;
        let kept = 0;

        for (const item of res?.items || []) {
            const type = _safeTrim(item?.controlType).toUpperCase();
            const status = _safeTrim(item?.status).toUpperCase();

            const isRemovable =
                type === CONTROL_TYPE.ALERT ||
                (type === CONTROL_TYPE.COMPENSATION &&
                    (status === CONTROL_STATUS.EXECUTED || status === CONTROL_STATUS.FAILED)) ||
                (type === CONTROL_TYPE.WEBHOOK_EVENT &&
                    (status === CONTROL_STATUS.EXECUTED || status === CONTROL_STATUS.CLOSED));

            if (!isRemovable) {
                kept++;
                continue;
            }

            const rem = await wixData
                .remove(OPERATIONAL_COLLECTIONS.CONTROL_OPERATIVO, item, { suppressAuth: true })
                .catch(() => null);
            if (rem) removed++; else kept++;
        }

        log.info("cleanAuditLogs completed", {
            removed,
            kept,
            retentionDays: AUDIT_RETENTION_DAYS,
            traceId,
        });
    } catch (err) {
        log.error("cleanAuditLogs failed", { error: err?.message, traceId });
        throw err;
    }
}
