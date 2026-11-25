// @ts-check
// Match the usage table against the spec and assign finding classes.

import { matchOp, pathKnown } from './spec.mjs';

/** @typedef {import('./usage.mjs').UsageRow} UsageRow */
/** @typedef {import('./spec.mjs').Operation} Operation */

const PROBE = [
  /^\/(wp-|wordpress|xmlrpc\.php|phpmyadmin|pma|cgi-bin|vendor\/phpunit)/i,
  /(^|\/)\.(env|git|svn|aws|ds_store|htaccess)(\/|$)/i,
  /^\/(robots\.txt|favicon\.ico|sitemap\.xml|security\.txt|\.well-known)(\/|$)/i,
  /^\/(env|config|metrics|actuator|server-status|healthz?|ready|live|status)$/i,
  /^\/(swagger|swagger-ui|api-docs|openapi|redoc)(\/|\.|$)/i,
  /\.(php|asp|aspx|jsp|cgi|bak|sql|zip|tar|gz)$/i,
];

/**
 * @typedef {object} Options
 * @property {number} [rare]          fewer calls than this in the window → rare (default 100)
 * @property {number} [days]          window length in days (for confidence and labels)
 * @property {number} [errorShare]    5xx share for a server_errors finding (default 0.01)
 * @property {number} [errorMin]      minimum 5xx count for a finding (default 10)
 * @property {boolean} [keepPreflight] do not move OPTIONS/HEAD to noise
 */

/**
 * @param {UsageRow[]} rows
 * @param {{ ops: Operation[], title: string, version: string, base: string }} spec
 * @param {Options} [opt]
 */
export function classify(rows, spec, opt = {}) {
  const RARE = opt.rare ?? 100;
  const ERR_SHARE = opt.errorShare ?? 0.01;
  const ERR_MIN = opt.errorMin ?? 10;
  const ops = spec.ops.map((o) => ({ op: o, calls: 0, status: new Map(), first_seen: '', last_seen: '', rows: 0 }));
  const byOp = new Map(ops.map((x) => [x.op, x]));

  /** @type {Array<UsageRow & { kind: string }>} */
  const shadow = [];
  /** @type {Array<UsageRow & { kind: string }>} */
  const noise = [];
  let total = 0;
  /** @type {Map<string, { op: Operation, values: Map<string, number> }>} */
  const lits = new Map();

  /** @type {Array<[UsageRow, Operation]>} */
  const matched = [];
  for (const r of rows) {
    total += r.calls;
    const o = matchOp(spec.ops, r.method, r.path);
    if (o) {
      noteLiteralOnParam(lits, o, r, spec.base);
      matched.push([r, o]);
      continue;
    }
    const known = pathKnown(spec.ops, r.path);
    const kind = noiseKind(r, known, opt);
    if (kind) noise.push({ ...r, kind });
    else if (known && spec.ops.filter((op) => op.re.test(r.path)).every((op) => wordOnParam(op, r.path, spec.base))) shadow.push({ ...r, kind: 'path_not_in_spec' });
    else shadow.push({ ...r, kind: known ? 'method_not_in_spec' : 'path_not_in_spec' });
  }

  // A word (e.g. /orders/export) that landed on a parameter ({id}) is most likely its own, undocumented route —
  // unless the same parameter receives many different words (then it is a real slug parameter).
  /** @type {Map<string, string>} path → matched template */
  const separate = new Map();
  for (const { op, values } of lits.values()) {
    if (values.size > 3) continue;
    for (const p of values.keys()) separate.set(`${op.method} ${p}`, op.path);
  }

  for (const [r, o] of matched) {
    const sep = separate.get(`${o.method} ${r.path}`);
    if (sep) { shadow.push({ ...r, kind: 'possibly_separate_route', matched: sep }); continue; }
    {
      const x = /** @type {any} */ (byOp.get(o));
      x.calls += r.calls;
      x.rows++;
      if (r.first_seen && (!x.first_seen || r.first_seen < x.first_seen)) x.first_seen = r.first_seen;
      if (r.last_seen > x.last_seen) x.last_seen = r.last_seen;
      for (const [c, n] of r.status) x.status.set(c, (x.status.get(c) || 0) + n);
    }
  }

  const endpoints = ops.map((x) => {
    const s5 = sumStatus(x.status, (c) => c >= 500);
    let cls = x.calls === 0 ? 'not_seen' : x.calls < RARE ? 'rare' : 'used';
    if (x.op.deprecated && x.calls > 0) cls = 'deprecated_in_use';
    return {
      method: x.op.method,
      path: x.op.path,
      operationId: x.op.operationId,
      deprecated: x.op.deprecated,
      class: cls,
      calls: x.calls,
      first_seen: x.first_seen,
      last_seen: x.last_seen,
      status: x.status,
      errors5xx: s5,
      periodicHint: x.calls === 0 && /report|export|monthly|annual|yearly|close|reconcil|batch|cron|job|sync|upload|import/i.test(x.op.path),
    };
  });

  const serverErrors = endpoints
    .filter((e) => e.errors5xx >= ERR_MIN && e.calls > 0 && e.errors5xx / e.calls >= ERR_SHARE)
    .sort((a, b) => b.errors5xx / b.calls - a.errors5xx / a.calls);

  // 5xx that did not pass the threshold, and endpoints with many client errors (4xx).
  const errorsBelow = endpoints
    .filter((e) => e.errors5xx > 0 && !serverErrors.includes(e))
    .sort((a, b) => b.errors5xx - a.errors5xx);
  const clientErrors = endpoints
    .map((e) => ({ e, n: sumStatus(e.status, (c) => c >= 400 && c < 500 && c !== 404 && c !== 401) }))
    .filter(({ e, n }) => n >= ERR_MIN && e.calls > 0 && n / e.calls >= 0.1)
    .sort((a, b) => b.n / b.e.calls - a.n / a.e.calls)
    .map(({ e, n }) => ({ method: e.method, path: e.path, calls: e.calls, errors4xx: n, status: e.status }));
  /** @type {Array<{ method: string, path: string, matched: string, calls: number }>} */
  const ambiguous = shadow.filter((x) => x.kind === 'possibly_separate_route')
    .map((x) => ({ method: x.method, path: x.path, matched: /** @type {any} */ (x).matched, calls: x.calls }))
    .sort((a, b) => b.calls - a.calls);

  const days = opt.days ?? inferDays(rows);
  const confidence = days == null ? 'low' : days >= 90 ? 'high' : days >= 35 ? 'medium' : 'low';
  const shadowCalls = shadow.reduce((s, r) => s + r.calls, 0);
  const count = (/** @type {string} */ c) => endpoints.filter((e) => e.class === c).length;

  return {
    api: { title: spec.title, version: spec.version, base: spec.base },
    window: { days, from: minOf(rows, 'first_seen'), to: maxOf(rows, 'last_seen'), confidence },
    totals: {
      operations: endpoints.length,
      requests: total,
      rows: rows.length,
      used: count('used'),
      rare: count('rare'),
      not_seen: count('not_seen'),
      deprecated_in_use: count('deprecated_in_use'),
      shadow: shadow.length,
      shadowRequests: shadowCalls,
      noise: noise.length,
      noiseRequests: noise.reduce((s, r) => s + r.calls, 0),
      serverErrors: serverErrors.length,
      serverErrorsBelowThreshold: errorsBelow.length,
      clientErrors: clientErrors.length,
      ambiguous: ambiguous.length,
    },
    thresholds: { rare: RARE, errorShare: ERR_SHARE, errorMin: ERR_MIN },
    endpoints,
    shadow: shadow.sort((a, b) => b.calls - a.calls),
    noise: noise.sort((a, b) => b.calls - a.calls),
    serverErrors,
    errorsBelow,
    clientErrors,
    ambiguous,
  };
}

/** Debug, admin and infrastructure paths: worth a look when they answer 2xx. */
export const RISKY = /(^|\/)(debug|actuator|admin|internal|metrics|env|config|\.env|\.git|phpinfo|console|swagger|api-docs|heapdump|trace|pprof|vars)(\/|$|\.)/i;

/**
 * A word in the path sits on a parameter of this operation.
 * @param {Operation} op @param {string} path @param {string} base
 */
function wordOnParam(op, path, base) {
  let p = path;
  if (base && p.startsWith(base + '/')) p = p.slice(base.length);
  const seen = p.split('/').filter(Boolean);
  const tpl = op.path.split('/').filter(Boolean);
  return seen.length === tpl.length && tpl.some((t, i) => /^\{[^}]+\}$/.test(t) && /^[a-z][a-z_-]{1,40}$/i.test(seen[i]));
}

/**
 * Remember observed literal segments that sit on a spec parameter.
 * @param {Map<string, { op: Operation, values: Map<string, number> }>} lits
 * @param {Operation} op @param {UsageRow} r @param {string} base
 */
function noteLiteralOnParam(lits, op, r, base) {
  if (!op.params) return;
  let p = r.path;
  if (base && p.startsWith(base + '/')) p = p.slice(base.length);
  const seen = p.split('/').filter(Boolean);
  const tpl = op.path.split('/').filter(Boolean);
  if (seen.length !== tpl.length) return;
  tpl.forEach((t, i) => {
    const v = seen[i];
    if (!/^\{[^}]+\}$/.test(t) || v === '{id}' || !/^[a-z][a-z_-]{1,40}$/i.test(v)) return;
    const k = `${op.method} ${op.path} #${i}`;
    if (!lits.has(k)) lits.set(k, { op, values: new Map() });
    const m = /** @type {any} */ (lits.get(k)).values;
    m.set(r.path, (m.get(r.path) || 0) + r.calls);
  });
}

/**
 * @param {UsageRow} r
 * @param {boolean} known
 * @param {Options} opt
 */
function noiseKind(r, known, opt) {
  if (!opt.keepPreflight && (r.method === 'OPTIONS' || r.method === 'HEAD')) return 'preflight';
  if (PROBE.some((re) => re.test(r.path)) && !sumStatus(r.status, (c) => c >= 200 && c < 300)) return 'probe';
  const all = sumStatus(r.status, () => true);
  const notFound = sumStatus(r.status, (c) => c === 404 || c === 405);
  if (!known && all > 0 && notFound === all) return 'not_found_only';
  return null;
}

/**
 * @param {Map<string, number>} m
 * @param {(code: number) => boolean} pred
 */
export function sumStatus(m, pred) {
  let s = 0;
  for (const [c, n] of m) if (pred(Number(c))) s += n;
  return s;
}

/** @param {UsageRow[]} rows */
function inferDays(rows) {
  const a = minOf(rows, 'first_seen');
  const b = maxOf(rows, 'last_seen');
  if (!a || !b) return null;
  let d = (Date.parse(b) - Date.parse(a)) / 86400e3;
  // daily buckets (Prometheus, Datadog rollups) stamp each day at 00:00 — the last bucket still covers a whole day
  if (/T00:00:00(\.000)?Z$/.test(a) && /T00:00:00(\.000)?Z$/.test(b)) d += 1;
  return Number.isFinite(d) ? Math.max(1, Math.round(d)) : null;
}

/** @param {UsageRow[]} rows @param {'first_seen'|'last_seen'} k */
function minOf(rows, k) {
  return rows.map((r) => r[k]).filter(Boolean).sort()[0] || '';
}
/** @param {UsageRow[]} rows @param {'first_seen'|'last_seen'} k */
function maxOf(rows, k) {
  return rows.map((r) => r[k]).filter(Boolean).sort().at(-1) || '';
}
