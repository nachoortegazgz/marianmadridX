/*
=============================================================================
MODULE: backend/dataClient.js
PURPOSE: Single DAL (Data Access Layer) over Wix SDK v2 (@wix/data, items
namespace) exposing the legacy wix-data surface so backend modules migrate
with a one-line import change and minimal call-site churn.
ADR-06 Etapa C / ADR-10 -- v2, corregido contra el contrato REAL de SDK v2
(verificado contra la documentacion oficial dev.wix.com, 2026-10).

CORRECCIONES RESPECTO A LA VERSION ANTERIOR DE ESTE FICHERO (bugs reales,
no solo de estilo):
  1) ARIDAD/ORDEN DE ARGUMENTOS: items.query/get/insert/update/save/remove
     se invocan con TRES argumentos posicionales:
         items.<op>(dataCollectionId, payload, options)
     La version anterior fusionaba dataCollectionId dentro de un unico
     objeto y llamaba con 2 argumentos -- firma incorrecta.
  2) FILTRO: query.filter es un OBJETO JSON (estilo MongoQL: $eq, $ne, $in,
     $gt, $gte, $lt, $lte, $hasSome, $hasAll, $startsWith, $and, $or, $not),
     NO una cadena WQL. La version anterior construia un string SQL-like
     que la API no acepta.
  3) OPCION "suppressAuth": NO EXISTE en el contrato de items.*（confirmado
     contra la lista oficial de opciones: suppressHooks, showDrafts,
     appOptions, language, consistentRead, returnTotalCount,
     includeReferences, includeFieldGroups). Pasarla como opcion no hace
     nada: la elevacion de permisos real SOLO se logra envolviendo la
     funcion del SDK con auth.elevate() de "@wix/essentials" ANTES de
     invocarla. Este DAL crea copias elevadas de cada operacion y las usa
     cuando el caller pide { suppressAuth: true }, preservando el
     comportamiento esperado por los 19 ficheros que usan ese flag (ver
     APENDICE C de la BIBLIA) sin tocar ningun call-site.
  4) CONSISTENCIA FUERTE (T3 CRITICO FISCAL -- CAJA_SEQ, RD 1619/2012):
     "consistentRead" SI es una opcion real y vigente de SDK v2 (booleano).
     NO existe un enum "consistency" STRONG/EVENTUAL. El mapeo legado
     consistencyMode "strong"|"eventual" se traduce ahora a
     consistentRead: true | false respectivamente.
  5) pagingMetadata.total (no "totalCount") y pagingMetadata.hasNext ya
     vienen resueltos por el SDK; la version anterior los recalculaba mal
     y leia un campo que no existe en la respuesta real.
  6) sort: cada entrada es { fieldName, order }, no { [field]: "ASC" }.

COMPATIBILITY CONTRACT (legacy wix-data -> SDK v2 real):
  - query(collectionId) -> items.query(collectionId, queryRequest, options)
    Devuelve un builder compatible con los nombres Velo (eq/ne/in/hasSome/
    contains/lt/gt/le/ge/between/ascending/descending/start/limit) y
    find(options)/count(options) que resuelven a
    { items, total, totalCount, hasNext(), next(opts?) }.
  - get(collectionId, itemId, options)      -> items.get(collectionId, itemId, options)
  - insert(collectionId, item, options)     -> items.insert(collectionId, item, options)
  - update(collectionId, item, options)     -> items.update(collectionId, item, options)
  - save(collectionId, item, options)       -> items.save(collectionId, item, options)
  - remove(collectionId, itemOrId, options) -> items.remove(collectionId, itemId, options)

LIMITACION CONOCIDA (contains): el operador oficial mas cercano a la
"contiene subcadena" de Velo es "$startsWith" (coincide solo PREFIJOS,
no subcadenas en cualquier posicion); la API Query Language publica no
documenta un operador $contains generico. Los call-sites que dependen de
coincidencia de subcadena en posicion arbitraria deben revisarse caso a
caso -- ver auditoria.
=============================================================================
*/

import { items } from "@wix/data";
import { auth } from "@wix/essentials";

// Copias elevadas (creadas una sola vez; auth.elevate() envuelve la
// funcion, no los argumentos, asi que una copia por operacion basta).
const elevatedQuery = auth.elevate(items.query);
const elevatedGet = auth.elevate(items.get);
const elevatedInsert = auth.elevate(items.insert);
const elevatedUpdate = auth.elevate(items.update);
const elevatedSave = auth.elevate(items.save);
const elevatedRemove = auth.elevate(items.remove);

// ---------------------------------------------------------------------------
// Option translation
// ---------------------------------------------------------------------------

function shouldElevate(options) {
  return !!(options && options.suppressAuth === true);
}

// Translate a legacy Velo options bag into a real SDK v2 options bag.
function toSdkOptions(options) {
  const opts = options || {};
  const sdk = {};
  if (opts.consistencyMode === "strong") sdk.consistentRead = true;
  else if (opts.consistencyMode === "eventual") sdk.consistentRead = false;
  else if (opts.consistentRead !== undefined) sdk.consistentRead = !!opts.consistentRead;

  if (opts.fields !== undefined) sdk.fields = opts.fields;

  if (opts.includeReferences !== undefined) {
    sdk.includeReferences = opts.includeReferences;
  } else if (opts.referencedData !== undefined) {
    // Legacy shim: array of field names -> array of { field }.
    sdk.includeReferences = Array.from(opts.referencedData).map((f) =>
      typeof f === "string" ? { field: f } : f
    );
  }

  if (opts.locale !== undefined) sdk.language = opts.locale;
  else if (opts.language !== undefined) sdk.language = opts.language;

  if (opts.suppressHooks !== undefined) sdk.suppressHooks = opts.suppressHooks;
  if (opts.showDrafts !== undefined) sdk.showDrafts = opts.showDrafts;
  if (opts.returnTotalCount !== undefined) sdk.returnTotalCount = opts.returnTotalCount;
  if (opts.appOptions !== undefined) sdk.appOptions = opts.appOptions;

  return sdk;
}

// ---------------------------------------------------------------------------
// Query builder (Velo-compatible facade over @wix/data items.query)
// ---------------------------------------------------------------------------

function litValue(v) {
  // query.filter values travel as native JSON values (the SDK/REST layer
  // serializes Date -> {"$date": ...} automatically); plain ISO strings
  // are also accepted per the official docs, so this is enough here.
  return v instanceof Date ? v.toISOString() : v;
}

function fieldFilterClause(f) {
  const field = f.field;
  switch (f.op) {
    case "eq": return { [field]: litValue(f.value) };
    case "ne": return { [field]: { "$ne": litValue(f.value) } };
    case "in": return { [field]: { "$in": f.values.map(litValue) } };
    case "hasSome": return { [field]: { "$hasSome": f.values.map(litValue) } };
    // LIMITACION: ver nota "contains" en la cabecera del modulo.
    case "contains": return { [field]: { "$startsWith": f.value } };
    case "lt": return { [field]: { "$lt": litValue(f.value) } };
    case "gt": return { [field]: { "$gt": litValue(f.value) } };
    case "le": return { [field]: { "$lte": litValue(f.value) } };
    case "ge": return { [field]: { "$gte": litValue(f.value) } };
    case "between": return { [field]: { "$gte": litValue(f.low), "$lte": litValue(f.high) } };
    default: throw new Error("dataClient: unsupported filter op " + f.op);
  }
}

function buildFilterObj(state) {
  if (!state.filters.length) return undefined;
  if (state.filters.length === 1) return fieldFilterClause(state.filters[0]);
  // Multiple predicates: always-safe explicit $and (works even when the
  // same field appears more than once with different operators).
  return { "$and": state.filters.map(fieldFilterClause) };
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
  api.ascending = (...fields) => { for (const f of fields) state.sort.push({ fieldName: f, order: "ASC" }); return api; };
  api.descending = (...fields) => { for (const f of fields) state.sort.push({ fieldName: f, order: "DESC" }); return api; };
  api.start = (n) => { state.offsetN = n; return api; };
  api.limit = (n) => { state.limitN = n; return api; };

  function buildQueryRequest() {
    const queryRequest = {
      paging: { offset: state.offsetN, limit: state.limitN },
    };
    const filter = buildFilterObj(state);
    if (filter !== undefined) queryRequest.filter = filter;
    if (state.sort.length) queryRequest.sort = state.sort;
    return queryRequest;
  }

  // Cursor-shaped result compatible with both Velo find() consumers and
  // the real SDK v2 pagingMetadata contract (total / hasNext) already
  // relied upon by fiscalAggregator, cajas.web and staff.
  function wrapResult(res, extraOpts) {
    const itemsArr = res.items || [];
    const pm = res.pagingMetadata || {};
    const total = pm.total != null ? pm.total : (state.offsetN + itemsArr.length);
    const hasNextFlag = pm.hasNext != null ? pm.hasNext : (itemsArr.length >= state.limitN);
    return {
      items: itemsArr,
      total,
      totalCount: total, // legacy alias kept for existing call-sites
      hasNext: () => hasNextFlag,
      next: async (nextOpts) => {
        const merged = Object.assign({}, extraOpts || {}, nextOpts || {});
        state.offsetN = state.offsetN + itemsArr.length;
        const queryRequest = buildQueryRequest();
        const sdkOpts = toSdkOptions(merged);
        const fn = shouldElevate(merged) ? elevatedQuery : items.query;
        const r2 = await fn(collectionId, queryRequest, sdkOpts);
        return wrapResult(r2, merged);
      },
    };
  }

  api.find = async (options) => {
    const opts = options || {};
    const queryRequest = buildQueryRequest();
    const sdkOpts = toSdkOptions(opts);
    const fn = shouldElevate(opts) ? elevatedQuery : items.query;
    const res = await fn(collectionId, queryRequest, sdkOpts);
    return wrapResult(res, opts);
  };

  api.count = async (options) => {
    const opts = Object.assign({}, options, { returnTotalCount: true });
    const queryRequest = buildQueryRequest();
    queryRequest.paging = { limit: 1, offset: state.offsetN };
    const sdkOpts = toSdkOptions(opts);
    const fn = shouldElevate(opts) ? elevatedQuery : items.query;
    const res = await fn(collectionId, queryRequest, sdkOpts);
    const pm = res.pagingMetadata || {};
    if (pm.total != null) return pm.total;
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
  const opts = options || {};
  const sdkOpts = toSdkOptions(opts);
  const fn = shouldElevate(opts) ? elevatedGet : items.get;
  return fn(collectionId, itemId, sdkOpts);
}

async function insert(collectionId, item, options) {
  const opts = options || {};
  const sdkOpts = toSdkOptions(opts);
  const fn = shouldElevate(opts) ? elevatedInsert : items.insert;
  return fn(collectionId, item, sdkOpts);
}

async function update(collectionId, item, options) {
  const opts = options || {};
  const sdkOpts = toSdkOptions(opts);
  const fn = shouldElevate(opts) ? elevatedUpdate : items.update;
  return fn(collectionId, item, sdkOpts);
}

async function save(collectionId, item, options) {
  const opts = options || {};
  const sdkOpts = toSdkOptions(opts);
  const fn = shouldElevate(opts) ? elevatedSave : items.save;
  return fn(collectionId, item, sdkOpts);
}

async function remove(collectionId, itemOrId, options) {
  const id = (itemOrId && typeof itemOrId === "object") ? itemOrId._id : itemOrId;
  const opts = options || {};
  const sdkOpts = toSdkOptions(opts);
  const fn = shouldElevate(opts) ? elevatedRemove : items.remove;
  return fn(collectionId, id, sdkOpts);
}

export { query, get, insert, update, save, remove };

const wixDataCompat = { query, get, insert, update, save, remove };
export default wixDataCompat;
