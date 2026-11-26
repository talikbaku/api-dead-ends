// @ts-check
// Adapters without network access: they print a query that the user runs,
// and parse the saved response. Response formats come from vendor docs — not yet verified
// on real Datadog / App Insights / Prometheus / Loki / CloudWatch accounts.

import { parseCsv } from '../usage.mjs';
import { splitJson } from './elasticsearch.mjs';

/**
 * @typedef {{ service?: string, days?: number, methodField?: string, pathField?: string, statusField?: string, serviceField?: string, metric?: string, preset?: string, index?: string }} Q
 */

// ---------- Datadog Logs / Spans aggregate API ----------
export const datadog = {
  /** @param {Q} o */
  query(o = {}) {
    const m = o.methodField || '@http.method';
    const p = o.pathField || '@http.url_details.path';
    const s = o.statusField || '@http.status_code';
    const body = {
      compute: [{ aggregation: 'count', type: 'total' }],
      filter: { from: `now-${o.days ?? 15}d`, to: 'now', query: o.service ? `service:${o.service}` : '*' },
      group_by: [
        { facet: m, limit: 20, sort: { aggregation: 'count', order: 'desc' } },
        { facet: p, limit: 10000, sort: { aggregation: 'count', order: 'desc' } },
        { facet: s, limit: 20, sort: { aggregation: 'count', order: 'desc' } },
      ],
    };
    return [
      '# Datadog Logs Aggregate API (needs DD_API_KEY + DD_APP_KEY with logs_read_data). Site may differ: datadoghq.eu, us3., us5.',
      '# For APM spans use /api/v2/spans/analytics/aggregate with facets resource_name / @http.status_code (span retention is usually 15 days).',
      "curl -sS -X POST 'https://api.datadoghq.com/api/v2/logs/analytics/aggregate' \\",
      "  -H 'Content-Type: application/json' -H \"DD-API-KEY: $DD_API_KEY\" -H \"DD-APPLICATION-KEY: $DD_APP_KEY\" \\",
      `  -d '${JSON.stringify(body)}' > datadog.json`,
      '# Then: api-dead-ends convert datadog datadog.json  (if the response has meta.page.after, repeat with "page":{"cursor":...})',
    ].join('\n');
  },
  /** @param {string} text @param {Q} o */
  parse(text, o = {}) {
    const out = [];
    for (const d of splitJson(text)) {
      const buckets = d?.data?.buckets ?? d?.buckets;
      if (!Array.isArray(buckets)) throw new Error('Datadog: no data.buckets in the response');
      for (const b of buckets) {
        const by = b.by || {};
        const method = pick(by, [o.methodField, '@http.method', 'http.method']);
        let path = pick(by, [o.pathField, '@http.url_details.path', 'resource_name', '@http.route']);
        let m2 = method;
        if (!m2 && /^[A-Z]+ \//.test(path)) [m2, path] = [path.split(' ')[0], path.slice(path.indexOf(' ') + 1)];
        const status = pick(by, [o.statusField, '@http.status_code', 'http.status_code']);
        const calls = Number(Object.values(b.computes || {})[0] ?? 0);
        out.push({ method: m2, path, calls, status: status ? `${status}:${calls}` : '' });
      }
    }
    return out;
  },
};

// ---------- Azure Application Insights / Log Analytics (KQL) ----------
export const appinsights = {
  /** @param {Q} o */
  query(o = {}) {
    const kql = [
      'requests',
      `| where timestamp > ago(${o.days ?? 15}d)`,
      ...(o.service ? [`| where cloud_RoleName == "${o.service.replace(/"/g, '')}"`] : []),
      '| summarize calls = count(), first_seen = min(timestamp), last_seen = max(timestamp) by name, resultCode',
    ].join('\n');
    return [
      '# Azure Portal → Application Insights → Logs: run the KQL below and export CSV,',
      '# or CLI: az monitor app-insights query --app <app-id> --analytics-query "<kql>" -o json > appinsights.json',
      '# `name` is usually "GET /api/orders/{id}" (route template in ASP.NET Core).',
      kql,
      '# Then: api-dead-ends convert appinsights appinsights.json   (CSV export also works)',
    ].join('\n');
  },
  /** @param {string} text */
  parse(text) {
    const t = text.trim();
    /** @type {Array<Record<string, any>>} */
    let recs = [];
    if (t.startsWith('{') || t.startsWith('[')) {
      const d = JSON.parse(t);
      const tables = d.tables || d.Tables || (Array.isArray(d) ? null : [d]);
      if (tables) {
        for (const tb of tables) {
          const cols = (tb.columns || tb.Columns).map((/** @type {any} */ c) => c.name || c.ColumnName);
          for (const row of tb.rows || tb.Rows) recs.push(Object.fromEntries(cols.map((/** @type {string} */ c, /** @type {number} */ i) => [c, row[i]])));
        }
      } else recs = d;
    } else {
      const rows = parseCsv(t.replace(/^\uFEFF/, '').trim());
      const head = rows[0].map((h) => h.trim());
      recs = rows.slice(1).filter((r) => r.length > 1 || r[0]).map((r) => Object.fromEntries(r.map((v, i) => [head[i], v])));
    }
    return recs.map((r) => {
      const name = String(r.name ?? r.operation_Name ?? '');
      const sp = name.indexOf(' ');
      const method = /^[A-Z]+$/.test(name.slice(0, sp)) ? name.slice(0, sp) : '';
      const path = method ? name.slice(sp + 1) : name;
      const calls = Number(r.calls ?? r.count_ ?? 0);
      return { method, path, calls, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen), status: r.resultCode != null ? `${r.resultCode}:${calls}` : '' };
    });
  },
};

// ---------- Prometheus (and anything that speaks PromQL: Thanos, Mimir, VictoriaMetrics, Grafana Cloud) ----------
// Presets for popular HTTP metrics. Label names come from library docs [not verified on real installations].
export const PROM_PRESETS = {
  otel: { metric: 'http_server_request_duration_seconds_count', method: 'http_request_method', path: 'http_route', status: 'http_response_status_code', service: 'service_name', note: 'OpenTelemetry semantic conventions (new, stable)' },
  'otel-old': { metric: 'http_server_duration_milliseconds_count', method: 'http_method', path: 'http_route', status: 'http_status_code', service: 'service_name', note: 'OpenTelemetry semconv before 1.20' },
  spanmetrics: { metric: 'traces_span_metrics_calls_total', method: 'http_method', path: 'span_name', status: 'http_status_code', service: 'service_name', note: 'OTel Collector spanmetrics connector (span_name is often "GET /route")' },
  spring: { metric: 'http_server_requests_seconds_count', method: 'method', path: 'uri', status: 'status', service: 'application', note: 'Spring Boot / Micrometer' },
  'prometheus-net': { metric: 'http_requests_received_total', method: 'method', path: 'endpoint', status: 'code', service: 'job', note: 'ASP.NET Core prometheus-net (endpoint needs route template)' },
  'go-promhttp': { metric: 'http_requests_total', method: 'method', path: 'handler', status: 'code', service: 'job', note: 'Go promhttp middleware (handler label is whatever you set)' },
  express: { metric: 'http_request_duration_seconds_count', method: 'method', path: 'path', status: 'status_code', service: 'job', note: 'Node express-prom-bundle' },
  fastapi: { metric: 'http_requests_total', method: 'method', path: 'handler', status: 'status', service: 'job', note: 'prometheus-fastapi-instrumentator' },
  'nginx-ingress': { metric: 'nginx_ingress_controller_requests', method: 'method', path: 'path', status: 'status', service: 'ingress', note: 'ingress-nginx: path is the Ingress rule path, not the request path' },
  traefik: { metric: 'traefik_service_requests_total', method: 'method', path: 'service', status: 'code', service: 'service', note: 'Traefik: no request path label — only per service' },
  generic: { metric: 'http_requests_total', method: 'method', path: 'route', status: 'status', service: 'service', note: 'generic' },
};

/** @param {Q & { preset?: string }} o */
function promCfg(o) {
  const p = PROM_PRESETS[/** @type {keyof typeof PROM_PRESETS} */ (o.preset || 'generic')];
  if (!p) throw new Error(`Unknown --preset "${o.preset}". Use: ${Object.keys(PROM_PRESETS).join(', ')}`);
  return { metric: o.metric || p.metric, m: o.methodField || p.method, p: o.pathField || p.path, s: o.statusField || p.status, svc: o.serviceField || p.service, note: p.note };
}

export const prometheus = {
  /** @param {Q & { preset?: string }} o */
  query(o = {}) {
    const c = promCfg(o);
    const days = o.days ?? 30;
    const sel = o.service ? `{${c.svc}="${o.service}"}` : '';
    const step = /** @type {any} */ (o).hourly ? '1h' : '1d';
    const q = `sum by (${c.m}, ${c.p}, ${c.s}) (increase(${c.metric}${sel}[${step}]))`;
    return [
      `# Prometheus / Thanos / Mimir / VictoriaMetrics — preset: ${o.preset || 'generic'} (${c.note}).`,
      '# Daily buckets (step=1d) give first/last seen and per-day counts. Presets: ' + Object.keys(PROM_PRESETS).join(', '),
      `curl -sS --get 'http://<prometheus>/api/v1/query_range' \\`,
      `  --data-urlencode 'query=${q}' \\`,
      `  --data-urlencode "start=$(( $(date +%s) - ${days} * 86400 ))" --data-urlencode "end=$(date +%s)" --data-urlencode 'step=${/** @type {any} */ (o).hourly ? 3600 : 86400}' > prometheus.json`,
      '# Retention: plain Prometheus often keeps 15 days; Thanos/Mimir/Grafana Cloud keep months — use those for "not seen".',
      `# Then: api-dead-ends convert prometheus prometheus.json${o.preset ? ` --preset ${o.preset}` : ` --method-field ${c.m} --path-field ${c.p} --status-field ${c.s}`}`,
    ].join('\n');
  },
  /** Understands an instant vector (query) and a matrix (query_range: daily values → first/last seen; with o.daily one row per day). @param {string} text @param {Q & { preset?: string, daily?: boolean }} o */
  parse(text, o = {}) {
    const c = promCfg(o);
    const out = [];
    for (const d of splitJson(text)) {
      const res = d?.data?.result;
      if (!Array.isArray(res)) throw new Error('Prometheus/Loki: no data.result in the response');
      for (const r of res) {
        const lab = r.metric || r.stream || {};
        let calls = 0, first = '', last = '';
        if (r.value) calls = Number(r.value[1]);
        else for (const [ts, val] of r.values || []) {
          const n = Number(val);
          if (!(n > 0.5)) continue; // increase() extrapolates: tiny fractions are noise, not calls
          calls += n;
          const iso = new Date(Number(ts) * 1000).toISOString();
          if (!first) first = iso;
          last = iso;
        }
        calls = Math.round(calls);
        if (!calls) continue;
        const st = lab[c.s] ?? lab.code ?? lab.status_code ?? lab.status;
        let method = lab[c.m] ?? '';
        let path = lab[c.p] ?? lab.route ?? lab.path ?? lab.handler ?? lab.uri ?? '';
        if (!method && /^[A-Z]+ \//.test(path)) [method, path] = [path.split(' ')[0], path.slice(path.indexOf(' ') + 1)];
        if ((o.daily || o.hourly) && r.values) {
          for (const [ts, val] of r.values) {
            const n = Math.round(Number(val));
            if (!(Number(val) > 0.5) || !n) continue;
            const t = new Date(Number(ts) * 1000).toISOString();
            out.push({ method, path, calls: n, first_seen: t, last_seen: t, day: t.slice(0, 10), ...(o.hourly ? { hour: t.slice(0, 13) } : {}), status: st ? `${st}:${n}` : '' });
          }
        } else out.push({ method, path, calls, first_seen: first, last_seen: last, status: st ? `${st}:${calls}` : '' });
      }
    }
    return out;
  },
};

export const loki = {
  /** @param {Q} o */
  query(o = {}) {
    const m = o.methodField || 'method', p = o.pathField || 'path', s = o.statusField || 'status';
    const sel = o.service ? `{${o.serviceField || 'service_name'}="${o.service}"}` : '{job=~".+"}';
    return [
      '# Grafana Loki (JSON logs). For logfmt use | logfmt; adjust label names.',
      `curl -sS --get 'http://<loki>/loki/api/v1/query' --data-urlencode 'query=sum by (${m}, ${p}, ${s}) (count_over_time(${sel} | json [${o.days ?? 15}d]))' > loki.json`,
      `# Then: api-dead-ends convert loki loki.json --method-field ${m} --path-field ${p} --status-field ${s}`,
    ].join('\n');
  },
  /** @param {string} text @param {Q} o */
  parse(text, o = {}) {
    return prometheus.parse(text, { ...o, methodField: o.methodField || 'method', pathField: o.pathField || 'path', statusField: o.statusField || 'status' });
  },
};

// ---------- AWS CloudWatch Logs Insights ----------
export const cloudwatch = {
  /** @param {Q} o */
  query(o = {}) {
    const m = o.methodField || 'httpMethod', p = o.pathField || 'path', s = o.statusField || 'status';
    return [
      '# CloudWatch Logs Insights (e.g. API Gateway access logs in JSON). Field names depend on your log format.',
      `# fields ${m}, ${p}, ${s}`,
      `stats count(*) as calls, min(@timestamp) as first_seen, max(@timestamp) as last_seen by ${m}, ${p}, ${s}`,
      `# CLI: aws logs start-query --log-group-name <group> --start-time $(date -v-${o.days ?? 15}d +%s) --end-time $(date +%s) --query-string '<query>'`,
      '#      aws logs get-query-results --query-id <id> > cloudwatch.json',
      `# Then: api-dead-ends convert cloudwatch cloudwatch.json --method-field ${m} --path-field ${p} --status-field ${s}`,
    ].join('\n');
  },
  /** @param {string} text @param {Q} o */
  parse(text, o = {}) {
    const d = JSON.parse(text);
    const m = o.methodField || 'httpMethod', p = o.pathField || 'path', s = o.statusField || 'status';
    return (d.results || []).map((/** @type {any[]} */ row) => {
      const r = Object.fromEntries(row.map((c) => [c.field, c.value]));
      const calls = Number(r.calls || 0);
      return { method: r[m] || '', path: r[p] || '', calls, first_seen: iso(r.first_seen), last_seen: iso(r.last_seen), status: r[s] ? `${r[s]}:${calls}` : '' };
    });
  },
};

/** @param {Record<string, any>} o @param {Array<string|undefined>} keys */
function pick(o, keys) {
  for (const k of keys) if (k && o[k] != null && o[k] !== '') return String(o[k]);
  return '';
}

/** @param {unknown} v */
function iso(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim().replace(' ', 'T');
  const t = Date.parse(/Z|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : String(v);
}

// ---------- VictoriaLogs (LogsQL) ----------
// Typical setup: gateway / nginx JSON access logs shipped by fluent-bit or vector into VictoriaLogs.
export const victorialogs = {
  /** @param {Q & { daily?: boolean }} o */
  query(o = {}) {
    const m = o.methodField || 'method', p = o.pathField || 'path', s = o.statusField || 'status';
    const svc = o.service ? ` ${o.serviceField || 'container_name'}:${o.service}` : '';
    const by = `${o.hourly ? '_time:1h, ' : o.daily ? '_time:1d, ' : ''}${m}, ${p}, ${s}`;
    const q = `_time:${o.days ?? 15}d${svc} ${m}:* ${p}:* | stats by (${by}) count() calls`;
    return [
      '# VictoriaLogs (LogsQL). Fields: adjust --method-field / --path-field / --status-field to your access-log JSON;',
      `# the service filter uses --service-field (default container_name). Check one record in VictoriaLogs UI (vmui) first.`,
      `curl -sS 'http://<victoria-logs>:9428/select/logsql/query' --data-urlencode 'query=${q}' > victorialogs.json`,
      `# Then: api-dead-ends convert victorialogs victorialogs.json${o.daily ? ' --daily' : ''}${o.methodField ? ` --method-field ${m} --path-field ${p} --status-field ${s}` : ''}`,
    ].join('\n');
  },
  /** JSON lines from /select/logsql/query. @param {string} text @param {Q & { daily?: boolean }} o */
  parse(text, o = {}) {
    const m = o.methodField || 'method', p = o.pathField || 'path', s = o.statusField || 'status';
    const out = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let j;
      try { j = JSON.parse(t); } catch { continue; }
      const calls = Number(j.calls ?? j['count(*)'] ?? j.count ?? 0);
      const path = j[p];
      if (!calls || !path) continue;
      const time = j._time ? String(j._time) : '';
      const st = j[s];
      out.push({ method: j[m] || '', path: String(path), calls, first_seen: time, last_seen: time, status: st ? `${st}:${calls}` : '', ...((o.daily || o.hourly) && time ? { day: time.slice(0, 10) } : {}), ...(o.hourly && time ? { hour: time.slice(0, 13) } : {}) });
    }
    if (!out.length && text.trim().startsWith('{') === false) throw new Error('VictoriaLogs: expected JSON lines from /select/logsql/query');
    return out;
  },
};
