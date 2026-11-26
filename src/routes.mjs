// @ts-check
// Build a minimal OpenAPI document from a route list printed by the framework itself.
// Works for any language: we parse the framework's own output, not the source code.
//
// Recognised inputs (auto-detected, mixed is fine):
//   Rails      `rails routes`                       "user GET  /users/:id(.:format)  users#show"
//   Gin        debug output                          "[GIN-debug] GET  /users/:id  --> main.getUser (3 handlers)"
//   Echo/Gin/Fiber JSON  [{ "method": "GET", "path": "/users/:id" }]
//   express-list-endpoints JSON  [{ "path": "/users/:id", "methods": ["GET"] }]
//   Spring Boot `/actuator/mappings` JSON            "{GET [/users/{id}]}"
//   Flask      `app.url_map`                         "<Rule '/users/<int:id>' (GET, HEAD, OPTIONS) -> user>"
//   Django     `manage.py show_urls`                 "/users/<int:pk>/\tapp.views.UserDetail\tuser-detail"
//   Laravel    `php artisan route:list --json`       [{ "method": "GET|HEAD", "uri": "users/{id}" }]
//   Plain text "GET /users/{id}" or just "/users/{id}" (any method)

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'];

/**
 * Normalise framework path syntax to OpenAPI `{param}`.
 * `:id`, `*splat`, `<int:id>`, `<id>`, `{id:\d+}`, `(.:format)`, `{id?}` → `{id}`.
 * @param {string} p
 */
export function toOpenApiPath(p) {
  let s = String(p).trim().slice(0, 500);
  s = s.replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}'); // Django regex groups (?P<pk>[0-9]+)
  s = s.replace(/\(\.:format\)/g, '').replace(/\([^)]*\)/g, ''); // Rails optional groups
  s = s.replace(/^\^/, '').replace(/\$$/, ''); // Django regex anchors
  if (!s.startsWith('/')) s = '/' + s;
  s = s
    .split('/')
    .map((seg) => {
      let m;
      if ((m = seg.match(/^:(\w+)\??$/))) return `{${m[1]}}`;
      if ((m = seg.match(/^\[\[?(?:\.\.\.)?(\w+)\]?\]$/))) return `{${m[1]}}`; // Next.js [id], [...slug], [[...slug]]
      if ((m = seg.match(/^\*(\w*)$/))) return `{${m[1] || 'path'}}`;
      if ((m = seg.match(/^<(?:\w+:)?(\w+)>$/))) return `{${m[1]}}`;
      if ((m = seg.match(/^\{(\w+)(?::[^}]*)?\??\}$/))) return `{${m[1]}}`;
      if ((m = seg.match(/^\(\?P<(\w+)>[^)]*\)$/))) return `{${m[1]}}`;
      return seg;
    })
    .join('/');
  s = s.replace(/\/{2,}/g, '/');
  return s.length > 1 ? s.replace(/\/$/, '') : s;
}

/**
 * @param {string} text
 * @returns {Array<{ method: string, path: string }>}
 */
export function parseRoutes(text) {
  const t = String(text).trim();
  /** @type {Array<{ method: string, path: string }>} */
  const out = [];
  const add = (/** @type {string} */ method, /** @type {string} */ path) => {
    if (!path || !/^[/\w^<{:*]/.test(path)) return;
    const m = String(method || 'ANY').toUpperCase();
    for (const one of m.split(/[|,\s]+/).filter(Boolean)) {
      if (one === 'HEAD' && m.includes('GET')) continue; // GET|HEAD → GET
      out.push({ method: METHODS.includes(one) ? one : 'ANY', path: toOpenApiPath(path) });
    }
  };

  if (t.startsWith('{') || t.startsWith('[')) {
    let json;
    try { json = JSON.parse(t); } catch { json = undefined; }
    if (json !== undefined) { walkJson(json, add); return dedupe(out); }
  }
  for (const raw of t.split(/\r?\n/)) {
    if (raw.length > 2000) continue; // no real route line is this long; keeps the regexes linear in practice
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m;
    // Flask url_map: <Rule '/x/<int:id>' (GET, HEAD, OPTIONS) -> endpoint>
    if ((m = line.match(/<Rule '([^']+)' \(([^)]*)\)/))) {
      const ms = m[2].split(',').map((x) => x.trim()).filter((x) => x !== 'HEAD' && x !== 'OPTIONS');
      for (const x of ms.length ? ms : ['ANY']) add(x, m[1]);
      continue;
    }
    // Gin debug: [GIN-debug] GET /x --> handler
    if ((m = line.match(/\[GIN(?:-debug)?\]\s+(\w+)\s+(\S+)\s+-->/))) { add(m[1], m[2]); continue; }
    // Rails / plain "METHOD /path" anywhere in the line
    if ((m = line.match(/\b((?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|ANY)(?:\s*[|,]\s*(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD))*)\s+(\/\S*)/))) {
      const ms = m[1].split(/[|,]/).map((x) => x.trim()).filter((x) => x !== 'OPTIONS' && !(x === 'HEAD' && /GET/.test(m[1])));
      for (const x of ms) add(x, m[2]);
      continue;
    }
    // Django show_urls: "/path/<int:pk>/\tview\tname" — no method known
    if ((m = line.match(/^(\^?\/?[\w^][^\s]*\/?)(\s|$)/)) && /\//.test(m[1])) { add('ANY', m[1]); continue; }
  }
  return dedupe(out);
}

/**
 * @param {any} j
 * @param {(m: string, p: string) => void} add
 */
function walkJson(j, add) {
  if (Array.isArray(j)) { for (const x of j) walkJson(x, add); return; }
  if (!j || typeof j !== 'object') return;
  // express-list-endpoints
  if (typeof j.path === 'string' && Array.isArray(j.methods)) { for (const m of j.methods) add(m, j.path); return; }
  // Echo / Gin / Fiber / generic
  if (typeof j.path === 'string' && typeof j.method === 'string') { add(j.method, j.path); return; }
  // Laravel route:list --json
  if (typeof j.uri === 'string' && typeof j.method === 'string') { add(j.method, j.uri); return; }
  // Spring Boot actuator mappings: "predicate": "{GET [/users/{id}], produces [...]}"
  if (typeof j.predicate === 'string') {
    const m = j.predicate.match(/^\{\s*(?:([A-Z][A-Z|, ]*?)\s+)?\[([^\]]+)\]/);
    if (m) for (const p of m[2].split(',').map((x) => x.trim())) for (const meth of (m[1] || 'ANY').split(/[|, ]+/).filter(Boolean)) add(meth, p);
    const d = j.details?.requestMappingConditions;
    if (!m && d?.patterns) for (const p of d.patterns) for (const meth of d.methods?.length ? d.methods : ['ANY']) add(meth, p);
    return;
  }
  for (const v of Object.values(j)) if (v && typeof v === 'object') walkJson(v, add);
}

/** @param {Array<{ method: string, path: string }>} rs */
function dedupe(rs) {
  const seen = new Set();
  return rs.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * @param {Array<{ method: string, path: string }>} routes
 * @param {{ title?: string }} [opt]
 */
export function routesToOpenApi(routes, opt = {}) {
  /** @type {Record<string, any>} */
  const paths = {};
  for (const r of routes) {
    const item = (paths[r.path] ||= {});
    const op = { responses: { default: { description: 'from route list' } } };
    if (r.method === 'ANY') item['x-ade-any-method'] = op;
    else item[r.method.toLowerCase()] = op;
  }
  return {
    openapi: '3.0.3',
    info: { title: opt.title || 'Routes (generated by api-dead-ends)', version: '0', 'x-ade-generated': 'spec from-routes' },
    paths,
  };
}

/**
 * Next.js route inventory from the file tree (no build, no runtime):
 *   app/**\/route.{js,ts,…}  → methods from `export function GET` / `export const POST = …`
 *   pages/api/**            → one handler for every method (ANY)
 * Route groups `(group)`, parallel slots `@slot` and private `_folders` are skipped; `[id]`, `[...slug]`, `[[...slug]]` → `{id}`, `{slug}`.
 * @param {string} dir  the Next.js project folder (contains app/ or src/app/, pages/ or src/pages/)
 */
export async function scanNext(dir) {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  /** @type {Array<{ method: string, path: string }>} */
  const out = [];
  const seg = (/** @type {string} */ s) => {
    let m;
    if ((m = s.match(/^\[\[?\.\.\.(\w+)\]?\]$/))) return `{${m[1]}*}`; // catch-all: one or more segments
    if ((m = s.match(/^\[(\w+)\]$/))) return `{${m[1]}}`;
    return s;
  };
  /** @param {string} base @param {string[]} parts @param {'app'|'pages'} kind */
  async function walk(base, parts, kind) {
    let entries = [];
    try { entries = await readdir(join(base, ...parts), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        await walk(base, [...parts, e.name], kind);
        continue;
      }
      const urlParts = parts.filter((p) => !/^\(.*\)$/.test(p) && !p.startsWith('@') && !p.startsWith('_') && !/^\(\.+\)/.test(p)).map(seg);
      if (kind === 'app' && /^route\.(js|ts|jsx|tsx|mjs|cjs)$/.test(e.name)) {
        const text = await readFile(join(base, ...parts, e.name), 'utf8').catch(() => '');
        const methods = [...text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
        const optional = parts.some((p) => /^\[\[\.\.\./.test(p)); // [[...slug]] also matches the bare base path
        for (const m of new Set(methods.length ? methods : ['ANY'])) {
          out.push({ method: m, path: '/' + urlParts.join('/') });
          if (optional) out.push({ method: m, path: '/' + urlParts.filter((x) => !/\*\}$/.test(x)).join('/') });
        }
      }
      if (kind === 'pages' && /\.(js|ts|jsx|tsx|mjs|cjs)$/.test(e.name) && !e.name.startsWith('_')) {
        const name = e.name.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '');
        out.push({ method: 'ANY', path: '/api/' + [...urlParts, ...(name === 'index' ? [] : [seg(name)])].join('/') });
      }
    }
  }
  for (const root of ['app', 'src/app']) await walk(join(dir, root), [], 'app');
  for (const root of ['pages/api', 'src/pages/api']) await walk(join(dir, root), [], 'pages');
  // pages/api paths start at /api
  return dedupe(out.map((r) => ({ method: r.method, path: r.path.replace(/\/+$/, '') || '/' })));
}
