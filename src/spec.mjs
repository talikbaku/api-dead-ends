// @ts-check
// Load OpenAPI 3.x / Swagger 2.0 (parsed from JSON or YAML, see yaml.mjs). Operations with regexes for matching.

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/**
 * @typedef {{ method: string, path: string, deprecated: boolean, operationId?: string, re: RegExp, params: number, literals: number }} Operation
 */

/**
 * @param {any} spec
 * @returns {{ title: string, version: string, base: string, ops: Operation[] }}
 */
export function loadSpec(spec) {
  if (!spec || typeof spec !== 'object' || !spec.paths) throw new Error('Spec has no "paths" (need OpenAPI 3.x or Swagger 2.0 as JSON or YAML; or build one with: api-dead-ends spec from-routes <file>)');
  const base = basePrefix(spec);
  /** @type {Operation[]} */
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    if (!item || typeof item !== 'object') continue;
    // `x-ade-any-method`: route lists without methods (Django, plain path lists) match any method.
    const methods = item['x-ade-any-method'] ? [...METHODS.filter((m) => item[m]), 'any'] : METHODS;
    for (const m of methods) {
      const op = m === 'any' ? item['x-ade-any-method'] : item[m];
      if (!op) continue;
      const segs = p.split('/').filter(Boolean);
      const params = segs.filter(isParam).length;
      ops.push({
        method: m === 'any' ? 'ANY' : m.toUpperCase(),
        path: p,
        deprecated: !!(op && op.deprecated),
        operationId: typeof op.operationId === 'string' ? op.operationId.slice(0, 200) : undefined,
        re: buildRegex(base, segs),
        params,
        literals: segs.length - params,
      });
    }
  }
  return { title: String(spec.info?.title ?? '') || 'API', version: String(spec.info?.version ?? ''), base, ops };
}

/** @param {string} s */
function isParam(s) {
  return /\{[^}]+\}/.test(s);
}

/**
 * Path prefix: Swagger 2 basePath or the path of the first servers[].url (OpenAPI 3).
 * @param {any} spec
 */
export function basePrefix(spec) {
  let b = '';
  if (typeof spec.basePath === 'string') b = spec.basePath;
  else if (Array.isArray(spec.servers) && spec.servers[0]?.url) {
    const u = String(spec.servers[0].url).replace(/\{[^}]+\}/g, 'x');
    try {
      b = new URL(u, 'http://x').pathname;
    } catch {
      b = '';
    }
  }
  b = b.replace(/\/+$/, '');
  return b === '/' ? '' : b;
}

/**
 * The prefix is optional: traffic behind a gateway often comes both with and without it.
 * @param {string} base
 * @param {string[]} segs
 */
function buildRegex(base, segs) {
  const body = segs
    // One parameter per segment → [^/]+; several ({a}{b}, {name}.{ext}) → the whole segment is [^/]+ (no backtracking blow-up).
    .map((s) => (/^\{\w+\*\}$/.test(s) ? '.+' // catch-all {slug*} (Next.js [...slug]) spans several segments
      : isParam(s) ? ((s.match(/\{[^}]+\}/g) || []).length === 1 ? s.split(/\{[^}]+\}/).map(esc).join('[^/]+') : '[^/]+') : esc(s)))
    .join('/');
  const pre = base ? `(?:${esc(base)})?` : '';
  if (!body) return new RegExp(`^${pre}/?$`); // spec path "/" also matches the bare base path
  return new RegExp(`^${pre}/${body}/?$`);
}

/** @param {string} s */
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best operation for method+path: a literal beats a parameter.
 * @param {Operation[]} ops
 * @param {string} method
 * @param {string} path
 */
export function matchOp(ops, method, path) {
  const c = ops.filter((o) => o.re.test(path) && (method === 'ANY' || o.method === method || o.method === 'ANY'));
  c.sort((a, b) => a.params - b.params || b.literals - a.literals || (a.method === 'ANY' ? 1 : 0) - (b.method === 'ANY' ? 1 : 0));
  return c[0] || null;
}

/**
 * @param {Operation[]} ops
 * @param {string} path
 */
export function pathKnown(ops, path) {
  return ops.some((o) => o.re.test(path));
}

/**
 * Literal spec segments that templating must not fold (e.g. oauth2, 2024).
 * Only those that templating would otherwise take for an ID.
 * @param {{ ops: Operation[], base: string }} spec
 * @param {(seg: string) => boolean} isId
 */
export function literalSegments(spec, isId) {
  const out = new Set();
  for (const p of [spec.base, ...spec.ops.map((o) => o.path)]) {
    for (const seg of p.split('/')) if (seg && !/\{[^}]+\}/.test(seg) && isId(seg)) out.add(seg);
  }
  return out;
}
