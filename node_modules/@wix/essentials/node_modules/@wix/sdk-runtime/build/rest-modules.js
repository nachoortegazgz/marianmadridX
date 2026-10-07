import { contextualizeRESTModuleV2 } from './context-v2.js';
export function createRESTModule(descriptor, elevated = false) {
    return contextualizeRESTModuleV2(descriptor, elevated);
}
export function toURLSearchParams(params, isComplexRequest) {
    const flatten = flattenParams(params);
    // payloads with deep arrays or complex arrays are not serializable as URLSearchParams
    const isPayloadNonSerializableAsUrlSearchParams = Object.entries(flatten).some(([key, value]) => key.includes('.') ||
        (Array.isArray(value) && value.some((v) => typeof v === 'object')));
    const shouldSerializeToRParam = isComplexRequest && isPayloadNonSerializableAsUrlSearchParams;
    if (shouldSerializeToRParam) {
        return new URLSearchParams({ '.r': base64Encode(JSON.stringify(params)) });
    }
    else {
        return Object.entries(flatten).reduce((urlSearchParams, [key, value]) => {
            // inorder to make `foo: [1,2]` turn into `foo=1&foo=2` and not `foo[]=1&foo[]=2`
            const keyParams = Array.isArray(value) ? value : [value];
            keyParams.forEach((param) => {
                if (param === undefined ||
                    param === null ||
                    (Array.isArray(value) && typeof param === 'object')) {
                    return;
                }
                urlSearchParams.append(key, param);
            });
            return urlSearchParams;
        }, new URLSearchParams());
    }
}
export function resolveUrl(opts) {
    const domain = resolveDomain(opts.host);
    const mappings = resolveMappingsByDomain(domain, opts.domainToMappings);
    const path = injectDataIntoProtoPath(opts.protoPath, opts.data || {});
    return resolvePathFromMappings(path, mappings);
}
function flattenParams(data, path = '') {
    const params = {};
    Object.entries(data).forEach(([key, value]) => {
        const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
        const fieldPath = resolvePath(path, key);
        if (isObject) {
            const serializedObject = flattenParams(value, fieldPath);
            Object.assign(params, serializedObject);
        }
        else {
            params[fieldPath] = value;
        }
    });
    return params;
}
function resolvePath(path, key) {
    return `${path}${path ? '.' : ''}${key}`;
}
const base64Encode = (value) => {
    const base64 = typeof btoa !== 'undefined'
        ? btoa(value)
        : Buffer.from(value, 'utf-8').toString('base64');
    return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};
const DOMAINS = ['wix.com', 'editorx.com'];
const USER_DOMAIN = '_';
const REGEX_CAPTURE_DOMAINS = new RegExp(`\\.(${DOMAINS.join('|')})$`);
const WIX_API_DOMAINS = ['42.wixprod.net', 'uw2-edt-1.wixprod.net'];
const DEV_WIX_CODE_DOMAIN = 'dev.wix-code.com';
const REGEX_CAPTURE_PROTO_FIELD = /{(.*)}/;
const REGEX_CAPTURE_API_DOMAINS = new RegExp(`\\.(${WIX_API_DOMAINS.join('|')})$`);
const REGEX_CAPTURE_DEV_WIX_CODE_DOMAIN = new RegExp(`.*\\.${DEV_WIX_CODE_DOMAIN}$`);
function resolveDomain(host) {
    const resolvedHost = fixHostExceptions(host);
    return resolvedHost
        .replace(REGEX_CAPTURE_DOMAINS, '._base_domain_')
        .replace(REGEX_CAPTURE_API_DOMAINS, '._api_base_domain_')
        .replace(REGEX_CAPTURE_DEV_WIX_CODE_DOMAIN, '*.dev.wix-code.com');
}
// hosts which standard string replacing doesn't apply to them, will be fixed here.
function fixHostExceptions(host) {
    // https://system-kb.wixanswers.com/kb/en/article/editorx-domains-matching-to-wixcom
    return host.replace('create.editorx.com', 'editor.editorx.com');
}
function resolveMappingsByDomain(domain, domainToMappings) {
    const mappings = domainToMappings[domain] || domainToMappings[USER_DOMAIN];
    if (!mappings) {
        if (isBaseDomain(domain)) {
            // fallback <lang>.wix.com sub domains to www.wix.com
            // since all of the languages subdomain are not mapped automatically in FP and we want to support those kind of calls
            // for example: fr.wix.com
            return domainToMappings[wwwBaseDomain];
        }
    }
    return mappings;
}
function isBaseDomain(domain) {
    return !!domain.match(/\._base_domain_$/);
}
const wwwBaseDomain = 'www._base_domain_';
function injectDataIntoProtoPath(protoPath, data) {
    return protoPath
        .split('/')
        .map((path) => maybeProtoPathToData(path, data))
        .join('/');
}
function maybeProtoPathToData(protoPath, data) {
    const protoRegExpMatch = protoPath.match(REGEX_CAPTURE_PROTO_FIELD) || [];
    const field = protoRegExpMatch[1];
    if (field) {
        const suffix = protoPath.replace(protoRegExpMatch[0], '');
        return findByPath(data, field, protoPath, suffix);
    }
    return protoPath;
}
function findByPath(obj, path, defaultValue, suffix) {
    let result = obj;
    for (const field of path.split('.')) {
        if (!result) {
            return defaultValue;
        }
        result = result[field];
    }
    return `${result}${suffix}`;
}
function resolvePathFromMappings(protoPath, mappings) {
    const mapping = mappings?.find((m) => protoPath.startsWith(m.destPath));
    if (!mapping) {
        // todo: should we return the path? if no - what should we do in case of testings?
        return protoPath;
    }
    return mapping.srcPath + protoPath.slice(mapping.destPath.length);
}
