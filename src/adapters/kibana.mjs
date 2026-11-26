// @ts-check
// `fetch kibana`: pull the usage table through Kibana when you only have a browser login (no ES URL, no API key).
// You log in yourself in a visible browser; the tool then sends read-only _search requests through Kibana's
// Dev Tools proxy with that session, in 3-hour windows. Nothing is saved to disk (no cookies, no session files),
// errors are truncated (Playwright call logs contain cookies), and only aggregates leave the cluster.
// Verified on a real production Kibana (Elastic 8.x).

import { loadPlaywright } from '../probe.mjs';
import { collect } from './elasticsearch.mjs';
import { collectErrors, pickErrorFields } from './errortexts.mjs';

const HDR = { 'kbn-xsrf': 'true', 'content-type': 'application/json', 'x-elastic-internal-origin': 'Kibana' };
const CANDIDATES = {
  method: ['http.request.method', 'http.method', 'request.method', 'req.method', 'method'],
  path: ['http.route', 'url.path', 'url.original', 'request.uri', 'request_url', 'uri', 'path', 'url'],
  status: ['http.response.status_code', 'http.status_code', 'status_code', 'response.status', 'status'],
};

/**
 * @param {{ url: string, service: string, days?: number, daily?: boolean, hourly?: boolean, errors?: boolean, errorHours?: number, traceField?: string, errorField?: string, dataView?: string, loginTimeoutMin?: number,
 *   methodField?: string, pathField?: string, statusField?: string, serviceField?: string, excludeFilter?: string, accessFilter?: string,
 *   keep?: string[], log?: (s: string) => void }} o
 */
export async function fetchKibana(o) {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('fetch kibana needs Playwright in this folder (npm i -D playwright && npx playwright install chromium), or set API_DEAD_ENDS_PLAYWRIGHT to its path');
  const log = o.log || (() => {});
  const u = new URL(o.url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Kibana URL must be http(s)');
  const base = `${u.origin}${u.pathname.split('/app/')[0]}`.replace(/\/$/, '');
  const dataView = o.dataView || (decodeURIComponent(o.url).match(/dataViewId:'?([0-9a-zA-Z-]{8,})/) || [])[1];
  const browser = await pw.chromium.launch({ headless: false });
  const ctx = await browser.newContext();
  try {
    const page = await ctx.newPage();
    await page.goto(o.url).catch(() => {});
    log('Log in to Kibana in the browser window; the export starts by itself.');
    const getJson = async (/** @type {string} */ path, /** @type {string} */ version) => {
      const r = await ctx.request.get(base + path, { headers: { ...HDR, 'elastic-api-version': version } }).catch(() => null);
      return r && r.ok() ? r.json() : null;
    };
    const deadline = Date.now() + (o.loginTimeoutMin ?? 15) * 60e3;
    let dv = null;
    for (;;) {
      const id = dataView || (decodeURIComponent(page.url()).match(/dataViewId:'?([0-9a-zA-Z-]{8,})/) || [])[1];
      if (id) dv = await getJson(`/api/data_views/data_view/${id}`, '2023-10-31');
      if (dv) break;
      if (Date.now() > deadline) throw new Error('no login within the time limit (or no data view in the URL — open Discover on the right data view and copy its URL)');
      await page.waitForTimeout(3000);
    }
    const index = String(dv.data_view.title || '');
    if (!/^[^/?#\s]+$/.test(index)) throw new Error('unexpected data view index pattern (contains / ? # or spaces)');
    if (u.protocol === 'http:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) log('Warning: Kibana over plain http — your session travels unencrypted.');
    const timeField = dv.data_view.timeFieldName || '@timestamp';
    const fields = Object.values(dv.data_view.fields || {});
    const agg = new Set(fields.filter((/** @type {any} */ f) => f.aggregatable).map((/** @type {any} */ f) => f.name));
    log(`Logged in. Data view: ${index} (${fields.length} fields).`);
    const search = async (/** @type {any} */ body) => {
      const url = `${base}/api/console/proxy?path=${encodeURIComponent(`${index}/_search`)}&method=POST`;
      let r;
      try { r = await ctx.request.post(url, { headers: HDR, data: body, timeout: 180000 }); } catch (e) { throw new Error(`network/timeout: ${String(/** @type {Error} */ (e).message).split('\n')[0].slice(0, 120)}`); }
      if (!r.ok()) throw new Error(`HTTP ${r.status()}`);
      return r.json();
    };
    // Pick fields that this service actually fills (counts only, no documents).
    const svcField = o.serviceField || 'service.name';
    const cand = [...new Set(Object.values(CANDIDATES).flat())].filter((n) => agg.has(n) || agg.has(`${n}.keyword`));
    const probe = await search({ size: 0, query: { bool: { filter: [{ match_phrase: { [svcField]: o.service } }, { range: { [timeField]: { gte: `now-${o.days ?? 15}d` } } }] } },
      aggs: { has: { filters: { filters: Object.fromEntries(cand.map((n) => [n, { exists: { field: n } }])) } } } });
    const cnt = new Map(Object.entries(probe.aggregations.has.buckets).map(([n, b]) => [n, /** @type {any} */ (b).doc_count]));
    const pick = (/** @type {'method'|'path'|'status'} */ k, /** @type {string|undefined} */ forced) => forced
      || CANDIDATES[k].map((n) => [agg.has(n) ? n : `${n}.keyword`, cnt.get(n) ?? 0]).filter(([n, c]) => agg.has(String(n)) && Number(c) > 0).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
    const F = { methodField: pick('method', o.methodField), pathField: pick('path', o.pathField), statusField: pick('status', o.statusField) };
    if (!F.pathField) throw new Error(`no path field found for service "${o.service}" — pass --path-field`);
    log(`Fields: ${F.methodField} · ${F.pathField} · ${F.statusField}`);
    const res = await collect(search, { ...o, ...F, serviceField: svcField, timeField, days: o.days ?? 15, onProgress: log, rawPath: /http\.route/.test(String(F.pathField)) });
    /** @type {any} */
    let errors = null;
    if (o.errors) {
      const ef = pickErrorFields(agg);
      const traceField = o.traceField || ef.traceField, errorField = o.errorField || ef.errorField;
      if (!traceField || !errorField) log('Error texts skipped: no trace or error-message field found (pass --trace-field / --error-field).');
      else {
        log(`Error texts: ${errorField} via ${traceField}, last ${o.errorHours ?? 24} h…`);
        errors = await collectErrors(search, { ...o, ...F, serviceField: svcField, timeField, traceField, errorField, hours: o.errorHours ?? 24, rawPath: /http\.route/.test(String(F.pathField)),
          methodField: String(F.methodField), pathField: String(F.pathField), statusField: String(F.statusField) });
      }
    }
    return { ...res, errors };
  } finally {
    await browser.close();
  }
}
