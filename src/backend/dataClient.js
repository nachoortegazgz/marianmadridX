/*
=============================================================================
MODULE: backend/dataClient.js
PURPOSE: Single DAL (Data Access Layer) over Wix SDK v2 (@wix/data, items
namespace) exposing the legacy wix-data surface so backend modules migrate
with a one-line import change and ZERO call-site churn.
ADR-06 Etapa C / ADR-10. G10 ASCII strict.

COMPATIBILITY CONTRACT (legacy wix-data -> SDK v2):
  - query(collectionId)          -> items.query({ dataCollectionId })
    Returned builder keeps Velo method names (eq/in/ne/lt/gt/le/ge/between/
    contains/hasSome/ascending/descending/start/limit) via QueryBuilder, and
    adds find(options)/count() shims that translate Velo options to the SDK
    cursor contract:
        suppressAuth   -> suppressAuth flag (kept; harmless in SDK v2)
        consistencyMode "strong"|"eventual" -> SDK consistency enum
        reserved fields (Velo "_id" filters) -> "dataItemField._id"
    find() resolves to { items, total, totalCount, hasNext(), next(opts?) }
    matching the cursor pagination contract already used by fiscalAggregator,
    cajas.web and staff.
  - get(collectionId, itemId, options)   -> items.get(itemId, { dataCollectionId, ... })
  - insert(collectionId, item, options)  -> items.insert(item, { dataCollectionId, ... })
  - update(collectionId, item, options)  -> items.update(item, { dataCollectionId, ... })
  - save(collectionId, item, options)    -> items.save(item, { dataCollectionId, ... })
  - remove(collectionId, itemOrId, options) -> items.remove(id, { dataCollectionId, ... })
NOTE (T3 CRITICO FISCAL): consistentRead is IGNORED by SDK v2. Call-sites use
the explicit option consistencyMode: "strong" | "eventual" instead. The DAL
maps it to the SDK Consistency enum so strong reads on CAJA_SEQ are preserved
(RD 1619/2012: no duplicated numSerieFactura).
=============================================================================
*/

import { items } from "@wix/data";

// ---------------------------------------------------------------------------
// Option translation
// ---------------------------------------------------------------------------

const CONSISTENCY_STRONG = "STRONG";
const CONSISTENCY_EVENTUAL = "EVENTUAL";

function mapConsistency(options) {
  const mode = options && options.consistencyMode;
  if (mode === "strong") return CONSISTENCY_STRONG;
  if (mode === "eventual") return CONSISTENCY_EVENTUAL;
  return undefined;
}

// Translate a legacy Velo options bag into an SDK v2 options bag.
function toSdkOptions(options) {
  const opts = options || {};
  const sdk = {};
  if (opts.suppressAuth !== undefined) sdk.suppressAuth = opts.suppressAuth;
  const consistency = mapConsistency(opts);
  if (consistency !== undefined) sdk.consistency = consistency;
  if (opts.fields !== undefined) sdk.fields = opts.fields;
  if (opts.referencedData !== undefined) sdk.referencedData = opts.referencedData;
  if (opts.locale !== undefined) sdk.locale = opts.locale;
  return sdk;
}

// Reserved-field guard: "_id" is not a legal field name in SDK v2 queries.
function sdkFieldName(field) {
  return field === "_id" ? "dataItemField._id" : field;
}

// ---------------------------------------------------------------------------
// Query builder (Velo-compatible facade over @wix/data QueryBuilder)
// ---------------------------------------------------------------------------

function buildFilterWql(state) {
  // WQL string assembled from chained Velo-style predicates, joined with AND.
  const parts = [];
  for (const f of state.filters) {
    switch (f.op) {
      case "eq": parts.push(`${sdkFieldName(f.field)} = ${lit(f.value)}`); break;
      case "ne": parts.push(`${sdkFieldName(f.field)} != ${lit(f.value)}`); break;
      case "in": parts.push(`${sdkFieldName(f.field)} in [${f.values.map(lit).join(', ')}]`); break;
      case "hasSome": parts.push(`(${f.values.map((v) => `${sdkFieldName(f.field)} = ${lit(v)}`).join(' OR ')})`); break;
      case "contains": parts.push(`${sdkFieldName(f.field)}: "${escapeStr(f.value)}"`); break;
      case "lt": parts.push(`${sdkFieldName(f.field)} < ${lit(f.value)}`); break;
      case "gt": parts.push(`${sdkFieldName(f.field)} > ${lit(f.value)}`); break;
      case "le": parts.push(`${sdkFieldName(f.field)} <= ${lit(f.value)}`); break;
      case "ge": parts.push(`${sdkFieldName(f.field)} >= ${lit(f.value)}`); break;
      case "between": parts.push(`${sdkFieldName(f.field)} >= ${lit(f.low)} AND ${sdkFieldName(f.field)} <= ${lit(f.high)}`); break;
      default: throw new Error("dataClient: unsupported filter op " + f.op);
    }
  }
  return parts.length ? parts.join(" AND ") : undefined;
}

function escapeStr(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function lit(v) {
  if (v instanceof Date) return `"${v.toISOString()}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";
  return `"${escapeStr(v)}"`;
}

function createQuery(collectionId) {
  const state = { filters: [], sort: [], limitN: 30, offsetN: 0 };

  const push = (f) => { state.filters.push(f); return api; };

  const api = {};
  api.eq = (field, value) => push({ op: "eq", field, value });
  api.ne = (field, value) => push({ op: "ne", field, value });
  api.in = (field, values) => push({ op: "in", field, values: Array.from(values || []) });
  api.hasSome = (field, values) => push({ op: "hasSome", field, values: Array.from(values || []) });
  api.contains = (field, value) => push({ op: "contains", field, value });
  api.lt = (field, value) => push({ op: "lt", field, value });
  api.gt = (field, value) => push({ op: "gt", field, value });
  api.le = (field, value) => push({ op: "le", field, value });
  api.ge = (field, value) => push({ op: "ge", field, value });
  api.between = (field, low, high) => push({ op: "between", field, low, high });
  api.ascending = (...fields) => { for (const f of fields) state.sort.push({ [f]: "ASC" }); return api; };
  api.descending = (...fields) => { for (const f of fields) state.sort.push({ [f]: "DESC" }); return api; };
  api.start = (n) => { state.offsetN = n; return api; };
  api.limit = (n) => { state.limitN = n; return api; };

  function sdkRequest(extraOpts) {
    const req = {
      dataCollectionId: collectionId,
      query: {
        filter: buildFilterWql(state),
        sort: state.sort.length ? state.sort : undefined,
        paging: { offset: state.offsetN, limit: state.limitN },
      },
    };
    if (req.query.filter === undefined) delete req.query.filter;
    if (req.query.sort === undefined) delete req.query.sort;
    const sdkOpts = toSdkOptions(extraOpts);
    return { req, sdkOpts };
  }

  // Cursor-shaped result compatible with both Velo find() consumers and the
  // SDK v2 pagination contract (hasNext()/next()) already used in this repo.
  function wrapResult(res, extraOpts) {
    const itemsArr = res.items || [];
    const total = (res.pagingMetadata && res.pagingMetadata.totalCount != null)
      ? res.pagingMetadata.totalCount
      : (state.offsetN + itemsArr.length + (itemsArr.length === state.limitN ? 1 : 0));
    const wrapped = {
      items: itemsArr,
      total,
      totalCount: total,
      hasNext: () => itemsArr.length >= state.limitN && (state.offsetN + itemsArr.length) < total,
      next: async (nextOpts) => {
        const merged = Object.assign({}, extraOpts || {}, nextOpts || {});
        const prevOffset = state.offsetN;
        state.offsetN = prevOffset + itemsArr.length;
        const { req, sdkOpts } = sdkRequest(merged);
        const r2 = await items.query(req, sdkOpts);
        return wrapResult(r2, merged);
      },
    };
    return wrapped;
  }

  api.find = async (options) => {
    const { req, sdkOpts } = sdkRequest(options);
    const res = await items.query(req, sdkOpts);
    return wrapResult(res, options || {});
  };

  api.count = async (options) => {
    const { req, sdkOpts } = sdkRequest(Object.assign({}, options, {}));
    req.query.paging = { limit: 1, offset: state.offsetN };
    const res = await items.query(req, sdkOpts);
    if (res.pagingMetadata && res.pagingMetadata.totalCount != null) {
      return res.pagingMetadata.totalCount;
    }
    return (res.items || []).length;
  };

  return api;
}

// ---------------------------------------------------------------------------
// Item operations (positional legacy signatures)
// ---------------------------------------------------------------------------

function query(collectionId) {
  // Legacy wix-data returns the query builder synchronously.
  return createQuery(collectionId);
}

async function get(collectionId, itemId, options) {
  const sdkOpts = toSdkOptions(options);
  return items.get(itemId, Object.assign({ dataCollectionId: collectionId }, sdkOpts));
}

async function insert(collectionId, item, options) {
  const sdkOpts = toSdkOptions(options);
  return items.insert(item, Object.assign({ dataCollectionId: collectionId }, sdkOpts));
}

async function update(collectionId, item, options) {
  const sdkOpts = toSdkOptions(options);
  return items.update(item, Object.assign({ dataCollectionId: collectionId }, sdkOpts));
}

async function save(collectionId, item, options) {
  const sdkOpts = toSdkOptions(options);
  return items.save(item, Object.assign({ dataCollectionId: collectionId }, sdkOpts));
}

async function remove(collectionId, itemOrId, options) {
  const id = (itemOrId && typeof itemOrId === "object") ? itemOrId._id : itemOrId;
  const sdkOpts = toSdkOptions(options);
  return items.remove(id, Object.assign({ dataCollectionId: collectionId }, sdkOpts));
}

export { query, get, insert, update, save, remove };

const wixDataCompat = { query, get, insert, update, save, remove };
export default wixDataCompat;

