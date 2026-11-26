// @ts-check
// VictoriaLogs, straight over its HTTP API (LogsQL): the usage table and, optionally, error texts behind 5xx.
// Read-only: only /select/logsql/field_names and /select/logsql/query. Fields are detected from the data
// (gateway access logs: Kong, APISIX, nginx, Envoy, OpenTelemetry names), so no preset is needed.
// IDs (UUIDs, numbers) are folded on the server; the rest of the path templating happens here.

import { maskText, goodTraceId } from './errortexts.mjs';
import { templatePath } from '../template.mjs';
import { cleanText } from '../usage.mjs';

/** Strip control, C1 and bidi characters before printing server text. @param {unknown} x */
const plain = (x) => String(x).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');

/** A JSON array that LogsQL stats return as a string (uniq_values). @param {unknown} x @returns {unknown[]} */
function jsonArray(x) {
  if (Array.isArray(x)) return x;
  if (typeof x !== 'string') return [];
  try { const a = JSON.parse(x); return Array.isArray(a) ? a : []; } catch { return []; }
}


export const VL_CANDIDATES = {
  method: ['method', 'request.method', 'http.request.method', 'http.method', 'http_method', 'req.method', 'request_method'],
  path: ['http.route', 'path', 'request.uri', 'url.path', 'uri', 'http.target', 'url.original', 'request_uri', 'req.url', 'request.path'],
  status: ['status', 'response.status', 'http.response.status_code', 'http.status_code', 'status_code', 'http_status', 'res.statusCode', 'response_code'],
  trace: ['trace_id', 'traceId', 'trace.id', 'x-trace-id', 'traceid', 'request_id', 'x-request-id'],
};

/** LogsQL field name: plain names as is, anything else quoted. @param {string} f */
export function fq(f) {
  return /^[A-Za-z_][\w.]*$/.test(f) && f !== '_time' ? f : JSON.stringify(f);
}

/**
 * Pick the most filled field of each kind. Explicit names win.
 * @param {Map<string, number>} hits field name → records that have it
 * @param {{ methodField?: string, pathField?: string, statusField?: string, traceField?: string }} [o]
 */
export function pickVlFields(hits, o = {}) {
  const best = (/** @type {string[]} */ c) => c.filter((n) => (hits.get(n) || 0) > 0).sort((a, b) => (hits.get(b) || 0) - (hits.get(a) || 0))[0] || null;
  return {
    methodField: o.methodField || best(VL_CANDIDATES.method),
    pathField: o.pathField || best(VL_CANDIDATES.path),
    statusField: o.statusField || best(VL_CANDIDATES.status),
    traceField: o.traceField || best(VL_CANDIDATES.trace),
  };
}

/** Server-side folding: query string off, UUIDs and numeric segments → {id}. Keeps the result small. @param {string} p */
export function foldPipes(p) {
  const f = fq(p);
  return [
    `replace_regexp ("\\\\?.*", "") at ${f}`,
    `replace_regexp ("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", "{id}") at ${f}`,
    `replace_regexp ("/[0-9]+(/|$)", "/{id}$1") at ${f}`,
    `replace_regexp ("/[0-9]+(/|$)", "/{id}$1") at ${f}`,
  ].join(' | ');
}

/**
 * The base filter: service, extra LogsQL filter, exclusions.
 * @param {{ service?: string, serviceField?: string, accessFilter?: string, excludeFilter?: string }} o
 */
export function baseFilter(o) {
  const parts = [];
  if (o.service) parts.push(`${fq(o.serviceField || 'container_name')}:${JSON.stringify(o.service)}`);
  if (o.accessFilter) parts.push(`(${o.accessFilter})`);
  if (o.excludeFilter) parts.push(`-(${o.excludeFilter})`);
  return parts.join(' ') || '*';
}

/**
 * @typedef {(path: string, params: Record<string, string>) => Promise<string>} VlRequest  returns the response body
 * @typedef {{ service?: string, serviceField?: string, accessFilter?: string, excludeFilter?: string, days?: number,
 *   daily?: boolean, hourly?: boolean, methodField?: string, pathField?: string, statusField?: string, traceField?: string,
 *   errorField?: string, errors?: boolean, errorHours?: number, maxRows?: number, now?: number, keep?: Iterable<string>, log?: (s: string) => void }} VlOptions
 */

/** @param {VlRequest} request @param {VlOptions} o */
export async function fetchVictoriaLogs(request, o) {
  const log = o.log || (() => {});
  const now = o.now ?? Date.now();
  const days = o.days ?? 7;
  const base = baseFilter(o);
  const iso = (/** @type {number} */ t) => new Date(t).toISOString();

  // 1. detect fields on the last day of data
  const fnBody = await request('/select/logsql/field_names', { query: base, start: iso(now - 864e5), end: iso(now) });
  /** @type {Map<string, number>} */
  const hits = new Map();
  for (const x of parseFieldNames(fnBody)) hits.set(x.value, x.hits);
  if (!hits.size) throw new Error(`VictoriaLogs: no records for ${base} in the last 24 h. Check --service / --service-field (default container_name) or pass --access-filter '<LogsQL>'.`);
  const F = pickVlFields(hits, o);
  if (!F.methodField || !F.pathField || !F.statusField) {
    const names = plain([...hits.keys()].filter((n) => !n.startsWith('_')).slice(0, 40).join(', ')).slice(0, 600);
    throw new Error(`VictoriaLogs: could not find the ${!F.methodField ? 'method' : !F.pathField ? 'path' : 'status'} field. Fields seen: ${names}. Pass --method-field / --path-field / --status-field.`);
  }
  log(plain(`Fields: method=${F.methodField} path=${F.pathField} status=${F.statusField}${F.traceField ? ` trace=${F.traceField}` : ''}`));

  // 2. usage, one day at a time
  const m = fq(F.methodField), p = fq(F.pathField), s = fq(F.statusField);
  const bucket = o.hourly ? '_time:1h, ' : o.daily ? '_time:1d, ' : '';
  const maxRows = o.maxRows ?? (o.hourly ? 200000 : 50000);
  const rows = [];
  const truncated = [];
  const dayMs = 864e5;
  const start0 = Math.floor((now - days * dayMs) / dayMs) * dayMs;
  for (let t = start0; t < now; t += dayMs) {
    const end = Math.min(t + dayMs, now);
    const q = `${base} ${m}:* ${p}:* ${s}:* | ${foldPipes(F.pathField)} | stats by (${bucket}${m}, ${p}, ${s}) count() calls, min(_time) first_seen, max(_time) last_seen | sort by (calls desc) | limit ${maxRows + 1}`;
    const body = await request('/select/logsql/query', { query: q, start: iso(t), end: iso(end) });
    const got = parseLines(body);
    if (got.length > maxRows) { truncated.push(iso(t).slice(0, 10)); got.length = maxRows; }
    for (const j of got) {
      const calls = Number(j.calls) || 0;
      const path = j[F.pathField];
      if (!calls || !path) continue;
      const time = j._time ? String(j._time) : '';
      const st = String(j[F.statusField] ?? '');
      rows.push({
        method: String(j[F.methodField] || ''), path: String(path), calls,
        first_seen: String(j.first_seen || time), last_seen: String(j.last_seen || time),
        status: /^\d{3}$/.test(st) ? `${st}:${calls}` : '',
        ...((o.daily || o.hourly) ? { day: (time || iso(t)).slice(0, 10) } : {}),
        ...(o.hourly && time ? { hour: time.slice(0, 13) } : {}),
      });
    }
    log(`${iso(t).slice(0, 10)} ok (${got.length} groups)`);
  }
  if (truncated.length) log(`WARNING: more than ${maxRows} method+path+status groups on ${truncated.join(', ')} — only the biggest kept. Narrow with --service / --access-filter or raise --max-rows.`);

  // 3. error texts behind 5xx: other records (app logs) in the same traces
  let errors = null;
  if (o.errors) {
    if (!F.traceField) log('No trace id field found — error texts skipped. Pass --trace-field.');
    else {
      if (/request/i.test(F.traceField)) log(`Note: ${plain(F.traceField)} is a request id set by clients; error texts are taken only from records that share it.`);
      // the usage table is the main result: a failure here must not lose it
      try { errors = await collectVlErrors(request, { ...F, traceField: F.traceField, base, errorField: o.errorField || '_msg', hours: o.errorHours ?? 24, now, keep: o.keep ? new Set(o.keep) : undefined }); }
      catch (e) { log(`Error texts skipped: ${plain(String(/** @type {Error} */ (e).message)).slice(0, 200)}`); }
    }
  }
  return { rows, truncated, fields: F, errors };
}

/**
 * @param {VlRequest} request
 * @param {{ methodField: string, pathField: string, statusField: string, traceField: string, errorField: string, base: string, hours: number, now: number, top?: number, keep?: Set<string> }} o
 */
export async function collectVlErrors(request, o) {
  const iso = (/** @type {number} */ t) => new Date(t).toISOString();
  const range = { start: iso(o.now - o.hours * 3600e3), end: iso(o.now) };
  const m = fq(o.methodField), p = fq(o.pathField), s = fq(o.statusField), tr = fq(o.traceField), ef = fq(o.errorField);
  const topQ = `${o.base} ${s}:>=500 ${tr}:* | ${foldPipes(o.pathField)} | stats by (${m}, ${p}) count() e5, uniq_values(${tr}) limit 300 traces | sort by (e5 desc) | limit ${o.top ?? 5}`;
  const top = parseLines(await request('/select/logsql/query', { query: topQ, ...range }));
  const endpoints = [];
  for (const b of top) {
    const traces = jsonArray(b.traces).map(String).filter(goodTraceId);
    const messages = [];
    if (traces.length) {
      // not limited to the service: the error is usually written by the app behind the gateway
      const q = `${tr}:in(${traces.map((x) => JSON.stringify(x)).join(',')}) -${s}:* ${ef}:* | stats by (${ef}) count() n, min(_time) first, uniq_values(${tr}) limit 1 ex | sort by (n desc) | limit 50`;
      /** @type {Map<string, { text: string, count: number, firstSeen: string, trace: string }>} */
      const grouped = new Map();
      for (const x of parseLines(await request('/select/logsql/query', { query: q, ...range }))) {
        const text = maskText(String(x[o.errorField] ?? ''));
        if (!text.trim()) continue;
        const g = grouped.get(text) || { text, count: 0, firstSeen: String(x.first || ''), trace: String(jsonArray(x.ex)[0] ?? '').slice(0, 80) };
        g.count += Number(x.n) || 0;
        if (x.first && String(x.first) < g.firstSeen) g.firstSeen = String(x.first);
        grouped.set(text, g);
      }
      messages.push(...[...grouped.values()].sort((a, c) => c.count - a.count).slice(0, 8));
    }
    const m0 = String(b[o.methodField] || '').toUpperCase();
    endpoints.push({ method: /^[A-Z]{1,10}$/.test(m0) ? m0 : 'OTHER', path: cleanText(templatePath(String(b[o.pathField] || ''), { keep: o.keep })), errors5xx: Number(b.e5) || 0, traces: traces.length, messages });
  }
  return {
    since: `last ${o.hours} h`,
    note: `Records without a status in the same traces as the 5xx responses (up to 300 traces per endpoint), last ${o.hours} h. Digits, UUIDs and e-mails masked.`,
    fields: { trace: o.traceField, error: o.errorField },
    endpoints,
  };
}

/** @param {string} body */
function parseLines(body) {
  const out = [];
  for (const line of String(body).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return out;
}

/** /select/logsql/field_names → [{value, hits}] @param {string} body */
function parseFieldNames(body) {
  try {
    const j = JSON.parse(body);
    return (Array.isArray(j?.values) ? j.values : []).map((/** @type {any} */ x) => ({ value: String(x.value), hits: Number(x.hits) || 0 }));
  } catch { return []; }
}

/**
 * HTTP request for the CLI. Auth: VL_AUTH env (whole Authorization header value, e.g. "Basic …" or "Bearer …").
 * Multi-tenant: tenant "AccountID:ProjectID".
 * @param {string} url @param {{ tenant?: string, timeoutMs?: number }} [o] @returns {VlRequest}
 */
export function httpRequest(url, o = {}) {
  const baseUrl = String(url).replace(/\/+$/, '').replace(/\/select\/logsql.*$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('--url must start with http:// or https://');
  const auth = process.env.VL_AUTH;
  const host = new URL(baseUrl).hostname;
  if (auth && /^http:/i.test(baseUrl) && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(host)) throw new Error('VL_AUTH over plain http would send the password in clear text. Use https://, or an SSH tunnel to http://localhost.');
  const [acc, proj] = String(o.tenant || '').split(':');
  return async (path, params) => {
    const r = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-encoding': 'gzip', ...(auth ? { authorization: auth } : {}), ...(acc ? { AccountID: acc, ProjectID: proj || '0' } : {}) },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(o.timeoutMs ?? 180_000),
      redirect: 'error',
    }).catch((e) => { throw new Error(`cannot reach VictoriaLogs at ${baseUrl}: ${plain(e?.cause?.code || e?.cause?.message || e?.message || e).slice(0, 120)}`); });
    const text = await r.text();
    if (!r.ok) throw new Error(`VictoriaLogs HTTP ${r.status}: ${plain(text.split('\n')[0]).slice(0, 200)}`);
    return text;
  };
}
