// @ts-check
// Elasticsearch / OpenSearch / Kibana Dev Tools.
// Verified on a real production cluster through Kibana:
// a full 15-day query hits the proxy timeout; 3-hour windows take 3-10 s each.

/** Painless: the same templating as src/template.mjs (simplified: numbers, IDs with digits ≥ 6 chars, '@'). */
export const NORMALIZE_PAINLESS = `
  def d = doc[params.f];
  if (d.size() == 0) return;
  String u = d.value;
  int q = u.indexOf('?'); if (q >= 0) u = u.substring(0, q);
  q = u.indexOf('#'); if (q >= 0) u = u.substring(0, q);
  int sch = u.indexOf('://');
  if (sch >= 0) { int sl = u.indexOf('/', sch + 3); u = sl < 0 ? '/' : u.substring(sl); }
  StringBuilder sb = new StringBuilder();
  for (String seg : u.splitOnToken('/')) {
    if (seg.length() == 0) continue;
    boolean digit = false; boolean all = true; boolean at = false;
    for (int i = 0; i < seg.length(); i++) {
      char c = seg.charAt(i);
      if (Character.isDigit(c)) digit = true; else all = false;
      if (c == (char) 64) at = true;
    }
    sb.append('/');
    boolean keep = params.containsKey('keep') && params.keep.contains(seg);
    sb.append(!keep && (all || at || (digit && seg.length() >= 6)) ? '{id}' : seg);
  }
  String r = sb.length() == 0 ? '/' : sb.toString();
  emit(r.length() > 200 ? r.substring(0, 200) : r);
`.trim();

/**
 * @typedef {object} EsOptions
 * @property {string} [service]       service filter value
 * @property {string} [serviceField]  default service.name
 * @property {string} [methodField]   default http.request.method
 * @property {string} [pathField]     default url.original (prefer http.route if you have it)
 * @property {string} [statusField]   default http.response.status_code
 * @property {string} [timeField]     default @timestamp
 * @property {string} [excludeFilter] drop duplicate records, e.g. message.keyword:"unexpected error returned in response"
 * @property {string} [accessFilter]  KQL-like filter for access records only, e.g. message:"Request" (against double counting)
 * @property {string|number} [from]   gte (e.g. now-15d or epoch ms)
 * @property {string|number} [to]     lt (e.g. now)
 * @property {boolean} [rawPath]      do not template the path in the cluster (when the field is already a template: http.route)
 * @property {object} [after]         after_key for the next page
 * @property {number} [size]
 * @property {string[]} [keep]      literal spec segments that must not be folded (see literalSegments)
 */

/** @param {EsOptions} o */
export function buildQuery(o = {}) {
  const f = {
    service: o.serviceField || 'service.name',
    method: o.methodField || 'http.request.method',
    path: o.pathField || 'url.original',
    status: o.statusField || 'http.response.status_code',
    time: o.timeField || '@timestamp',
  };
  /** @type {any[]} */
  const filter = [
    { range: { [f.time]: { gte: o.from ?? `now-${o.days ?? 15}d`, lt: o.to ?? 'now', ...(typeof o.from === 'number' ? { format: 'epoch_millis' } : {}) } } },
    { exists: { field: f.path } },
  ];
  if (o.service) filter.unshift({ match_phrase: { [f.service]: o.service } });
  if (o.accessFilter) {
    const m = o.accessFilter.match(/^\s*([\w.@-]+)\s*:\s*"?(.*?)"?\s*$/);
    if (m) filter.push(m[1].endsWith('.keyword') ? { term: { [m[1]]: m[2] } } : { match_phrase: { [m[1]]: m[2] } }); // .keyword → exact match
  }
  /** @type {any[]} */
  const mustNot = [];
  if (o.excludeFilter) {
    const m = o.excludeFilter.match(/^\s*([\w.@-]+)\s*:\s*"?(.*?)"?\s*$/);
    if (m) mustNot.push(m[1].endsWith('.keyword') ? { term: { [m[1]]: m[2] } } : { match_phrase: { [m[1]]: m[2] } });
  }
  return {
    size: 0,
    track_total_hits: false,
    query: { bool: { filter, ...(mustNot.length ? { must_not: mustNot } : {}) } },
    ...(o.rawPath ? {} : { runtime_mappings: { ep_path: { type: 'keyword', script: { source: NORMALIZE_PAINLESS, params: { f: f.path, keep: o.keep ?? [] } } } } }),
    aggs: {
      ep: {
        composite: {
          size: o.size ?? 1000,
          sources: [
            { method: { terms: { field: f.method, missing_bucket: true } } },
            { path: { terms: { field: o.rawPath ? f.path : 'ep_path' } } },
          ],
          ...(o.after ? { after: o.after } : {}),
        },
        aggs: {
          first_seen: { min: { field: f.time } },
          last_seen: { max: { field: f.time } },
          status: { terms: { field: f.status, size: 20 } },
        },
      },
    },
  };
}

/** Text for Kibana Dev Tools → Console. */
export function queryText(/** @type {EsOptions & { index?: string }} */ o = {}) {
  return [
    '# Kibana: Dev Tools → Console. Run, then repeat with "after": <aggregations.ep.after_key> until after_key is absent.',
    '# Save every response into one file (one JSON per page, or a JSON array), then: api-dead-ends convert elasticsearch <file>',
    '# If it times out, narrow "gte"/"lt" to a few hours per request (3 h windows worked on ~6M req/day).',
    `POST /${o.index || '<index-pattern>'}/_search`,
    JSON.stringify(buildQuery(o), null, 2),
  ].join('\n');
}

/**
 * Parse _search response(s) with a composite aggregation: one JSON, a JSON array or JSONL.
 * Also understands the Kibana internal search wrapper ({ rawResponse }).
 * @param {string} text
 */
export function parse(text) {
  const docs = splitJson(text);
  const out = [];
  for (let d of docs) {
    if (d.rawResponse) d = d.rawResponse;
    const buckets = d?.aggregations?.ep?.buckets;
    if (!Array.isArray(buckets)) throw new Error('Elasticsearch: no aggregations.ep.buckets — is this the response to the query from `api-dead-ends query elasticsearch`?');
    for (const b of buckets) {
      out.push({
        method: b.key.method ?? '',
        path: String(b.key.path),
        calls: b.doc_count,
        first_seen: b.first_seen?.value_as_string || '',
        last_seen: b.last_seen?.value_as_string || '',
        status: (b.status?.buckets || []).map((/** @type {any} */ s) => `${s.key}:${s.doc_count}`).join('|'),
      });
    }
  }
  return out;
}

/** @param {string} text */
export function splitJson(text) {
  const t = text.trim();
  if (t.startsWith('[')) return JSON.parse(t);
  try {
    return [JSON.parse(t)];
  } catch {
    // several JSON documents in a row (as Dev Tools saves them) or JSONL
    const out = [];
    let depth = 0, start = -1, inStr = false, escp = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (escp) escp = false; else if (ch === '\\') escp = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth++ === 0) start = i; }
      else if (ch === '}') { if (--depth === 0) out.push(JSON.parse(t.slice(start, i + 1))); }
    }
    return out;
  }
}

/**
 * Walk time windows, splitting on timeout. search(body) is an injected transport.
 * @param {(body: any) => Promise<any>} search
 * @param {EsOptions & { days?: number, windowHours?: number, now?: number, minWindowHours?: number, daily?: boolean, onProgress?: (msg: string) => void }} o
 */
export async function collect(search, o) {
  const H = 3600e3;
  const now = o.now ?? Date.now();
  const wh = o.daily && 24 % (o.windowHours ?? 3) !== 0 ? 3 : (o.windowHours ?? 3); // daily output needs windows that divide a day
  const win = wh * H;
  // With daily output, align windows to UTC hours so each 3-hour window sits inside one day.
  const start = o.daily ? Math.floor((now - (o.days ?? 15) * 24 * H) / win) * win : now - (o.days ?? 15) * 24 * H;
  const minWin = (o.minWindowHours ?? 0.25) * H;
  /** @type {Array<[number, number]>} */
  const queue = [];
  for (let t = start; t < now; t += win) queue.push([t, Math.min(t + win, now)]);
  const rows = [];
  const skipped = [];
  while (queue.length) {
    const [from, to] = /** @type {[number, number]} */ (queue.shift());
    try {
      let after;
      const win = []; // a window's rows are merged only after all its pages succeed — otherwise splitting would double count
      for (let page = 0; ; page++) {
        if (page >= 1000) throw new Error('more than 1000 pages in one window');
        const res = await search(buildQuery({ ...o, from, to, after }));
        if (res?.timed_out) throw new Error('timed_out');
        const a = (res.rawResponse ?? res).aggregations.ep;
        win.push(...parse(JSON.stringify(res)));
        if (!a.after_key || a.buckets.length < (o.size ?? 1000)) break;
        after = a.after_key;
      }
      const day = new Date(from).toISOString().slice(0, 10);
      rows.push(...(o.daily ? win.map((r) => ({ ...r, day })) : win));
      o.onProgress?.(`${new Date(from).toISOString().slice(0, 16)}: ok`);
    } catch (e) {
      if (to - from > minWin) {
        const mid = from + Math.floor((to - from) / 2);
        queue.unshift([from, mid], [mid, to]);
        o.onProgress?.(`${new Date(from).toISOString().slice(0, 16)}: split (${String(/** @type {Error} */ (e).message).split('\n')[0].slice(0, 60)})`);
      } else {
        skipped.push([from, to]);
        o.onProgress?.(`${new Date(from).toISOString().slice(0, 16)}: skipped`);
      }
    }
  }
  return { rows, skipped };
}
