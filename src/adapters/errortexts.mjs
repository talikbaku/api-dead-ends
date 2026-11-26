// @ts-check
// Error texts behind 5xx (Elasticsearch / Kibana): for the endpoints with most 5xx in the last N hours, find the
// error records in the same traces and group their messages. Digits, UUIDs and e-mails are masked, texts cut to
// 200 characters, one example trace id per message. Only aggregates and short texts leave the cluster.

import { NORMALIZE_PAINLESS } from './elasticsearch.mjs';

const TRACE = ['trace.id', 'x-trace-id', 'trace_id', 'traceId', 'traceid', 'request_id', 'x-request-id'];
const ERROR = ['error.message', 'error.msg', 'err.message', 'exception.message', 'error.type'];

/**
 * Pick a trace field and an error-text field that are aggregatable — and, when `counts` is given (documents of
 * this service that have the field), the one this service actually fills (a shared data view has many unused fields).
 * @param {Set<string>} agg @param {Map<string, number>} [counts]
 */
export function pickErrorFields(agg, counts) {
  const pick = (/** @type {string[]} */ c) => {
    const ok = c.map((n) => (agg.has(n) ? n : agg.has(`${n}.keyword`) ? `${n}.keyword` : null)).filter(/** @returns {x is string} */ (x) => !!x);
    if (!counts) return ok[0] || null;
    return ok.map((n) => [n, counts.get(n.replace(/\.keyword$/, '')) ?? counts.get(n) ?? 0]).filter(([, c2]) => Number(c2) > 0).sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || null;
  };
  return { traceField: pick(TRACE), errorField: pick(ERROR) };
}

export const ERROR_FIELD_CANDIDATES = [...TRACE, ...ERROR];

/** Mask what identifies people or objects, keep the shape of the message. @param {string} s */
export function maskText(s) {
  return String(s).split('\n')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '{email}')
    .replace(/\d{3,}/g, '{n}')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 200);
}

/**
 * @param {(body: any) => Promise<any>} search
 * @param {{ service?: string, serviceField?: string, methodField: string, pathField: string, statusField: string, timeField: string,
 *   traceField: string, errorField: string, hours?: number, top?: number, excludeFilter?: string, keep?: string[], rawPath?: boolean }} o
 */
export async function collectErrors(search, o) {
  const since = `now-${o.hours ?? 24}h`;
  const base = [{ range: { [o.timeField]: { gte: since } } }, ...(o.service ? [{ match_phrase: { [o.serviceField || 'service.name']: o.service } }] : [])];
  const mustNot = [];
  const m = o.excludeFilter && o.excludeFilter.match(/^\s*([\w.@-]+)\s*:\s*"?(.*?)"?\s*$/);
  if (m) mustNot.push(m[1].endsWith('.keyword') ? { term: { [m[1]]: m[2] } } : { match_phrase: { [m[1]]: m[2] } });
  const pathAgg = o.rawPath ? o.pathField : 'ep_path';
  const top = await search({
    size: 0,
    query: { bool: { filter: [...base, { range: { [o.statusField]: { gte: 500 } } }], must_not: mustNot } },
    ...(o.rawPath ? {} : { runtime_mappings: { ep_path: { type: 'keyword', script: { source: NORMALIZE_PAINLESS, params: { f: o.pathField, keep: o.keep ?? [] } } } } }),
    aggs: { ep: { terms: { field: pathAgg, size: o.top ?? 5 }, aggs: { m: { terms: { field: o.methodField, size: 1 } }, t: { terms: { field: o.traceField, size: 300 } } } } },
  });
  const endpoints = [];
  for (const b of top.aggregations.ep.buckets) {
    const traces = b.t.buckets.map((/** @type {any} */ x) => x.key);
    const messages = [];
    if (traces.length) {
      const er = await search({
        size: 0,
        query: { bool: { filter: [...base, { terms: { [o.traceField]: traces } }], must_not: [{ exists: { field: o.statusField } }] } },
        aggs: { msg: { terms: { field: o.errorField, size: 50 }, aggs: { first: { min: { field: o.timeField } }, ex: { top_hits: { size: 1, sort: [{ [o.timeField]: 'desc' }], _source: [o.traceField.replace(/\.keyword$/, '')] } } } } },
      });
      /** @type {Map<string, { text: string, count: number, firstSeen: string, trace: string }>} */
      const grouped = new Map();
      for (const x of er.aggregations.msg.buckets) {
        const text = maskText(x.key);
        const src = x.ex.hits.hits[0]?._source || {};
        const trace = String(getPath(src, o.traceField.replace(/\.keyword$/, '')) || '').slice(0, 80);
        const g = grouped.get(text) || { text, count: 0, firstSeen: x.first.value_as_string || '', trace };
        g.count += x.doc_count;
        if (x.first.value_as_string && x.first.value_as_string < g.firstSeen) g.firstSeen = x.first.value_as_string;
        grouped.set(text, g);
      }
      messages.push(...[...grouped.values()].sort((a, c) => c.count - a.count).slice(0, 8));
    }
    endpoints.push({ method: b.m.buckets[0]?.key || '', path: b.key, errors5xx: b.doc_count, traces: traces.length, messages });
  }
  return {
    since: `last ${o.hours ?? 24} h`,
    note: `Error records in the same traces as the 5xx responses (up to 300 traces per endpoint), last ${o.hours ?? 24} h. Digits, UUIDs and e-mails masked.`,
    fields: { trace: o.traceField, error: o.errorField },
    endpoints,
  };
}

/** @param {any} o @param {string} p */
function getPath(o, p) {
  if (o == null) return undefined;
  if (p in o) return o[p];
  return p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
}
