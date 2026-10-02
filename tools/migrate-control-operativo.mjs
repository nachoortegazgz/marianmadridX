#!/usr/bin/env node
/**
 * FASE 4 — Script DESCHABLE de migración de datos vivos a ControlOperativo.
 * MATRIZ CAMBIO IDS §H.1: evidencia antes que destrucción → exporta CSV por
 * colección ANTES de insertar en el destino.
 *
 * Alcance (según plan SSOT v7): SOLO colecciones con estado vivo relevante:
 *   - ProcessedWebhookEvents  → controlType = WEBHOOK_EVENT  (append-only, ADR-05)
 *   - CompensacionesPendientes → controlType = COMPENSATION
 *
 * El resto (SlotLocks, RateLimitBlocks, BookingTransactions, AlertasOperativas,
 * AvailabilityDaysCache, DualSlotCache) es efímero/reconstruible: se purga vía
 * crons.js y NO se migra.
 *
 * Uso (CLI Wix autenticado con CMS editor API habilitada):
 *   node tools/migrate-control-operativo.mjs --dry-run
 *   node tools/migrate-control-operativo.mjs --execute
 *
 * Requiere env: WIX_ACCESS_TOKEN (OAuth con scopes de content write).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "https://www.wixapis.com/cms/v2/collections";
const TOKEN = process.env.WIX_ACCESS_TOKEN;
const DRY_RUN = !process.argv.includes("--execute");
const OUT_DIR = "artifacts/evidencia-fase4";

const CONTROL_OPERATIVO_ID = "ControlOperativo";

// Esquema de migración: fuente → mapeador a documento ControlOperativo
const MIGRATIONS = [
    {
        source: "ProcessedWebhookEvents",
        controlType: "WEBHOOK_EVENT",
        map: (doc) => ({
            controlType: "WEBHOOK_EVENT",
            // dedupeKey canónico: evento + id externo (idempotencia ADR-05)
            dedupeKey: `${doc.eventType || "UNKNOWN"}:${doc.externalId || doc.eventId || doc._id}`,
            status: "CLOSED", // eventos ya procesados → cerrados
            traceId: doc.traceId || `MIGRATE:${doc._id}`,
            schemaVersion: "CONTROL_V1",
            payload: {
                legacyCollection: "ProcessedWebhookEvents",
                legacyId: String(doc._id),
                processedAt: doc.processedAt || doc._updatedAt || null,
            },
            createdAt: doc._createdAt,
        }),
    },
    {
        source: "CompensacionesPendientes",
        controlType: "COMPENSATION",
        map: (doc) => ({
            controlType: "COMPENSATION",
            dedupeKey: doc.dedupeKey || `COMP:${doc.bookingId || doc._id}`,
            // estados legacy → canónicos CONTROL_STATUS
            status:
                doc.estado === "ejecutada" || doc.status === "EXECUTED"
                    ? "EXECUTED"
                    : doc.status === "FAILED"
                      ? "FAILED"
                      : "PENDING",
            traceId: doc.traceId || `MIGRATE:${doc._id}`,
            schemaVersion: "CONTROL_V1",
            payload: {
                legacyCollection: "CompensacionesPendientes",
                legacyId: String(doc._id),
                bookingId: doc.bookingId || null,
                reason: doc.reason || doc.motivo || null,
            },
            createdAt: doc._createdAt,
        }),
    },
];

async function api(pathname, opts = {}) {
    const res = await fetch(`${BASE}${pathname}`, {
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
        },
        ...opts,
    });
    if (!res.ok) throw new Error(`${res.status} ${pathname}: ${await res.text()}`);
    return res.json();
}

async function fetchAll(collectionId) {
    const items = [];
    let offset = 0;
    for (;;) {
        const data = await api(
            `/${collectionId}/items/query?offset=${offset}&limit=1000`,
            { method: "POST", body: JSON.stringify({ query: { fields: ["*"] } }) },
        );
        const page = data.items || [];
        items.push(...page);
        if (page.length < 1000) break;
        offset += 1000;
    }
    return items;
}

function toCsv(rows) {
    if (!rows.length) return "";
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const esc = (v) => {
        const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n");
}

async function main() {
    if (!TOKEN) {
        console.error("Falta WIX_ACCESS_TOKEN. Abortando sin tocar datos.");
        process.exit(1);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    console.log(`Modo: ${DRY_RUN ? "DRY-RUN (sin escrituras)" : "EJECUCIÓN REAL"}`);

    for (const mig of MIGRATIONS) {
        console.log(`\n=== ${mig.source} → ${CONTROL_OPERATIVO_ID} (${mig.controlType}) ===`);
        const docs = await fetchAll(mig.source);
        console.log(`Origen: ${docs.length} ítems.`);

        // §H.1 EVIDENCIA PRIMERO: CSV del estado vivo original
        const csvPath = path.join(OUT_DIR, `${mig.source}.csv`);
        writeFileSync(csvPath, toCsv(docs));
        console.log(`Evidencia CSV: ${csvPath}`);

        const mapped = docs.map(mig.map);

        if (DRY_RUN) {
            console.log(`[dry-run] Se migrarían ${mapped.length} documentos. Ejemplo:`,
                JSON.stringify(mapped[0], null, 2) || "(vacío)");
            continue;
        }

        // Insert por lotes de 100 (límite bulk de la API CMS)
        let inserted = 0;
        for (let i = 0; i < mapped.length; i += 100) {
            const batch = mapped.slice(i, i + 100);
            await api(`/${CONTROL_OPERATIVO_ID}/items/bulk`, {
                method: "POST",
                body: JSON.stringify({ items: batch }),
            });
            inserted += batch.length;
            console.log(`Insertados ${inserted}/${mapped.length}`);
        }
        console.log(`OK: ${inserted} docs en ${CONTROL_OPERATIVO_ID} con controlType=${mig.controlType}.`);
    }

    console.log(`\nMigración finalizada. NO se eliminan las colecciones origen hasta`);
    console.log(`verificar conteos destino (regla §H.1). Fuente→destino contado arriba.`);
}

main().catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
});
