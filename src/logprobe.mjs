// @ts-check
// `logging-probe`: active "Not logged" check against a STAGING environment, in two steps so it works with any log source.
// (Not to be confused with `logging-check`, the static scan of code and config.)
//   send   — one safe request per spec operation, each tagged with a unique marker (header, User-Agent, query string);
//            a run manifest records operation → marker, status and latency. No response bodies are read or stored.
//   verify — the user exports the logs for the run's window from wherever they live; the raw text is scanned for the
//            markers. Found → logged; reached but not found → NOT logged (or "answered by gateway/auth" for
//            401/403/404/3xx); request failed → not reached; no marker found at all → unknown (check the export).
// Safety: GET/HEAD only by default; other methods only with two explicit flags and then only a deliberately invalid
// request ({} as JSON); rate-limited, per-request timeout, operation cap, redirects never followed, http(s) only,
// every URL must stay on the target origin. Extra headers (auth) are sent but their values are never stored or printed.
// CLI only — never exposed as an MCP tool (it sends network requests).

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { basename } from 'node:path';
import { request as httpReq } from 'node:http';
import { request as httpsReq } from 'node:https';

export const MANIFEST_KIND = 'api-dead-ends/logging-probe-run';
const SAFE = new Set(['GET', 'HEAD']);
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PLACEHOLDER = 'ade-probe';
const PAD = 4; // marker numbers are zero-padded: ade-<run>-0001 is never a prefix of another marker of the run
const RUN_RE = /^[a-z0-9]{6,16}$/;
/** Headers the probe sets itself or that the HTTP client owns: --header may not replace them. */
const RESERVED_HEADERS = new Set(['x-ade-probe', 'user-agent', 'host', 'content-length', 'content-type', 'transfer-encoding', 'connection', 'accept']);

/** Text from the spec or the command line, safe to print to a terminal (no escape sequences). @param {unknown} s */
export const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');

/** @param {string} run @param {number} n */
export const markerOf = (run, n) => `ade-${run}-${String(n).padStart(PAD, '0')}`;

/** A new random run id. */
export const newRunId = () => randomBytes(4).toString('hex');

/**
 * Check the target URL: http(s) only, no credentials; returns the normalised base (origin + path, no query).
 * @param {string} url
 */
export function checkTarget(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`not a valid URL: ${clean(String(url).slice(0, 80))}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('logging-probe: only http(s) URLs');
  if (u.username || u.password) throw new Error('logging-probe: no credentials in the URL (they would end up in logs and in the run manifest; use --header)');
  return { origin: u.origin, path: u.pathname.replace(/\/+$/, '') };
}

/** IPv4 dotted quad → its four numbers, or null. @param {string} h */
function ipv4(h) {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return m ? m.slice(1).map(Number) : null;
}

/** "[::ffff:a00:1]" (URL hostnames of IPv6 literals) → eight 16-bit groups, or null. @param {string} h */
function ipv6(h) {
  if (!/^\[[0-9a-f:.]+\]$/.test(h)) return null;
  let s = h.slice(1, -1);
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/); // URL normalises these to hex, but accept both
  if (v4) { const q = ipv4(v4[1]); if (!q) return null; s = s.slice(0, -v4[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16); }
  const [l, r] = s.split('::');
  const a = l ? l.split(':') : [], b = r !== undefined && r ? r.split(':') : [];
  if (s.split('::').length > 2) return null;
  const fill = s.includes('::') ? 8 - a.length - b.length : 0;
  const g = [...a, ...Array(Math.max(fill, 0)).fill('0'), ...b].map((x) => parseInt(x, 16));
  return g.length === 8 && g.every((x) => x >= 0 && x <= 0xffff) ? g : null;
}

/**
 * Kind of an IP address host: 'loopback' (127/8, ::1), 'private' (10/8, 172.16/12, 192.168/16, 169.254/16,
 * 100.64/10, IPv6 ULA fc00::/7 and link-local fe80::/10; IPv4-mapped ::ffff:a.b.c.d like its IPv4 address),
 * 'public' for any other IP, null when the host is a name. @param {string} h URL hostname, lower case
 */
export function ipKind(h) {
  let q = ipv4(h);
  if (!q) {
    const g = ipv6(h);
    if (!g) return null;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) q = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    else return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 ? 'private' : 'public';
  }
  const [a, b] = q;
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

/** Is this URL hostname this machine (localhost, *.localhost, 127/8, ::1, ::ffff:127.x)? Exact, never a prefix. @param {string} hostname */
export function isLoopbackHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || ipKind(h) === 'loopback';
}

// Staging words in a host name. STRONG ones count as any hyphen part of a label (staging-api, api-stg-2);
// WEAK ones are ordinary words (dev-null, test-results, local-news), so they count only as a whole label,
// optionally with a number (dev, qa2, test-3).
const STRONG = /^(stag|stage|staging|stg|uat|sandbox)\d*$/;
const WEAK = /^(dev|test|testing|qa|local)(-?\d+)?$/;
// Second-level public suffixes under a two-letter country TLD (shop.co.uk: the registrable domain is 3 labels).
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or', 'go', 'gv', 'mil', 'nic', 'ltd', 'plc']);

/**
 * How the target host looks: 'loopback' (this machine), 'staging' (a staging name), 'private' (a private-range
 * IP: may be production in a data centre), 'other'. A heuristic only. A name with "prod" in any label never counts.
 * Only labels left of the registrable domain are read (dev.to, test.com, api.myshop.dev are not staging);
 * the reserved TLDs .test and .local count, .localhost is loopback.
 * @param {string} origin
 * @returns {'loopback' | 'staging' | 'private' | 'other'}
 */
export function hostClass(origin) {
  const h = new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
  const ip = ipKind(h);
  if (ip) return ip === 'loopback' ? 'loopback' : ip === 'private' ? 'private' : 'other';
  const labels = h.split('.');
  if (labels.some((l) => l.includes('prod'))) return 'other';
  if (isLoopbackHost(h)) return 'loopback';
  const tld = labels[labels.length - 1];
  if (labels.length > 1 && (tld === 'test' || tld === 'local')) return 'staging';
  const reg = labels.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(labels[labels.length - 2]) ? 3 : 2;
  // A single-label host (docker-compose service `api-staging`, `staging`) is all "subdomain".
  const sub = labels.length === 1 ? labels : labels.slice(0, Math.max(labels.length - reg, 0));
  const hit = sub.some((l) => WEAK.test(l) || l.split('-').some((part) => STRONG.test(part)));
  return hit ? 'staging' : 'other';
}

/**
 * Does the host look like staging/test (or this machine)? Private IPs do not: see stagingGate.
 * @param {string} origin
 */
export const looksLikeStaging = (origin) => { const c = hostClass(origin); return c === 'loopback' || c === 'staging'; };

/**
 * Whether `send` may run against this origin. Pure, so every branch is testable without a terminal.
 * Loopback and staging names: go. Private IPs: GET with --target-is-staging or a terminal confirmation; writes only
 * with --target-is-staging. Any other host: GET with --target-is-staging or a confirmation; writes only with
 * --target-is-staging, and never on a host with `prod` in any label.
 * @param {{ origin: string, includeWrites?: boolean, targetIsStaging?: boolean, tty?: boolean }} o
 * @returns {{ action: 'go' | 'ask' | 'refuse', reason: string }}
 */
export function stagingGate(o) {
  const c = hostClass(o.origin);
  if (c === 'loopback' || c === 'staging') return { action: 'go', reason: '' };
  const host = clean(new URL(o.origin).hostname);
  if (c === 'private') {
    if (o.targetIsStaging) return { action: 'go', reason: '' };
    const what = `"${host}" is a private-network address: it may be staging or production.`;
    if (o.includeWrites) return { action: 'refuse', reason: `${what} --include-writes needs --target-is-staging there (a confirmation is not enough).` };
    if (o.tty) return { action: 'ask', reason: what };
    return { action: 'refuse', reason: `${what} If it really is staging, add --target-is-staging.` };
  }
  if (o.includeWrites) {
    if (host.toLowerCase().split('.').some((l) => l.includes('prod'))) return { action: 'refuse', reason: `"${host}" has "prod" in its name — --include-writes is always refused there (also with --target-is-staging).` };
    if (o.targetIsStaging) return { action: 'go', reason: '' };
    return { action: 'refuse', reason: `"${host}" does not look like a staging or test host — --include-writes needs --target-is-staging there (a confirmation is not enough).` };
  }
  if (o.targetIsStaging) return { action: 'go', reason: '' };
  if (o.tty) return { action: 'ask', reason: `"${host}" does not look like a staging or test host.` };
  return { action: 'refuse', reason: `"${host}" does not look like a staging or test host. If it really is staging, add --target-is-staging.` };
}

/**
 * Parse one --header value: "Name: value". $NAME and ${NAME} anywhere in the value are read from the environment
 * ("Authorization: Bearer $TOKEN"); $$ is a literal $. An unset or empty variable is an error that names the
 * variable, never a value.
 * @param {string} s @param {Record<string, string|undefined>} [env]
 * @returns {[string, string]}
 */
export function parseHeader(s, env = process.env) {
  const i = String(s).indexOf(':');
  const name = i > 0 ? s.slice(0, i).trim() : '';
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/.test(name)) throw new Error('--header must look like "Name: value" or "Name: $ENV_VAR"');
  if (RESERVED_HEADERS.has(name.toLowerCase())) throw new Error(`--header: ${name} is set by the probe itself and cannot be replaced`);
  // One pass with a function: a variable's value is never expanded again ($ inside a token stays as it is).
  const value = s.slice(i + 1).trim().replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => {
    if (all === '$$') return '$';
    const ref = a || b;
    const x = Object.hasOwn(env, ref) ? env[ref] : undefined;
    // Name the variable only when it looks like one (FOO_BAR); otherwise it may be part of a literal secret.
    if (!x) throw new Error(`--header ${name}: ${/^[A-Z_][A-Z0-9_]*$/.test(ref) ? `environment variable ${ref} is` : 'a $… reference in the value is'} not set or empty (write a literal $ as $$)`);
    return x;
  });
  if (!value) throw new Error(`--header ${name}: empty value`);
  if (/[\r\n\0]/.test(value)) throw new Error(`--header ${name}: the value contains a line break`);
  return [name, value];
}

/** Is this path segment "." or ".." (also %2e-encoded, or ".." followed by ";params")? @param {string} x */
const isDotSeg = (x) => /^(?:\.|%2e){1,2}(?:;.*)?$/i.test(x);

/**
 * Does a path contain "." / ".." segments, also percent-encoded (%2e, %2f, %5c) or with ";params"?
 * Such a path could leave the --url path prefix once the URL or the server resolves it. @param {string} p
 */
export function hasDotSegment(p) {
  let d = String(p);
  try { d = decodeURIComponent(d); } catch { /* malformed escapes: check the raw text */ }
  return [String(p), d].some((t) => t.split(/[/\\]|%2f|%5c/i).some(isDotSeg));
}

/** "/a//b/./../c" → "/a/b/c": no empty, "." or ".." segments (also %2e-encoded, or hidden behind %2f / %5c); "" for none. @param {string} s */
function normBase(s) {
  const segs = String(s).split(/[/\\]+/).filter((x) => x && !hasDotSegment(x));
  return segs.length ? '/' + segs.join('/') : '';
}

/**
 * The path between --url and the spec paths, taken from the raw spec: Swagger 2 basePath, or the path of
 * servers[0].url with server variables replaced by their defaults. Segments that stay templated are dropped
 * (never the literal "x" that report matching uses).
 * @param {any} doc parsed spec document
 */
export function specBasePath(doc) {
  if (!doc || typeof doc !== 'object') return '';
  let raw = '';
  /** @type {any} */
  let vars = {};
  if (typeof doc.basePath === 'string') raw = doc.basePath;
  else if (Array.isArray(doc.servers) && typeof doc.servers[0]?.url === 'string') { raw = doc.servers[0].url; vars = doc.servers[0].variables || {}; }
  raw = raw.replace(/\{([^{}]*)\}/g, (all, name) => {
    const d = vars && typeof vars === 'object' && Object.hasOwn(vars, name) ? vars[name]?.default : undefined;
    return typeof d === 'string' && d && !/[{}?#\\]/.test(d) ? d : all;
  });
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\/\/[^/]*/, ''); // scheme + host: --url decides those
  raw = raw.split(/[?#]/)[0];
  return normBase(raw.split('/').filter((x) => !/[{}]/.test(x)).join('/'));
}

/** Does `segs` occur as a contiguous run of segments in `inside`? @param {string[]} segs @param {string[]} inside */
function containsRun(segs, inside) {
  for (let i = 0; i + segs.length <= inside.length; i++) if (segs.every((s, k) => inside[i + k] === s)) return true;
  return false;
}

/**
 * Which operations to send, which not and why.
 * @param {{ base: string, ops: import('./spec.mjs').Operation[] }} spec  from loadSpec
 * @param {{ basePath?: string, specBase?: string, baseOverride?: string, origin?: string, includeWrites?: boolean, maxOps?: number }} [opt]
 *   basePath: the path of --url · specBase: the spec's own base (specBasePath; default: from spec.base) ·
 *   baseOverride: --base-path, used as given ('' = none) · origin: the target origin; every URL must stay on it
 */
export function planProbes(spec, opt = {}) {
  const maxOps = opt.maxOps ?? 300;
  const prefix = normBase(opt.basePath || '');
  let base;
  if (opt.baseOverride !== undefined) base = prefix + normBase(opt.baseOverride);
  else {
    const sb = opt.specBase !== undefined ? normBase(opt.specBase) : normBase(spec.base || '');
    // --url may already contain the spec's base path (https://staging/v1 and servers: [/v1]): never double it.
    const inUrl = sb && containsRun(sb.split('/').filter(Boolean), prefix.split('/').filter(Boolean));
    base = inUrl ? prefix : prefix + sb;
  }
  const origin = opt.origin || 'http://probe.invalid';
  // Every request path must stay under --url's path + the base path, as the URL parser resolves it.
  let under = '/';
  try { under = new URL((base + '/').replace(/^\/+/, '/'), origin + '/').pathname; } catch { /* checked per operation below */ }
  /** @type {Array<{ method: string, path: string, send: string, urlPath: string, url: string }>} */
  const plan = [];
  /** @type {Array<{ method: string, path: string, reason: string }>} */
  const notSent = [];
  const seen = new Set();
  for (const op of spec.ops) {
    const send = op.method === 'ANY' ? 'GET' : op.method; // route lists without methods: GET is the safe choice
    if (!SAFE.has(send) && !(WRITES.has(send) && opt.includeWrites)) {
      notSent.push({ method: op.method, path: op.path, reason: WRITES.has(send) ? 'write method (needs --include-writes --i-understand-this-is-staging)' : 'method never probed' });
      continue;
    }
    const k = `${send} ${op.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // Path parameters get a harmless placeholder, never a real-looking ID (no spec examples: they may be real records).
    // "?" and "#" in a spec path are encoded: they must not start a query or fragment.
    if (hasDotSegment(op.path)) { notSent.push({ method: op.method, path: op.path, reason: "path has '.' or '..' segments (it could leave the --url path)" }); continue; }
    const filled = op.path.replace(/\{[^}]+\}/g, PLACEHOLDER).replace(/[?#]/g, (c) => encodeURIComponent(c));
    // Exactly one leading "/" (no "//host" or "/\host"), then resolve against the origin and check it did not move.
    const urlPath = ((base + '/' + filled).replace(/^[/\\]+/, '/').replace(/\/{2,}/g, '/')) || '/';
    let u;
    try { u = new URL(urlPath, origin + '/'); } catch { notSent.push({ method: op.method, path: op.path, reason: 'not a valid URL path' }); continue; }
    if (u.origin !== origin) { notSent.push({ method: op.method, path: op.path, reason: 'URL would leave the target host' }); continue; }
    if (!u.pathname.startsWith(under) && u.pathname + '/' !== under) { notSent.push({ method: op.method, path: op.path, reason: 'path would leave the --url path and base path' }); continue; }
    if (plan.length >= maxOps) { notSent.push({ method: op.method, path: op.path, reason: `over the --max-ops cap (${maxOps})` }); continue; }
    plan.push({ method: op.method, path: op.path, send, urlPath: u.pathname, url: u.href });
  }
  return { plan, notSent };
}

/** The plan as text, for --dry-run (no markers, no header values). @param {ReturnType<typeof planProbes>} p */
export function planToText(p) {
  const L = [`${p.plan.length} request(s) would be sent:`];
  p.plan.forEach((x, i) => L.push(`${String(i + 1).padStart(4)} ${x.send.padEnd(6)} ${clean(x.url)}${x.send !== x.method ? `   (${clean(x.method)} in the spec)` : ''}`));
  if (p.notSent.length) {
    L.push('', `${p.notSent.length} operation(s) not sent:`);
    for (const s of p.notSent) L.push(`       ${clean(s.method).padEnd(6)} ${clean(s.path)}  — ${s.reason}`);
  }
  return L.join('\n');
}

/**
 * One request with node:http(s), not fetch: the response body is never read and never decompressed (fetch hands
 * compressed bytes to zlib's Brotli decoder even when the body is cancelled — CVE-2026-111497 on older Node).
 * Redirects are not followed (node:http never follows them). Resolves at the response headers.
 * @param {string} url @param {{ method: string, headers: Record<string, string>, body?: string, timeoutMs: number }} o
 * @returns {Promise<{ status: number, location: string }>}
 */
export function httpRequest(url, o) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { ...o.headers };
    if (o.body != null) headers['content-length'] = String(Buffer.byteLength(o.body));
    let timer;
    try {
      const req = (u.protocol === 'https:' ? httpsReq : httpReq)(u, { method: o.method, headers, agent: false }, (res) => {
        clearTimeout(timer);
        res.on('error', () => {});
        const loc = res.headers.location;
        resolve({ status: res.statusCode || 0, location: typeof loc === 'string' ? loc : '' });
        res.destroy(); // the body is never read
      });
      timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), o.timeoutMs);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end(o.body);
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

/** Node versions whose Brotli decoder has CVE-2026-111497 (fixed in 22.23.5 and 24.22.3). @param {string} [v] */
export function nodeHasBrotliBug(v = process.versions.node) {
  const [a, b, c] = v.split('.').map(Number);
  const lt = (/** @type {number[]} */ x) => b < x[0] || (b === x[0] && c < x[1]);
  if (a < 22 || a === 23) return true;
  if (a === 22) return lt([23, 5]);
  if (a === 24) return lt([22, 3]);
  return false;
}

/** Short, safe error code for the manifest (no messages: they may carry URLs or internals). @param {any} e */
function errCode(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const c = e?.cause?.code || e?.code;
  return typeof c === 'string' && /^[A-Z_0-9]{2,40}$/.test(c) ? c : 'network error';
}

/**
 * Step 1: send one tagged request per planned operation.
 * @param {{ url: string, spec: { base: string, ops: any[] }, specBase?: string, baseOverride?: string, includeWrites?: boolean,
 *   rate?: number, timeoutMs?: number, maxOps?: number, headers?: Array<[string, string]>,
 *   version?: string, run?: string, log?: (s: string) => void, requestImpl?: typeof httpRequest }} o
 */
export async function sendProbes(o) {
  const target = checkTarget(o.url);
  const rate = o.rate ?? 2;
  if (!(rate > 0 && rate <= 50)) throw new Error('--rate must be between 0.1 and 50 requests per second');
  const timeoutMs = o.timeoutMs ?? 10_000;
  const run = o.run ?? newRunId();
  if (!RUN_RE.test(run)) throw new Error('run id must be 6-16 lowercase letters or digits');
  const doRequest = o.requestImpl || httpRequest;
  const log = o.log || (() => {});
  const { plan, notSent } = planProbes(o.spec, { basePath: target.path, specBase: o.specBase, baseOverride: o.baseOverride, origin: target.origin, includeWrites: o.includeWrites, maxOps: o.maxOps });
  const extra = o.headers || [];
  for (const [k] of extra) if (RESERVED_HEADERS.has(k.toLowerCase())) throw new Error(`header ${k} cannot be replaced`);
  const ua = `api-dead-ends-logging-probe/${o.version || '0'}`;
  const started = new Date();
  /** @type {any[]} */
  const probes = [];
  const gap = 1000 / rate;
  let last = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const n = i + 1;
    const marker = markerOf(run, n);
    const wait = last + gap - Date.now();
    if (last && wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const write = WRITES.has(p.send);
    const u = new URL(p.url);
    if (u.origin !== target.origin) throw new Error('internal: probe URL left the target origin'); // planProbes already refuses these
    u.searchParams.set('ade_probe', marker);
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, val] of extra) headers[k] = val;
    Object.assign(headers, { 'x-ade-probe': marker, 'user-agent': `${ua} ${marker}`, accept: '*/*' });
    if (write) headers['content-type'] = 'application/json';
    const rec = { n, marker, method: p.method, sent: p.send, path: p.path, urlPath: p.urlPath, status: 0, ms: /** @type {number|null} */ (null), error: '', redirect: '' };
    const t0 = performance.now();
    try {
      const res = await doRequest(u.href, { method: p.send, headers, body: write ? '{}' : undefined, timeoutMs });
      rec.ms = Math.round(performance.now() - t0);
      rec.status = res.status;
      if (res.status >= 300 && res.status < 400) {
        const loc = res.location;
        // Never followed. Only record whether it points elsewhere — the marker already reached this host.
        if (loc) { try { rec.redirect = new URL(loc, u).origin === target.origin ? 'same host (not followed)' : 'other host (not followed)'; } catch { rec.redirect = 'invalid location'; } }
      }
    } catch (e) {
      rec.error = errCode(e);
    }
    probes.push(rec);
    log(`${String(n).padStart(4)} ${p.send.padEnd(6)} ${clean(p.path)}  → ${rec.status || rec.error}${rec.ms != null ? ` (${rec.ms} ms)` : ''}`);
  }
  const finished = new Date();
  return {
    kind: MANIFEST_KIND,
    tool: `api-dead-ends ${o.version || ''}`.trim(),
    run,
    prefix: `ade-${run}`,
    target: target.origin + target.path,
    started: started.toISOString(),
    finished: finished.toISOString(),
    rate,
    timeoutMs,
    includeWrites: !!o.includeWrites,
    headerNames: extra.map(([k]) => k), // names only: values (tokens) are never stored
    probes,
    notSent,
  };
}

/** Ready-made searches for common log sources. @param {any} m manifest @param {string} [manifestPath] */
export function searchHints(m, manifestPath = '<this manifest>') {
  const p = m.prefix;
  const from = new Date(Date.parse(m.started) - 60_000).toISOString();
  const to = new Date(Date.parse(m.finished) + 10 * 60_000).toISOString();
  const svc = '<your-service>';
  return [
    `Time window to export: ${from} … ${to} (1 min before the run, 10 min after for ingestion lag).`,
    `Every request carries "${p}-NNNN" in the X-ADE-Probe header, the User-Agent and the query (?ade_probe=…). Export every`,
    'log record in the window that contains it, from the logs of the application you want to check. Leave out ingress,',
    'nginx, gateway and load balancer access logs: they record every request, so everything would look logged.',
    `  Kibana (KQL) / OpenSearch:  service.name:"${svc}" and "${p}"     then Share → CSV, or save the _search response as JSON`,
    `  VictoriaLogs (LogsQL):      service:"${svc}" "${p}"     curl …/select/logsql/query -d 'query=service:"${svc}" "${p}"' > logs.jsonl`,
    `  Loki (LogQL):               {service_name="${svc}"} |= "${p}"     logcli query --from=… --to=… '{service_name="${svc}"} |= "${p}"' > logs.txt`,
    `  CloudWatch:                 the app's log group, filter pattern "${p}"   or Logs Insights: fields @message | filter @message like /${p}/`,
    `  Datadog:                    service:${svc} "${p}"`,
    `  Splunk:                     index=<your-index> sourcetype=<your-app> "${p}"`,
    `  Plain files:                grep -h '${p}' app.log > logs.txt`,
    `Then: api-dead-ends logging-probe verify --run ${manifestPath} --logs logs.txt [--logs more files…]`,
  ].join('\n');
}

/**
 * Scan a text stream for markers of one run without holding more than one chunk plus a short tail in memory
 * (a saved _search response is often a single multi-MB line). Returns marker number → hits.
 * @param {AsyncIterable<Buffer|string>} input @param {string} run @param {Map<number, number>} hits
 */
export async function scanStream(input, run, hits) {
  if (!RUN_RE.test(run)) throw new Error('invalid run id in the manifest');
  const re = new RegExp(`ade-${run}-(\\d{${PAD}})(?!\\d)`, 'g');
  const keepTail = `ade-${run}-`.length + PAD + 1;
  let tail = '';
  let bytes = 0;
  let lines = 0;
  const take = (/** @type {string} */ buf, /** @type {boolean} */ final) => {
    re.lastIndex = 0;
    let consumed = 0;
    for (let m; (m = re.exec(buf));) {
      const end = m.index + m[0].length;
      if (!final && end >= buf.length) break; // the next chunk may continue the number: decide later
      hits.set(Number(m[1]), (hits.get(Number(m[1])) || 0) + 1);
      consumed = end;
    }
    return buf.slice(Math.max(consumed, buf.length - keepTail));
  };
  for await (const chunk of input) {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) lines++;
    tail = take(tail + s, false);
  }
  take(tail, true);
  return { bytes, lines };
}

/** @param {string} f */
export function openLog(f) {
  if (f === '-') return process.stdin;
  const src = createReadStream(f, { highWaterMark: 1 << 20 });
  if (!f.endsWith('.gz')) return src;
  const gz = createGunzip();
  src.on('error', (e) => gz.destroy(e)); // pipe() does not forward a read error (missing file)
  return src.pipe(gz);
}

/** File names that look like edge access logs (they record every request, so everything in them looks logged). @param {string} f */
export const looksLikeAccessLog = (f) => f !== '-' && /access|ingress|nginx|gateway|haproxy|traefik|envoy/i.test(basename(f));

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const METHOD_RE = /^[A-Z]{1,10}$/;
const ERROR_RE = /^[A-Za-z0-9_ ]{0,40}$/;

/**
 * Check a run manifest before verify uses it. Manifests travel between people and CI jobs, so every field that
 * ends up in the report is checked for shape (text fields are also cleaned when printed).
 * @param {any} m
 */
export function checkManifest(m) {
  const bad = (/** @type {string} */ what) => new Error(`not a valid logging-probe run manifest: ${what}`);
  if (!m || typeof m !== 'object' || m.kind !== MANIFEST_KIND || !Array.isArray(m.probes) || !RUN_RE.test(String(m.run))) throw new Error('not a logging-probe run manifest (from `logging-probe send`)');
  for (const k of ['started', 'finished']) if (m[k] !== undefined && !(typeof m[k] === 'string' && ISO_RE.test(m[k]))) throw bad(`${k} is not an ISO date`);
  if (m.target !== undefined && typeof m.target !== 'string') throw bad('target is not text');
  m.probes.forEach((/** @type {any} */ p, /** @type {number} */ i) => {
    const at = `probes[${i}]`;
    if (!p || typeof p !== 'object') throw bad(`${at} is not an object`);
    if (!Number.isInteger(p.n) || p.n < 1 || p.n > 10 ** PAD - 1) throw bad(`${at}.n is not a probe number`);
    if (p.marker !== undefined && p.marker !== markerOf(m.run, p.n)) throw bad(`${at}.marker does not match the run`);
    if (typeof p.method !== 'string' || !METHOD_RE.test(p.method)) throw bad(`${at}.method is not an HTTP method`);
    if (typeof p.path !== 'string') throw bad(`${at}.path is not text`);
    if (p.status !== undefined && !(Number.isInteger(p.status) && p.status >= 0 && p.status <= 999)) throw bad(`${at}.status is not an HTTP status`);
    if (p.error !== undefined && !(typeof p.error === 'string' && ERROR_RE.test(p.error))) throw bad(`${at}.error is not an error code`);
  });
  if (m.notSent !== undefined) {
    if (!Array.isArray(m.notSent)) throw bad('notSent is not a list');
    m.notSent.forEach((/** @type {any} */ x, /** @type {number} */ i) => {
      if (!x || typeof x !== 'object' || typeof x.method !== 'string' || typeof x.path !== 'string' || typeof x.reason !== 'string') throw bad(`notSent[${i}] needs method, path and reason`);
    });
  }
  return m;
}

/** Verdict codes (JSON) → words (Markdown, terminal). */
export const VERDICT_LABEL = /** @type {const} */ ({
  'not logged': '**NOT logged**',
  unknown: 'unknown (check the export)',
  gateway: 'answered by gateway/auth (handler maybe not reached)',
  'not reached': 'not reached',
  logged: 'logged',
});
/** 401/403/404 and redirects usually come from a gateway, auth layer or router before the handler. @param {number} s */
const fromGateway = (s) => s === 401 || s === 403 || s === 404 || (s >= 300 && s < 400);

/**
 * Step 2: verdict per operation.
 * @param {any} manifest
 * @param {Map<number, number>} hits  from scanStream (all files together)
 * @param {{ files?: string[], perFile?: Array<{ file: string, hits: Map<number, number> }>, bytes?: number, lines?: number }} [src]
 */
export function verdicts(manifest, hits, src = {}) {
  const m = checkManifest(manifest);
  const per = src.perFile || [];
  const found = m.probes.some((/** @type {any} */ p) => hits.get(p.n));
  const rows = m.probes.map((/** @type {any} */ p) => {
    const h = hits.get(p.n) || 0;
    // Found wins (even a client-side timeout may have reached the app); no status and not found → not reached.
    // Nothing of the run found anywhere → the export is the likely problem, not the app: unknown, not NOT logged.
    const verdict = h ? 'logged' : !p.status ? 'not reached' : fromGateway(p.status) ? 'gateway' : found ? 'not logged' : 'unknown';
    const foundIn = per.filter((f) => f.hits.get(p.n)).map((f) => ({ file: f.file, hits: /** @type {number} */ (f.hits.get(p.n)) }));
    return { method: p.method, path: p.path, marker: p.marker, status: p.status, error: p.error || '', hits: h, foundIn, verdict };
  });
  const count = (/** @type {string} */ x) => rows.filter((/** @type {any} */ r) => r.verdict === x).length;
  const notSent = m.notSent || [];
  const totals = { operations: rows.length, logged: count('logged'), notLogged: count('not logged'), gateway: count('gateway'), notReached: count('not reached'), unknown: count('unknown'), notSent: notSent.length };
  /** @type {string[]} */
  const warnings = [];
  const reachedAny = m.probes.some((/** @type {any} */ p) => p.status);
  if (rows.length && !reachedAny && !found) warnings.push(`No request of run ade-${m.run} reached the target: all ${rows.length} failed (${[...new Set(m.probes.map((/** @type {any} */ p) => clean(p.error || 'no status')))].join(', ')}), so nothing could be logged. Check --url, VPN and DNS, then run logging-probe send again.`);
  else if (rows.length && !found) warnings.push(`No marker of run ade-${m.run} was found anywhere in the logs. That usually means the wrong export (other source, other time window, filtered out) or logs not shipped yet — not that nothing is logged. Check the export first.`);
  const files = src.files || per.map((f) => f.file);
  for (const f of files.filter(looksLikeAccessLog)) warnings.push(`${clean(f)} looks like an access / ingress / gateway log. Those record every request, so endpoints found only there look logged even when the application wrote nothing. Check the "Found in" column, or verify with the application's logs only.`);
  return {
    run: m.run,
    target: m.target,
    window: { started: m.started, finished: m.finished },
    source: { files, bytes: src.bytes || 0, lines: src.lines || 0 },
    totals,
    found,
    warnings,
    rows,
    notSent,
    note: 'Why an endpoint can be missing: the route is registered before the logging middleware or in a separate router/app; the logger skips some paths (morgan skip, pino-http ignore, nginx access_log off — see `api-dead-ends logging-check`); sampling; log filters in the shipper; the export missed part of the window. "Answered by gateway/auth": the response was 401/403/404 or a redirect, which a gateway, auth layer or router usually sends before the handler runs — pass credentials with --header and send again to reach the handler.',
  };
}

/** One-line summary for the terminal. @param {ReturnType<typeof verdicts>['totals']} t */
export function summaryLine(t) {
  const parts = [`${t.logged} logged`, `${t.notLogged} NOT logged`];
  if (t.gateway) parts.push(`${t.gateway} answered by gateway/auth`);
  if (t.notReached) parts.push(`${t.notReached} not reached`);
  if (t.unknown) parts.push(`${t.unknown} unknown (check the export)`);
  if (t.notSent) parts.push(`${t.notSent} not sent`);
  return `${t.operations} operations: ${parts.join(' · ')}`;
}

/** @param {ReturnType<typeof verdicts>} r */
export function verdictsToMarkdown(r) {
  const code = (/** @type {string} */ s) => `\`${String(s).replace(/[\u0000-\u001f\u007f-\u009f`|]/g, ' ')}\``;
  // Plain table cell / sentence text from the manifest: no escape sequences, no line breaks, no table or code breaks.
  const cell = (/** @type {unknown} */ s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/[`|\\*_<>[\]]/g, (c) => `\\${c}`);
  const L = ['# api-dead-ends: logging probe (active, staging)', '',
    `Run ${code(r.run)} against ${code(r.target)}, ${cell(r.window.started)} … ${cell(r.window.finished)}. Logs scanned: ${r.source.files.length} file(s), ${r.source.lines.toLocaleString('en-US')} lines.`, '',
    `**${summaryLine(r.totals)}.**`, ''];
  for (const w of r.warnings) L.push(`> **Warning.** ${clean(w)}`, '');
  const order = { 'not logged': 0, unknown: 1, gateway: 2, 'not reached': 3, logged: 4 };
  const rank = (/** @type {string} */ v) => order[/** @type {keyof typeof order} */ (v)] ?? 9;
  const rows = [...r.rows].sort((a, b) => rank(a.verdict) - rank(b.verdict));
  L.push('| Verdict | Method | Path | Status | Marker matches | Found in | Marker |', '|---|---|---|---:|---:|---|---|');
  for (const x of rows) {
    const where = x.foundIn.length ? x.foundIn.map((f) => `${code(f.file)} (${f.hits})`).join(', ') : '—';
    L.push(`| ${VERDICT_LABEL[/** @type {keyof typeof VERDICT_LABEL} */ (x.verdict)] || cell(x.verdict)} | ${cell(x.method)} | ${code(x.path)} | ${cell(x.status || x.error || '—')} | ${x.hits} | ${where} | ${code(x.marker)} |`);
  }
  L.push('');
  if (r.notSent.length) {
    L.push('## Not sent', '', '| Method | Path | Why |', '|---|---|---|');
    for (const s of r.notSent) L.push(`| ${cell(s.method)} | ${code(s.path)} | ${cell(s.reason)} |`);
    L.push('');
  }
  L.push(r.note, '');
  return L.join('\n');
}
