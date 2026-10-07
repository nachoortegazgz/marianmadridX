/*
=============================================================================
MODULE: backend/tests/loader.mjs
PURPOSE: Offline test harness. Registers ESM loader hooks that mock every
"wix-*" module and map "backend/<name>" specifiers to src/backend/<name>.js,
so the real backend code can be imported and exercised with `node --test`
without a Wix Velo runtime and without node_modules.
SCOPE: tests only. Never imported by production code. G10 ASCII strict.
=============================================================================
*/

import { pathToFileURL } from 'node:url';
import { fileURLToPath, pathToFileURL as p2u } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/backend/tests -> src/backend
export const BACKEND_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mock registry (mutable so tests can seed data / inspect calls)
// ---------------------------------------------------------------------------

export const wixDataMock = {
  _store: new Map(),          // collectionName -> array of items
  _calls: [],                 // audit trail of operations
  _seed(collection, items) {
    // JSON round-trip would serialize Date instances to ISO strings and
    // break date comparisons in queries (.lt/_createdDate). Revive ISO
    // strings back into Date objects so seeded rows match live Velo types.
    const revived = JSON.parse(JSON.stringify(items), (key, value) => {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? value : d;
      }
      return value;
    });
    this._store.set(collection, revived);
  },
  _reset() {
    this._store.clear();
    this._calls.length = 0;
  },
  query(collection) {
    const rows = () => this._store.get(collection) || [];
    const state = { filters: [], limitN: 30, offsetN: 0 };
    const cmpValue = (v) => (v instanceof Date ? v.getTime() : v);
    // Real Velo semantics: filter methods (eq/in/lt...) return the same
    // WixDataQuery, so .eq(...).limit(1).count() chains legally. The mock
    // mirrors that by returning `q` from every builder method.
    const q = {};
    q.eq = (field, value) => { state.filters.push([field, value]); return q; };
    q.in = (field, values) => { state.filters.push([field, values]); return q; };
    q.ne = (field, value) => { state.filters.push(['!=', field, value]); return q; };
    q.lt = (field, value) => { state.filters.push(['<', field, value]); return q; };
    q.gt = (field, value) => { state.filters.push(['>', field, value]); return q; };
    q.le = (field, value) => { state.filters.push(['<=', field, value]); return q; };
    q.ge = (field, value) => { state.filters.push(['>=', field, value]); return q; };
    q.between = (field, low, high) => { state.filters.push(['range', field, low, high]); return q; };
    q.contains = (field, value) => { state.filters.push(['has', field, value]); return q; };
    q.hasSome = (field, values) => { state.filters.push(['some', field, values]); return q; };
    q.ascending = () => q;
    q.descending = () => q;
    q.limit = (n) => { state.limitN = n; return q; };
    q.start = (n) => { state.offsetN = n; return q; };
    const applyFilters = () => {
      let items = rows().slice();
      for (const f of state.filters) {
        if (f[0] === '!=') { items = items.filter((it) => it[f[1]] !== f[2]); }
        else if (f[0] === '<') { items = items.filter((it) => cmpValue(it[f[1]]) < cmpValue(f[2])); }
        else if (f[0] === '>') { items = items.filter((it) => cmpValue(it[f[1]]) > cmpValue(f[2])); }
        else if (f[0] === '<=') { items = items.filter((it) => cmpValue(it[f[1]]) <= cmpValue(f[2])); }
        else if (f[0] === '>=') { items = items.filter((it) => cmpValue(it[f[1]]) >= cmpValue(f[2])); }
        else if (f[0] === 'range') { items = items.filter((it) => cmpValue(it[f[1]]) >= cmpValue(f[2]) && cmpValue(it[f[1]]) <= cmpValue(f[3])); }
        else if (f[0] === 'has') { items = items.filter((it) => Array.isArray(it[f[1]]) && it[f[1]].includes(f[2])); }
        else if (f[0] === 'some') { items = items.filter((it) => Array.isArray(it[f[1]]) && it[f[1]].some((v) => f[2].includes(v))); }
        else if (Array.isArray(f[1])) { items = items.filter((it) => f[1].includes(it[f[0]])); }
        else { items = items.filter((it) => it[f[0]] === f[1]); }
      }
      return items;
    };
    q.count = async () => {
      this._calls.push({ op: 'query', collection });
      return applyFilters().length;
    };
    // SDK v2 cursor contract (T7c): find() also exposes totalCount,
    // hasNext() and next() so migrated modules (fiscalAggregator, cajas,
    // staff) keep working offline against the same in-memory store.
    q.find = async () => {
      this._calls.push({ op: 'query', collection });
      const all = applyFilters();
      const items = all.slice(state.offsetN, state.offsetN + state.limitN);
      const result = {
        items,
        total: items.length,
        totalCount: all.length,
        hasNext: () => false,
        next: async () => result,
      };
      return result;
    };
    return q;
  },
  get: async (collection, id) => {
    wixDataMock._calls.push({ op: 'get', collection });
    const rows = wixDataMock._store.get(collection) || [];
    return rows.find((r) => r._id === id) || null;
  },
  insert: async (collection, item) => {
    wixDataMock._calls.push({ op: 'insert', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const saved = { _id: 'mock_' + (rows.length + 1), ...item };
    rows.push(saved);
    wixDataMock._store.set(collection, rows);
    return saved;
  },
  update: async (collection, item) => {
    wixDataMock._calls.push({ op: 'update', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const idx = rows.findIndex((r) => r._id === item._id);
    if (idx >= 0) rows[idx] = item; else rows.push(item);
    return item;
  },
  remove: async (collection, item) => {
    wixDataMock._calls.push({ op: 'remove', collection });
    // Real Velo semantics: remove() deletes the row (accepts _id or object).
    // Purge crons (cleanAuditLogs et al.) assert against store state after
    // running, so the mock must actually mutate it.
    const id = (item && typeof item === 'object') ? item._id : item;
    const rows = wixDataMock._store.get(collection) || [];
    wixDataMock._store.set(collection, rows.filter((r) => r._id !== id));
    return item;
  },
};

export const mocks = {
  wixData: wixDataMock,
  logger: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    _calls: [],
  },
};

const GENERIC_STUB_SOURCE = `
const fnProxy = new Proxy(function () {}, {
  get: (t, p) => {
    if (p === 'then') return undefined;
    return fnProxy;
  },
  apply: () => fnProxy,
});
export const webMethod = (...args) => {
  // Real Velo semantics: webMethod(perm..., handler) returns the handler
  // (optionally wrapped). Tests call the exported handlers directly, so the
  // last function argument must be returned as-is.
  const fns = args.filter((a) => typeof a === 'function');
  return fns.length ? fns[fns.length - 1] : (handlerFn) => handlerFn;
};
export const Permissions = { Admin: 'ADMIN', SiteMember: 'MEMBER', Public: 'PUBLIC', Anyone: 'ANYONE' };
export const currentMember = fnProxy;
export const locations = fnProxy;
export const bookingsBackend = fnProxy;
export const paymentsBackend = fnProxy;
export const transactions = fnProxy;
export const media = fnProxy;
export const crypto = fnProxy;
// Named SDK exports imported by backend code (offline stubs):
export const availabilityTimeSlots = fnProxy;
export const bookings = fnProxy;
export const checkout = fnProxy;
export const orders = fnProxy;
export const elevate = fnProxy;
export const createClient = () => fnProxy;
export const getSecret = async () => "mock-secret";
export function _namedExportFallback(name) { return fnProxy; }
const handler = { get: (t, p) => {
  if (p === 'then') return undefined;
  if (p === 'webMethod') return webMethod;
  if (p === 'Permissions') return Permissions;
  if (p === 'default') return fnProxy;
  if (!(p in t)) { t[p] = fnProxy; }
  return t[p];
} };
const mod = new Proxy({ default: fnProxy }, handler);
export default mod.default;
`;

const WIX_DATA_SOURCE = `
import { wixDataMock } from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'tests/loader.mjs')).href.replace(/\\/g, '/'))};
export default wixDataMock;
`;

// T7a: dedicated mock for the SDK v2 package "@wix/data". The migrated DAL
// (backend/dataClient.js) imports the named "items" namespace from it; every
// operation delegates to the SAME wixDataMock so offline tests exercise the
// real DAL translation layer with identical store semantics (D4).
const WIXDATASDK_SOURCE = `
import { wixDataMock } from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'tests/loader.mjs')).href.replace(/\\/g, '/'))};
const items = {
  query: async (req, opts) => {
    const collection = req && req.dataCollectionId;
    const q = wixDataMock.query(collection);
    const querySpec = (req && req.query) || {};
    const filter = querySpec.filter;
    if (typeof filter === 'string' && filter.trim()) {
      // Parse the WQL string produced by dataClient (AND-joined simple
      // predicates: field <op> literal, "field in [..]", "(f = a OR f = b)").
      const clauses = splitTopLevelAnd(filter);
      for (const clause of clauses) {
        let m;
        if ((m = clause.match(/^\\s*([\\w.]+)\\s+in\\s+\\[(.*)\\]\\s*$/i))) {
          q.in(unescapeField(m[1]), parseLitList(m[2]));
        } else if ((m = clause.match(/^\\s*\\((.*)\\)\\s*$/))) {
          // hasSome(...) is emitted as an OR-group of equalities on one field
          const orParts = m[1].split(/\\s+OR\\s+/);
          const field = unescapeField(orParts[0].split('=')[0].trim());
          q.hasSome(field, orParts.map((p) => parseLit(p.split('=').slice(1).join('=').trim())));
        } else if ((m = clause.match(/^\\s*([\\w.]+)\\s*(<=|>=|!=|<|>|=)\\s*(.+?)\\s*$/))) {
          const field = unescapeField(m[1]);
          const op = m[2];
          const value = parseLit(m[3]);
          if (op === '=') q.eq(field, value);
          else if (op === '!=') q.ne(field, value);
          else if (op === '<') q.lt(field, value);
          else if (op === '>') q.gt(field, value);
          else if (op === '<=') q.le(field, value);
          else if (op === '>=') q.ge(field, value);
        }
      }
    }
    const sort = querySpec.sort;
    if (Array.isArray(sort)) {
      for (const s of sort) {
        for (const [field, dir] of Object.entries(s)) {
          if (String(dir).toUpperCase() === 'DESC') q.descending(field);
          else q.ascending(field);
        }
      }
    }
    const paging = querySpec.paging || {};
    if (paging.offset != null) q.start(paging.offset);
    if (paging.limit != null) q.limit(paging.limit);
    const res = await q.find(opts);
    return { items: res.items, pagingMetadata: { totalCount: res.totalCount, itemCount: res.items.length } };
  },
  get: async (id, opts) => wixDataMock.get(opts && opts.dataCollectionId, id),
  insert: async (item, opts) => wixDataMock.insert(opts && opts.dataCollectionId, item),
  update: async (item, opts) => wixDataMock.update(opts && opts.dataCollectionId, item),
  save: async (item, opts) => {
    const collection = opts && opts.dataCollectionId;
    const rows = wixDataMock._store.get(collection) || [];
    const exists = item && item._id && rows.some((r) => r._id === item._id);
    return exists
      ? wixDataMock.update(collection, item)
      : wixDataMock.insert(collection, item);
  },
  remove: async (idOrItem, opts) => wixDataMock.remove(opts && opts.dataCollectionId, idOrItem),
};
function unescapeField(f) {
  return f === 'dataItemField._id' ? '_id' : f;
}
function splitTopLevelAnd(str) {
  const out = [];
  let depth = 0;
  let cur = '';
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') inStr = !inStr;
    if (!inStr && ch === '(') depth++;
    if (!inStr && ch === ')') depth--;
    if (!inStr && depth === 0 && str.slice(i, i + 5) === ' AND ') {
      out.push(cur);
      cur = '';
      i += 4;
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function parseLit(raw) {
  const t = raw.trim();
  if (/^".*"$/.test(t)) {
    const inner = t.slice(1, -1);
    if (/^\\d{4}-\\d{2}-\\d{2}T.*Z$/.test(inner)) return new Date(inner);
    return inner;
  }
  if (/^-?\\d+(\\.\\d+)?$/.test(t)) return Number(t);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === 'null') return null;
  return t;
}
function parseLitList(raw) {
  return raw.split(',').map(parseLit);
}
export { items };
export default { items };
`;

// ---------------------------------------------------------------------------
// resolve/load hooks (used when run WITH --experimental-loader)
// ---------------------------------------------------------------------------

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('wix-') || specifier.startsWith('@wix/')) {
    // Offline harness: every Wix SDK package resolves to the generic stub.
    // wix-data keeps its dedicated in-memory mock below.
    return { url: 'mock:' + specifier, shortCircuit: true };
  }
  if (specifier.startsWith('backend/') || specifier.startsWith('public/')) {
    const rel = specifier.includes('/') ? specifier.slice(specifier.indexOf('/') + 1) : specifier;
    const rootDir = specifier.startsWith('public/') ? path.join(BACKEND_DIR, '..', 'public') : BACKEND_DIR;
    const abs = path.join(rootDir, rel.endsWith('.js') ? rel : rel + '.js');
    if (!fs.existsSync(abs)) {
      throw new Error('loader.mjs: cannot resolve Velo alias specifier ' + specifier + ' -> ' + abs);
    }
    return { url: pathToFileURL(abs).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'mock:@wix/data') {
    // Exact-match branch MUST precede the generic mock: branch so the SDK v2
    // data package gets its dedicated delegating mock (T7b).
    return { format: 'module', source: WIXDATASDK_SOURCE, shortCircuit: true };
  }
  if (url.startsWith('mock:wix-data')) {
    return { format: 'module', source: WIX_DATA_SOURCE, shortCircuit: true };
  }
  if (url.startsWith('mock:')) {
    return { format: 'module', source: GENERIC_STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
