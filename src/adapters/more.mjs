// @ts-check
// More sources. None uses the network: they print a query and parse the saved response.
// Response shapes follow vendor docs; NOT yet verified on real accounts (except generic CSV).

import { templatePath } from '../template.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { splitJson } from './elasticsearch.mjs';
import { appinsights } from './others.mjs';
import { parseCsv } from '../usage.mjs';

/** @typedef {import('./others.mjs').Q & { map?: string }} Q */

// ---------- Generic CSV with column mapping (Splunk, Athena, BigQuery, any export) ----------
const ALIASES = {
  method: ['method', 'http_method', 'request_method', 'httpmethod', 'request_verb', 'verb', 'requestmethod', 'http.request.method', 'cs_method'],
  path: ['path', 'uri_path', 'url_path', 'route', 'http_route', 'endpoint', 'uri', 'url', 'request_path', 'requesturl', 'request_url', 'http.route', 'url.path', 'cs_uri_stem', 'name'],
  calls: ['calls', 'count', 'hits', 'requests', 'count_', 'c', 'total', 'doc_count', 'count(*)'],
  status: ['status', 'status_code', 'http_status', 'resultcode', 'response_code', 'elb_status_code', 'sc_status', 'code', 'http.response.status_code'],
  first_seen: ['first_seen', 'firstseen', 'min_time', 'first', 'min(_time)', 'earliest'],
  last_seen: ['last_seen', 'lastseen', 'max_time', 'last', 'max(_time)', 'latest'],
  day: ['day', 'date', '_time', 'timestamp', 'time'],
};

export const csv = {
  query() {
    return [
      '# Any tool that can export a table: CSV with a header row.',
      '# Columns are found by common names (method/http_method/request_verb, path/uri_path/route/url, calls/count/hits, status/status_code/elb_status_code, first_seen/last_seen).',
      '# Override with --map method=<col>,path=<col>,calls=<col>,status=<col>,first_seen=<col>,last_seen=<col>',
      '# Then: api-dead-ends convert csv export.csv -o usage.csv',
    ].join('\n');
  },
  /** @param {string} text @param {Q} o */
  parse(text, o = {}) {
    const rows = parseCsv(text.replace(/^﻿/, '').trim());
    const head = rows[0].map((h) => h.trim().replace(/^"|"$/g, ''));
    const lower = head.map((h) => h.toLowerCase());
    /** @type {Record<string, string>} */
    const forced = Object.fromEntries(String(o.map || '').split(',').filter(Boolean).map((kv) => kv.split('=').map((x) => x.trim())));
    const unknown = Object.keys(forced).filter((k) => !(k in ALIASES));
    if (unknown.length) throw new Error(`CSV --map: unknown key ${unknown.join(', ')}. Use: ${Object.keys(ALIASES).join(', ')} (for a single timestamp column map it to first_seen and last_seen)`);
    /** @type {Record<string, number>} */
    const idx = {};
    for (const [k, names] of Object.entries(ALIASES)) {
      const want = forced[k];
      idx[k] = want ? head.indexOf(want) : lower.findIndex((h) => names.includes(h));
      if (want && idx[k] < 0) throw new Error(`CSV: no column "${want}" for ${k} (have: ${head.join(', ')})`);
    }
    if (idx.path < 0) throw new Error(`CSV: no path column (have: ${head.join(', ')}). Use --map path=<col>`);
    return rows.slice(1).filter((r) => r.length > 1 || r[0]).map((r) => {
      const get = (/** @type {string} */ k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
      let method = get('method');
      let path = get('path');
      if (!method && /^[A-Z]+ \//.test(path)) [method, path] = [path.split(' ')[0], path.slice(path.indexOf(' ') + 1)];
      const calls = idx.calls >= 0 ? Number(get('calls')) || 0 : 1;
      const st = get('status');
      const day = iso(get('day'));
      return { method, path, calls, first_seen: iso(get('first_seen')) || day, last_seen: iso(get('last_seen')) || day, status: !st ? '' : st.includes(':') ? st : `${st}:${calls}`, ...(day ? { day: day.slice(0, 10) } : {}) };
    });
  },
};

// ---------- Splunk ----------
export const splunk = {
  /** @param {Q} o */
  query(o = {}) {
    const m = o.methodField || 'method', p = o.pathField || 'uri_path', s = o.statusField || 'status';
    return [
      '# Splunk Search: field names depend on your sourcetype (access_combined: method, uri_path, status).',
      `${o.index ? `index=${o.index} ` : 'index=<index> '}${o.service ? `${o.serviceField || 'service'}="${o.service}" ` : ''}earliest=-${o.days ?? 30}d`,
      `| stats count AS calls min(_time) AS first_seen max(_time) AS last_seen BY ${m} ${p} ${s}`,
      '| eval first_seen=strftime(first_seen, "%Y-%m-%dT%H:%M:%SZ"), last_seen=strftime(last_seen, "%Y-%m-%dT%H:%M:%SZ")',
      `# Export → CSV, then: api-dead-ends convert splunk export.csv --map method=${m},path=${p},status=${s}`,
    ].join('\n');
  },
  /** CSV export or JSON export ({"result":{...}} per line). @param {string} text @param {Q} o */
  parse(text, o = {}) {
    const t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      const recs = splitJson(t).flatMap((d) => (Array.isArray(d) ? d : d.results ?? (d.result ? [d.result] : [d])));
      const cols = [...new Set(recs.flatMap((r) => Object.keys(r)))];
      const q = (/** @type {unknown} */ v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      return csv.parse([cols.join(','), ...recs.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n'), { map: o.map || defaultMap(o, 'uri_path') });
    }
    return csv.parse(t, { map: o.map || defaultMap(o, '') });
  },
};

// ---------- Datadog APM metrics (long history: usually 15 months) ----------
export const datadogApm = {
  /** @param {Q} o */
  query(o = {}) {
    const metric = o.metric || 'trace.http.request.hits';
    const days = o.days ?? 90;
    const q = `sum:${metric}{${o.service ? `service:${o.service}` : '*'}} by {resource_name,http.status_code}.as_count().rollup(sum, 86400)`;
    return [
      '# Datadog APM trace metrics — months of history, the best source for "not seen".',
      '# The operation name in the metric depends on the tracer: trace.http.request.hits (Go net/http), trace.servlet.request.hits (Java),',
      '# trace.aspnet_core.request.hits (.NET), trace.express.request.hits (Node), trace.flask.request.hits / trace.django.request.hits (Python),',
      '# trace.rack.request.hits (Ruby). Find yours in Metrics Explorer: trace.*.hits for the service. Override with --metric.',
      `curl -sS --get 'https://api.datadoghq.com/api/v1/query' -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \\`,
      `  --data-urlencode "from=$(( $(date +%s) - ${days} * 86400 ))" --data-urlencode "to=$(date +%s)" \\`,
      `  --data-urlencode 'query=${q}' > datadog-apm.json`,
      '# Then: api-dead-ends convert datadog-apm datadog-apm.json',
      '# Note: resource_name in tags is normalized (lowercase, some characters → "_"). For exact names use the Spans API (datadog source, ~15 days).',
    ].join('\n');
  },
  /** @param {string} text @param {{ daily?: boolean }} [o] */
  parse(text, o = {}) {
    const out = [];
    for (const d of splitJson(text)) {
      if (!Array.isArray(d?.series)) throw new Error('Datadog metrics: no series in the response');
      for (const s of d.series) {
        const tags = Object.fromEntries(String(s.scope || '').split(',').concat(s.tag_set || []).map((t) => [t.slice(0, t.indexOf(':')), t.slice(t.indexOf(':') + 1)]));
        const { method, path } = splitResource(tags.resource_name || '');
        let calls = 0, first = '', last = '';
        for (const [ms, val] of s.pointlist || []) {
          const n = Number(val);
          if (!(n > 0)) continue;
          calls += n;
          const t = new Date(Number(ms)).toISOString();
          if (!first) first = t;
          last = t;
        }
        calls = Math.round(calls);
        if (!calls || !path) continue;
        const st = tags['http.status_code'];
        if (o.daily) {
          for (const [ms, val] of s.pointlist || []) {
            const n = Math.round(Number(val));
            if (!(n > 0)) continue;
            const t = new Date(Number(ms)).toISOString();
            out.push({ method, path, calls: n, first_seen: t, last_seen: t, day: t.slice(0, 10), status: st ? `${st}:${n}` : '' });
          }
        } else out.push({ method, path, calls, first_seen: first, last_seen: last, status: st ? `${st}:${calls}` : '' });
      }
    }
    return out;
  },
};

/** "get_/api/v1/orders/_id_" or "GET /api/v1/orders/{id}" → { method, path } */
export function splitResource(/** @type {string} */ r) {
  const m = r.match(/^([a-zA-Z]+)[ _](\/.*)$/);
  if (!m) return { method: '', path: r.startsWith('/') ? r : '' };
  const path = m[2].split('/').map((seg) => (/^_[a-z0-9_]*_$/i.test(seg) || /^\{.+\}$/.test(seg) || /^:\w+$/.test(seg) ? '{id}' : seg)).join('/');
  return { method: m[1].toUpperCase(), path };
}

// ---------- New Relic (NRQL via NerdGraph) ----------
export const newrelic = {
  /** @param {Q} o */
  query(o = {}) {
    const app = o.service ? ` WHERE appName = '${o.service.replace(/'/g, '')}'` : '';
    const days = o.days ?? 30;
    return [
      '# New Relic. Option A — Transaction events (exact, retention usually 8 days, 30+ with Data Plus):',
      `SELECT count(*) AS calls, earliest(timestamp) AS first_seen, latest(timestamp) AS last_seen FROM Transaction${app} FACET request.method, name, http.statusCode SINCE ${Math.min(days, 30)} days ago LIMIT MAX`,
      '# Option B — metric timeslices (13 months, call counts per transaction name):',
      `SELECT count(newrelic.timeslice.value) AS calls FROM Metric${app ? `${app} AND` : ' WHERE'} metricTimesliceName LIKE 'WebTransaction/%' FACET metricTimesliceName SINCE ${days} days ago LIMIT MAX`,
      '# Run in Query Builder → export JSON, or NerdGraph: { actor { account(id: <id>) { nrql(query: "...") { results } } } } > newrelic.json',
      '# Then: api-dead-ends convert newrelic newrelic.json',
    ].join('\n');
  },
  /** @param {string} text */
  parse(text) {
    const out = [];
    for (const d of splitJson(text)) {
      const results = d?.data?.actor?.account?.nrql?.results ?? d?.results ?? (Array.isArray(d) ? d : null);
      if (!Array.isArray(results)) throw new Error('New Relic: no results in the response');
      for (const r of results) {
        const facet = Array.isArray(r.facet) ? r.facet : [r.facet ?? r.name ?? r.metricTimesliceName];
        const calls = Number(r.calls ?? r.count ?? r['count(*)'] ?? 0);
        let method = r['request.method'] ?? (facet.length >= 3 ? facet[0] : '');
        let name = String(r.name ?? r.metricTimesliceName ?? (facet.length >= 3 ? facet[1] : facet[0]) ?? '');
        name = name.replace(/^WebTransaction\/[^/]+\//, '');
        let mm;
        if ((mm = name.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\/+(.*)$/))) [method, name] = [mm[1], `/${mm[2]}`]; // Expressjs/GET//orders/:id
        if (/^[A-Z]+ \//.test(name)) [method, name] = [name.split(' ')[0], name.slice(name.indexOf(' ') + 1)];
        else if (!name.startsWith('/')) name = `/${name}`;
        const st = r['http.statusCode'] ?? (facet.length >= 3 ? facet[2] : '');
        out.push({ method: method || '', path: name, calls, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen), status: st ? `${st}:${calls}` : '' });
      }
    }
    return out;
  },
};

// ---------- Dynatrace Grail (DQL) ----------
export const dynatrace = {
  /** @param {Q} o */
  query(o = {}) {
    return [
      '# Dynatrace Notebooks / DQL (Grail). Span retention depends on your bucket settings.',
      `fetch spans, from: now()-${o.days ?? 30}d`,
      `| filter isNotNull(http.route)${o.service ? ` and service.name == "${o.service.replace(/"/g, '')}"` : ''}`,
      '| summarize calls = count(), first_seen = min(start_time), last_seen = max(start_time), by: {http.request.method, http.route, http.response.status_code}',
      '# Download result as JSON or CSV, then: api-dead-ends convert dynatrace result.json',
    ].join('\n');
  },
  /** @param {string} text */
  parse(text) {
    const t = text.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return csv.parse(t, { map: '' });
    const out = [];
    for (const d of splitJson(t)) {
      const recs = d?.result?.records ?? d?.records ?? (Array.isArray(d) ? d : null);
      if (!Array.isArray(recs)) throw new Error('Dynatrace: no records in the response');
      for (const r of recs) {
        const calls = Number(r.calls ?? r['count()'] ?? 0);
        const st = r['http.response.status_code'];
        out.push({ method: r['http.request.method'] || '', path: r['http.route'] || '', calls, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen), status: st ? `${st}:${calls}` : '' });
      }
    }
    return out;
  },
};

// ---------- SQL sources: AWS Athena (ALB logs), Google BigQuery (load balancer logs) ----------
export const athena = {
  /** @param {Q} o */
  query(o = {}) {
    return [
      '-- AWS Athena over ALB access logs (table created per AWS docs). Exported CSV goes to `convert csv`.',
      'SELECT request_verb AS method, url_extract_path(request_url) AS path, elb_status_code AS status,',
      '       count(*) AS calls, min(time) AS first_seen, max(time) AS last_seen',
      `FROM ${o.index || 'alb_logs'}`,
      `WHERE from_iso8601_timestamp(time) > current_timestamp - interval '${o.days ?? 30}' day`,
      'GROUP BY 1, 2, 3;',
      '-- Then: api-dead-ends convert athena results.csv   (ALB logs are best-effort per AWS docs)',
    ].join('\n');
  },
  /** @param {string} text @param {Q} o */
  parse: (text, o = {}) => csv.parse(text, o),
};

export const bigquery = {
  /** @param {Q} o */
  query(o = {}) {
    return [
      '-- Google BigQuery over Cloud Logging export of the HTTP(S) Load Balancer (requests table).',
      'SELECT httpRequest.requestMethod AS method,',
      "       REGEXP_EXTRACT(httpRequest.requestUrl, r'^https?://[^/]+([^?#]*)') AS path,",
      '       httpRequest.status AS status, COUNT(*) AS calls, MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen',
      `FROM \`${o.index || '<project>.<dataset>.requests_*'}\``,
      `WHERE timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${o.days ?? 30} DAY)`,
      'GROUP BY 1, 2, 3;',
      '-- Save results as CSV, then: api-dead-ends convert bigquery results.csv',
    ].join('\n');
  },
  /** @param {string} text @param {Q} o */
  parse: (text, o = {}) => csv.parse(text, o),
};

// ---------- Azure API Management (Log Analytics) ----------
export const azureApim = {
  /** @param {Q} o */
  query(o = {}) {
    return [
      '# Azure API Management → Logs (resource-specific table ApiManagementGatewayLogs).',
      'ApiManagementGatewayLogs',
      `| where TimeGenerated > ago(${o.days ?? 30}d)`,
      ...(o.service ? [`| where ApiId == "${o.service.replace(/"/g, '')}"`] : []),
      '| extend path = tostring(parse_url(Url).Path)',
      '| summarize calls = count(), first_seen = min(TimeGenerated), last_seen = max(TimeGenerated) by name = strcat(Method, " ", path), resultCode = tostring(ResponseCode)',
      '# Export CSV (or az monitor log-analytics query -o json), then: api-dead-ends convert azure-apim result.json',
    ].join('\n');
  },
  /** @param {string} text */
  parse: (text) => appinsights.parse(text),
};

// ---------- Raw access logs: nginx/Apache combined and common, JSON lines ----------
const COMBINED = /^\S+ \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^ "]+)[^"]*" (\d{3}) /;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/**
 * One log line → { method, path, status, time } or null. IP, UA and query are not kept.
 * @param {string} line
 */
export function parseAccessLine(line) {
  const t = line.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    let j;
    try { j = JSON.parse(t); } catch { return null; }
    const g = (/** @type {string[]} */ ks) => { for (const k of ks) { const v = k.split('.').reduce((a, x) => (a == null ? a : a[x]), j); if (v != null && v !== '') return String(v); } return ''; };
    let method = g(['method', 'request_method', 'http.request.method', 'http.method', 'req.method', 'httpMethod', 'verb']);
    let path = g(['path', 'request_uri', 'uri', 'url.path', 'url.original', 'http.route', 'req.url', 'url', 'request_path', 'route']);
    const req = g(['request']);
    if ((!method || !path) && /^[A-Z]+ \S+/.test(req)) [method, path] = req.split(' ');
    if (!path) return null;
    return { method, path, status: g(['status', 'status_code', 'http.response.status_code', 'res.statusCode', 'response_code']), time: g(['time', 'timestamp', '@timestamp', 'time_iso8601', 'ts']) };
  }
  const m = t.match(COMBINED);
  if (!m) return null;
  return { method: m[2], path: m[3], status: m[4], time: clfTime(m[1]) };
}

/** "10/Oct/2026:13:55:36 +0000" → ISO */
function clfTime(/** @type {string} */ s) {
  const m = s.match(/^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/);
  if (!m) return '';
  const mon = MONTHS[/** @type {keyof typeof MONTHS} */ (m[2])];
  if (mon == null) return '';
  const off = (Number(m[7].slice(0, 3)) * 60 + Math.sign(Number(m[7].slice(0, 3)) || 1) * Number(m[7].slice(3))) * 60e3;
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - off).toISOString();
}

const MAX_LINE = 64 * 1024;

/**
 * Split a byte stream into lines without ever holding more than MAX_LINE bytes of one line
 * (a 1 MB .gz can expand into a single multi-GB line). Over-long lines are yielded as null.
 * @param {AsyncIterable<Buffer>} input
 */
async function* boundedLines(input) {
  let buf = '';
  let skipping = false;
  for await (const chunk of input) {
    let s = chunk.toString('utf8');
    while (s.length) {
      const i = s.indexOf('\n');
      const part = i < 0 ? s : s.slice(0, i);
      s = i < 0 ? '' : s.slice(i + 1);
      if (!skipping) {
        buf += part;
        if (buf.length > MAX_LINE) { skipping = true; buf = ''; }
      }
      if (i >= 0) {
        if (skipping) { yield null; skipping = false; } else yield buf.replace(/\r$/, '');
        buf = '';
      }
    }
  }
  if (skipping) yield null; else if (buf) yield buf;
}

export const accesslog = {
  query() {
    return [
      '# Raw access logs on disk: nginx/Apache "combined" or "common", or JSON lines (one object per line). .gz is fine.',
      '# Processed locally and streamed; IPs, user agents and query strings are dropped while reading.',
      '# api-dead-ends convert accesslog /var/log/nginx/access.log* -o usage.csv',
    ].join('\n');
  },
  /** For small texts (tests). @param {string} text */
  parse(text) {
    return text.split('\n').map(parseAccessLine).filter(Boolean).map((r) => toRow(/** @type {any} */ (r)));
  },
  /**
   * Streaming read of files (.gz supported), aggregated through onRow.
   * @param {string[]} files
   * @param {(row: any) => void} onRow
   */
  async stream(files, onRow, opt = {}) {
    let lines = 0, bad = 0;
    const dup = opt.duplicates ? new Duplicates(opt.duplicates) : null;
    for (const f of files) {
      const src = createReadStream(f);
      const input = f.endsWith('.gz') ? src.pipe(createGunzip()) : src;
      for await (const line of boundedLines(input)) {
        lines++;
        if (line === null) { bad++; continue; } // longer than MAX_LINE: skipped, never buffered
        const r = parseAccessLine(line);
        if (r) { onRow(toRow(r)); dup?.add(r, line); } else if (line.trim()) bad++;
      }
    }
    return { lines, bad, ...(dup ? { duplicates: dup.result() } : {}) };
  },
};

/**
 * Repeated non-GET requests from access logs: same client, method and exact path within N seconds.
 * The client is a hash of IP + user agent, kept in memory only and never written out.
 * Access logs have no request bodies, so this is an upper bound ("possibly the same request").
 */
class Duplicates {
  /** @param {{ windowSec?: number, keep?: Set<string> }} o */
  constructor(o) {
    this.win = (o.windowSec ?? 2) * 1000;
    this.keep = o.keep;
    /** @type {Map<string, { t: number, status: string }>} */
    this.last = new Map();
    /** @type {Map<string, { method: string, path: string, calls: number, repeats: number, afterError: number }>} */
    this.by = new Map();
  }
  /** @param {{ method: string, path: string, status: string, time: string }} r @param {string} line */
  add(r, line) {
    const method = String(r.method || '').toUpperCase();
    if (!method || method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const t = Date.parse(r.time);
    if (!Number.isFinite(t)) return;
    const tpl = templatePath(r.path, { keep: this.keep });
    const agg = this.by.get(`${method} ${tpl}`) || { method, path: tpl, calls: 0, repeats: 0, afterError: 0 };
    agg.calls++;
    const key = `${clientOf(line)} ${method} ${String(r.path).split(/[?#]/)[0]}`;
    const prev = this.last.get(key);
    if (prev && t - prev.t <= this.win) { agg.repeats++; if (Number(prev.status) >= 400) agg.afterError++; }
    this.last.set(key, { t, status: r.status });
    this.by.set(`${method} ${tpl}`, agg);
    if (this.last.size > 200000) this.last.clear(); // bound memory on huge logs (keeps working on newer lines)
  }
  result() {
    const rows = [...this.by.values()].filter((x) => x.repeats > 0).sort((a, b) => b.repeats - a.repeats)
      .map((x) => ({ ...x, withinSeconds: this.win / 1000, note: x.afterError ? `${x.afterError} after an error response (retries?)` : 'blind repeats: double click or client retry without an error' }));
    return { source: 'access logs', windowSec: this.win / 1000, note: `Same client (IP + user agent), method and path within ${this.win / 1000} s. Access logs have no request bodies, so this is an upper bound.`, rows };
  }
}

/** Short in-memory hash of client IP + user agent (never stored). @param {string} line */
function clientOf(line) {
  let ip = '', ua = '';
  const t = line.trim();
  if (t.startsWith('{')) {
    try { const j = JSON.parse(t); ip = String(j.remote_addr ?? j.client_ip ?? j['client.ip'] ?? j.ip ?? ''); ua = String(j.http_user_agent ?? j.user_agent ?? j['user_agent.original'] ?? ''); } catch { /* ignore */ }
  } else {
    ip = t.split(' ')[0];
    const q = t.match(/"([^"]*)"\s*$/);
    ua = q ? q[1] : '';
  }
  return createHash('sha256').update(ip + '|' + ua).digest('base64').slice(0, 12);
}

/** @param {{ method: string, path: string, status: string, time: string }} r */
function toRow(r) {
  return { method: r.method, path: r.path, calls: 1, first_seen: r.time, last_seen: r.time, status: r.status ? `${r.status}:1` : '' };
}

/** @param {Q} o @param {string} path */
function defaultMap(o, path) {
  const parts = [];
  if (o.methodField) parts.push(`method=${o.methodField}`);
  if (o.pathField || path) parts.push(`path=${o.pathField || path}`);
  if (o.statusField) parts.push(`status=${o.statusField}`);
  return parts.join(',');
}

/** @param {unknown} v */
function iso(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number' || /^\d{10,13}(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const s = String(v).trim().replace(' ', 'T');
  const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}
