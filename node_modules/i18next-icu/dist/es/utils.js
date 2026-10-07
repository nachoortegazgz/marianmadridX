// Keys that must never be traversed when walking a string/array path into an
// object, otherwise a crafted path such as `__proto__.polluted` walks straight
// into Object.prototype. Mirrors the guard shipped to the same setPath/pushPath
// walker in i18next-fs-backend 2.6.6 and i18next-http-middleware 3.9.7.
var UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
function getLastOfPath(object, path, Empty) {
  function cleanKey(key) {
    return key && key.indexOf('###') > -1 ? key.replace(/###/g, '.') : key;
  }
  function canNotTraverseDeeper() {
    return !object || typeof object === 'string';
  }
  var stack = typeof path !== 'string' ? [].concat(path) : path.split('.');
  while (stack.length > 1) {
    if (canNotTraverseDeeper()) return {};
    var key = cleanKey(stack.shift());
    if (UNSAFE_KEYS.indexOf(key) > -1) return {};
    if (!object[key] && Empty) object[key] = new Empty();
    object = object[key];
  }
  if (canNotTraverseDeeper()) return {};
  var k = cleanKey(stack.shift());
  if (UNSAFE_KEYS.indexOf(k) > -1) return {};
  return {
    obj: object,
    k: k
  };
}
export function setPath(object, path, newValue) {
  var _getLastOfPath = getLastOfPath(object, path, Object),
    obj = _getLastOfPath.obj,
    k = _getLastOfPath.k;
  if (obj === undefined) return; // unsafe path, drop silently

  obj[k] = newValue;
}
export function pushPath(object, path, newValue, concat) {
  var _getLastOfPath2 = getLastOfPath(object, path, Object),
    obj = _getLastOfPath2.obj,
    k = _getLastOfPath2.k;
  if (obj === undefined) return; // unsafe path, drop silently

  obj[k] = obj[k] || [];
  if (concat) obj[k] = obj[k].concat(newValue);
  if (!concat) obj[k].push(newValue);
}
export function getPath(object, path) {
  var _getLastOfPath3 = getLastOfPath(object, path),
    obj = _getLastOfPath3.obj,
    k = _getLastOfPath3.k;
  if (!obj) return undefined;
  return obj[k];
}
var arr = [];
var each = arr.forEach;
var slice = arr.slice;
export function defaults(obj) {
  each.call(slice.call(arguments, 1), function (source) {
    if (source) {
      // iterate own keys only (skip inherited/polluted props) and refuse to
      // copy prototype keys, so a polluted source can't seed Object.prototype.
      for (var _i = 0, _Object$keys = Object.keys(source); _i < _Object$keys.length; _i++) {
        var prop = _Object$keys[_i];
        if (UNSAFE_KEYS.indexOf(prop) > -1) continue;
        if (obj[prop] === undefined) obj[prop] = source[prop];
      }
    }
  });
  return obj;
}
export function extend(obj) {
  each.call(slice.call(arguments, 1), function (source) {
    if (source) {
      for (var _i2 = 0, _Object$keys2 = Object.keys(source); _i2 < _Object$keys2.length; _i2++) {
        var prop = _Object$keys2[_i2];
        if (UNSAFE_KEYS.indexOf(prop) > -1) continue;
        obj[prop] = source[prop];
      }
    }
  });
  return obj;
}