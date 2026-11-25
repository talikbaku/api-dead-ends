import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as es from '../src/adapters/elasticsearch.mjs';
import { datadog, appinsights, prometheus, loki, cloudwatch } from '../src/adapters/others.mjs';
import { parseUsage, addRow, toCsv } from '../src/usage.mjs';

// Responses below are synthetic, shaped after the docs. The Elasticsearch shape matches a real Kibana response.
const esPage = (buckets, after) => ({
  timed_out: false,
  aggregations: { ep: { ...(after ? { after_key: after } : {}), buckets } },
});
const bucket = (method, path, n, status = { 200: n }) => ({
  key: { method, path },
  doc_count: n,
  first_seen: { value_as_string: '2026-11-05T00:00:00.000Z' },
  last_seen: { value_as_string: '2026-11-19T00:00:00.000Z' },
  status: { buckets: Object.entries(status).map(([key, doc_count]) => ({ key: Number(key), doc_count })) },
});

test('elasticsearch: query has service filter, runtime normalize, composite paging', () => {
  const q = es.buildQuery({ service: 'svc', from: 1, to: 2, after: { method: 'GET', path: '/a' } });
  assert.deepEqual(q.query.bool.filter[0], { match_phrase: { 'service.name': 'svc' } });
  assert.equal(q.query.bool.filter[1].range['@timestamp'].format, 'epoch_millis');
  assert.ok(q.runtime_mappings.ep_path.script.source.includes('emit('));
  assert.deepEqual(q.aggs.ep.composite.after, { method: 'GET', path: '/a' });
  assert.equal(es.buildQuery({ rawPath: true, pathField: 'http.route' }).aggs.ep.composite.sources[1].path.terms.field, 'http.route');
  const af = es.buildQuery({ accessFilter: 'message:"Request"' }).query.bool.filter.at(-1);
  assert.deepEqual(af, { match_phrase: { message: 'Request' } });
  const ex = es.buildQuery({ excludeFilter: 'message.keyword:"dup error"' }).query.bool.must_not;
  assert.deepEqual(ex, [{ term: { 'message.keyword': 'dup error' } }]);
  assert.match(es.queryText({ index: 'logs-*' }), /POST \/logs-\*\/_search/);
});

test('elasticsearch: parse single, concatenated and Kibana-wrapped responses', () => {
  const p1 = esPage([bucket('GET', '/a/{id}', 3, { 200: 2, 500: 1 })]);
  const p2 = { rawResponse: esPage([bucket('POST', '/b', 1)]) };
  const rows = es.parse(`${JSON.stringify(p1)}\n${JSON.stringify(p2, null, 2)}`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, '200:2|500:1');
  assert.throws(() => es.parse('{"hits":{}}'), /buckets/);
});

test('elasticsearch: collect pages, splits windows on timeout, reports skipped', async () => {
  let calls = 0;
  const search = async (body) => {
    calls++;
    const r = body.query.bool.filter.find((f) => f.range).range['@timestamp'];
    if (r.lt - r.gte > 2 * 3600e3) throw new Error('HTTP 504');
    if (!body.aggs.ep.composite.after) return esPage([bucket('GET', '/x', 1)], { method: 'GET', path: '/x' });
    return esPage([bucket('GET', '/y', 1)]);
  };
  const { rows, skipped } = await es.collect(search, { days: 1, windowHours: 3, now: 24 * 3600e3, size: 1 });
  assert.equal(skipped.length, 0);
  // 8 windows of 3 h → each splits into 2 of 1.5 h → 16 windows × 2 pages
  assert.equal(rows.length, 32);
  assert.ok(calls >= 40);
  const tight = await es.collect(async () => { throw new Error('HTTP 504'); }, { days: 1, windowHours: 12, now: 24 * 3600e3, minWindowHours: 6 });
  assert.equal(tight.skipped.length, 4);
});

test('datadog: aggregate buckets by method/path/status', () => {
  const resp = { data: { buckets: [
    { by: { '@http.method': 'GET', '@http.url_details.path': '/orders/42', '@http.status_code': 200 }, computes: { c0: 10 } },
    { by: { '@http.method': 'GET', '@http.url_details.path': '/orders/43', '@http.status_code': 500 }, computes: { c0: 2 } },
    { by: { resource_name: 'POST /pay' }, computes: { c0: 5 } },
  ] } };
  const acc = new Map();
  for (const r of datadog.parse(JSON.stringify(resp))) addRow(acc, r);
  const rows = [...acc.values()];
  assert.equal(rows.find((r) => r.path === '/orders/{id}').calls, 12);
  assert.equal(rows.find((r) => r.path === '/orders/{id}').status.get('500'), 2);
  assert.equal(rows.find((r) => r.path === '/pay').method, 'POST');
  assert.match(datadog.query({ service: 'svc' }), /service:svc/);
});

test('appinsights: az CLI tables JSON and CSV export', () => {
  const az = { tables: [{ name: 'PrimaryResult', columns: [{ name: 'name' }, { name: 'resultCode' }, { name: 'calls' }, { name: 'first_seen' }, { name: 'last_seen' }],
    rows: [['GET /api/orders/{id}', '200', 7, '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z'], ['GET /api/orders/{id}', '500', 1, '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z']] }] };
  const rows = appinsights.parse(JSON.stringify(az));
  assert.equal(rows[0].method, 'GET');
  assert.equal(rows[0].path, '/api/orders/{id}');
  const csv = 'name,resultCode,calls,first_seen,last_seen\n"GET /api/x",200,3,"2026-11-01 10:00:00.000","2026-11-02 10:00:00.000"\n';
  const r2 = appinsights.parse(csv);
  assert.equal(r2[0].calls, 3);
  assert.equal(r2[0].first_seen, '2026-11-01T10:00:00.000Z');
  assert.match(appinsights.query({ service: 'svc', days: 30 }), /ago\(30d\)[\s\S]*cloud_RoleName == "svc"/);
});

test('prometheus and loki: vector results', () => {
  const prom = { status: 'success', data: { resultType: 'vector', result: [
    { metric: { method: 'GET', route: '/api/x/:id', status: '200' }, value: [1, '99.6'] },
    { metric: { method: 'GET', route: '/dead', status: '200' }, value: [1, '0'] },
  ] } };
  const rows = prometheus.parse(JSON.stringify(prom));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 100);
  const lk = { data: { result: [{ metric: { method: 'POST', path: '/y', status: '201' }, value: [1, '4'] }] } };
  assert.equal(loki.parse(JSON.stringify(lk))[0].path, '/y');
});

test('cloudwatch: get-query-results', () => {
  const cw = { status: 'Complete', results: [[
    { field: 'httpMethod', value: 'GET' }, { field: 'path', value: '/z/123' }, { field: 'status', value: '404' },
    { field: 'calls', value: '6' }, { field: 'first_seen', value: '2026-11-01 00:00:00.000' }, { field: 'last_seen', value: '2026-11-02 00:00:00.000' },
  ]] };
  const rows = cloudwatch.parse(JSON.stringify(cw));
  assert.deepEqual(rows[0], { method: 'GET', path: '/z/123', calls: 6, first_seen: '2026-11-01T00:00:00.000Z', last_seen: '2026-11-02T00:00:00.000Z', status: '404:6' });
});

test('adapter output round-trips through the usage table', () => {
  const acc = new Map();
  for (const r of es.parse(JSON.stringify(esPage([bucket('GET', '/a/1', 2), bucket('GET', '/a/2', 3)])))) addRow(acc, r);
  const back = parseUsage(toCsv([...acc.values()]));
  assert.equal(back.length, 1);
  assert.equal(back[0].calls, 5);
});

test('elasticsearch: window failing on page 2 is not double counted after split', async () => {
  const seen = new Map();
  const search = async (body) => {
    const r = body.query.bool.filter.find((f) => f.range).range['@timestamp'];
    const big = r.lt - r.gte > 2 * 3600e3;
    if (!body.aggs.ep.composite.after) return esPage([bucket('GET', '/p1', 1)], { method: 'GET', path: '/p1' });
    if (big) throw new Error('HTTP 504'); // the second page of a big window fails
    return esPage([bucket('GET', '/p2', 1)]);
  };
  const { rows } = await es.collect(search, { days: 0.125, windowHours: 3, now: 3 * 3600e3, size: 1 });
  // a 3 h window splits into 2 of 1.5 h; each gives /p1 and /p2 once → exactly 2 + 2, nothing left over from the failed window
  const calls = (p) => rows.filter((x) => x.path === p).reduce((s, x) => s + x.calls, 0);
  assert.equal(calls('/p1'), 2);
  assert.equal(calls('/p2'), 2);
  assert.ok(es.buildQuery({ keep: ['oauth2'] }).runtime_mappings.ep_path.script.params.keep.includes('oauth2'));
});
