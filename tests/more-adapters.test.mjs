import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prometheus, PROM_PRESETS } from '../src/adapters/others.mjs';
import { csv, splunk, datadogApm, splitResource, newrelic, dynatrace, athena, azureApim, accesslog, parseAccessLine } from '../src/adapters/more.mjs';
import { addRow } from '../src/usage.mjs';

// All responses are synthetic, shaped after vendor docs.
const day = (d) => Date.UTC(2026, 10, d) / 1000;

test('prometheus: query_range matrix → calls + first/last seen; presets', () => {
  const m = { data: { resultType: 'matrix', result: [
    { metric: { method: 'GET', uri: '/api/orders/{id}', status: '200' }, values: [[day(1), '0'], [day(2), '10.2'], [day(5), '4.9'], [day(6), '0.1']] },
    { metric: { method: 'GET', uri: '/api/dead', status: '200' }, values: [[day(1), '0'], [day(2), '0']] },
  ] } };
  const rows = prometheus.parse(JSON.stringify(m), { preset: 'spring' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 15);
  assert.equal(rows[0].first_seen, '2026-11-02T00:00:00.000Z');
  assert.equal(rows[0].last_seen, '2026-11-05T00:00:00.000Z');
  assert.match(prometheus.query({ preset: 'otel', service: 's' }), /http_server_request_duration_seconds_count\{service_name="s"\}/);
  assert.throws(() => prometheus.query({ preset: 'nope' }), /preset/);
  assert.ok(Object.keys(PROM_PRESETS).length >= 10);
  const span = { data: { result: [{ metric: { span_name: 'POST /pay', http_status_code: '201' }, value: [1, '7'] }] } };
  const r2 = prometheus.parse(JSON.stringify(span), { preset: 'spanmetrics' });
  assert.deepEqual([r2[0].method, r2[0].path], ['POST', '/pay']);
});

test('csv: aliases, --map, "GET /x" names, status forms, epoch times', () => {
  const t = 'http_method,uri_path,count,status,first_seen\nGET,/a/1,3,200,1793491200\nGET,/a/2,2,500,\n';
  const rows = csv.parse(t);
  assert.deepEqual(rows[0], { method: 'GET', path: '/a/1', calls: 3, first_seen: '2026-11-01T00:00:00.000Z', last_seen: '', status: '200:3' });
  const m = csv.parse('Verb,Where,N\nPOST,/b,4\n', { map: 'method=Verb,path=Where,calls=N' });
  assert.equal(m[0].calls, 4);
  assert.throws(() => csv.parse('x,y\n1,2'), /path/);
  assert.throws(() => csv.parse('a\n1', { map: 'path=zzz' }), /zzz/);
  assert.equal(csv.parse('name,calls,status\n"GET /c",5,200:4|500:1\n')[0].status, '200:4|500:1');
});

test('splunk: CSV and JSON exports', () => {
  assert.equal(splunk.parse('method,uri_path,status,calls\nGET,/s,200,9\n')[0].calls, 9);
  const j = '{"result":{"method":"GET","uri_path":"/j","status":"404","calls":"2"}}\n{"result":{"method":"PUT","uri_path":"/k","status":"200","calls":"1"}}';
  const rows = splunk.parse(j);
  assert.deepEqual(rows.map((r) => `${r.method} ${r.path} ${r.status}`), ['GET /j 404:2', 'PUT /k 200:1']);
});

test('datadog-apm: series with normalized resource names', () => {
  assert.deepEqual(splitResource('get_/api/v1/orders/_id_'), { method: 'GET', path: '/api/v1/orders/{id}' });
  assert.deepEqual(splitResource('GET /api/v1/orders/{order_id}'), { method: 'GET', path: '/api/v1/orders/{id}' });
  assert.deepEqual(splitResource('post_/api/transfer_fee'), { method: 'POST', path: '/api/transfer_fee' });
  const resp = { series: [
    { scope: 'resource_name:get_/api/x/_id_,http.status_code:200', pointlist: [[day(1) * 1000, 0], [day(3) * 1000, 12], [day(9) * 1000, 3]] },
    { scope: 'resource_name:get_/api/never,http.status_code:200', pointlist: [[day(1) * 1000, 0]] },
  ] };
  const rows = datadogApm.parse(JSON.stringify(resp));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 15);
  assert.equal(rows[0].last_seen, '2026-11-09T00:00:00.000Z');
  assert.match(datadogApm.query({ service: 'svc' }), /trace\.http\.request\.hits\{service:svc\} by \{resource_name,http\.status_code\}/);
});

test('newrelic: NerdGraph facets, transaction names', () => {
  const ng = { data: { actor: { account: { nrql: { results: [
    { facet: ['GET', 'WebTransaction/Go/GET /api/a', 200], calls: 5, first_seen: 1793491200000, last_seen: 1793577600000 },
    { facet: 'WebTransaction/SpringController/orders/list', calls: 2 },
  ] } } } } };
  const rows = newrelic.parse(JSON.stringify(ng));
  assert.deepEqual([rows[0].method, rows[0].path, rows[0].status], ['GET', '/api/a', '200:5']);
  assert.equal(rows[0].first_seen, '2026-11-01T00:00:00.000Z');
  assert.equal(rows[1].path, '/orders/list');
});

test('dynatrace, athena, azure-apim', () => {
  const dt = { result: { records: [{ 'http.request.method': 'GET', 'http.route': '/r/{id}', 'http.response.status_code': 200, calls: 8 }] } };
  assert.equal(dynatrace.parse(JSON.stringify(dt))[0].path, '/r/{id}');
  assert.equal(athena.parse('method,path,status,calls\nGET,/alb,200,3\n')[0].calls, 3);
  assert.match(athena.query({ days: 7 }), /interval '7' day/);
  const apim = { tables: [{ columns: [{ name: 'name' }, { name: 'resultCode' }, { name: 'calls' }], rows: [['GET /apim/x', '200', 4]] }] };
  assert.equal(azureApim.parse(JSON.stringify(apim))[0].path, '/apim/x');
});

test('accesslog: combined, JSON lines, junk; no IP or UA kept', () => {
  const c = parseAccessLine('203.0.113.9 - - [10/Nov/2026:13:55:36 +0300] "GET /api/orders/123?token=abc HTTP/1.1" 200 512 "-" "curl/8"');
  assert.deepEqual(c, { method: 'GET', path: '/api/orders/123?token=abc', status: '200', time: '2026-11-10T10:55:36.000Z' });
  const j = parseAccessLine('{"time":"2026-11-10T10:00:00Z","request":"POST /pay HTTP/2","status":201,"remote_addr":"203.0.113.9"}');
  assert.deepEqual(j, { method: 'POST', path: '/pay', status: '201', time: '2026-11-10T10:00:00Z' });
  assert.equal(parseAccessLine('garbage'), null);
  const rows = accesslog.parse('203.0.113.9 - - [10/Nov/2026:13:55:36 +0000] "GET /x/1 HTTP/1.1" 404 0 "-" "-"\n');
  assert.ok(!JSON.stringify(rows).includes('203.0.113.9'));
});

test('accesslog: streams plain and .gz files and aggregates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-log-'));
  const line = (p, s) => `198.51.100.1 - - [10/Nov/2026:00:00:00 +0000] "GET ${p} HTTP/1.1" ${s} 1 "-" "-"\n`;
  writeFileSync(join(dir, 'a.log'), line('/u/1', 200) + line('/u/2', 200) + 'junk\n');
  writeFileSync(join(dir, 'b.log.gz'), gzipSync(line('/u/3', 500)));
  const acc = new Map();
  const st = await accesslog.stream([join(dir, 'a.log'), join(dir, 'b.log.gz')], (r) => addRow(acc, r));
  assert.deepEqual(st, { lines: 4, bad: 1 });
  const u = acc.get('GET /u/{id}');
  assert.equal(u.calls, 3);
  assert.equal(u.status.get('500'), 1);
});
