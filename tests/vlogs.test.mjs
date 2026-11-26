// VictoriaLogs over HTTP: field detection, LogsQL built, rows and error texts parsed. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchVictoriaLogs, pickVlFields, fq, baseFilter, httpRequest } from '../src/adapters/vlogs.mjs';

const NOW = Date.parse('2026-03-10T12:30:00Z');
const FIELDS = { values: [
  { value: '_msg', hits: 900 }, { value: 'request.method', hits: 500 }, { value: 'request.uri', hits: 500 },
  { value: 'response.status', hits: 500 }, { value: 'trace_id', hits: 700 }, { value: 'container_name', hits: 900 },
] };

/** fake VictoriaLogs: answers by what the query asks for */
function fake(calls = [], today = '2026-03-10') {
  return async (path, params) => {
    calls.push({ path, ...params });
    if (path.endsWith('field_names')) return JSON.stringify(FIELDS);
    const q = params.query;
    if (q.includes('uniq_values')) {
      return JSON.stringify({ 'request.method': 'POST', 'request.uri': '/api/orders/{id}/pay', e5: '40', traces: ['t1', 't2', 'bad trace"'] }) + '\n';
    }
    if (q.includes('trace_id:in(')) {
      return [
        { _msg: 'db timeout after 3000 ms for order 1234567', n: '30', first: '2026-03-10T09:01:00Z', ex: 't1' },
        { _msg: 'db timeout after 3000 ms for order 7654321', n: '5', first: '2026-03-10T08:59:00Z', ex: 't2' },
      ].map((x) => JSON.stringify(x)).join('\n');
    }
    if (params.start.startsWith(today)) {
      return [
        { _time: `${today}T09:00:00Z`, 'request.method': 'POST', 'request.uri': '/api/orders/{id}/pay', 'response.status': '500', calls: '40' },
        { _time: `${today}T09:00:00Z`, 'request.method': 'GET', 'request.uri': '/api/orders/{id}', 'response.status': '200', calls: '1000' },
      ].map((x) => JSON.stringify(x)).join('\n');
    }
    return JSON.stringify({ _time: `${params.start.slice(0, 10)}T09:00:00Z`, 'request.method': 'GET', 'request.uri': '/api/orders/{id}', 'response.status': '200', calls: '900' }) + '\n';
  };
}

test('VictoriaLogs: fields are picked by how filled they are; explicit names win', () => {
  const hits = new Map([['path', 10], ['request.uri', 500], ['method', 3], ['status', 1]]);
  assert.deepEqual(pickVlFields(hits), { methodField: 'method', pathField: 'request.uri', statusField: 'status', traceField: null });
  assert.equal(pickVlFields(hits, { pathField: 'url' }).pathField, 'url');
  assert.equal(fq('request.method'), 'request.method');
  assert.equal(fq('x-trace-id'), '"x-trace-id"');
  assert.equal(baseFilter({ service: 'gate"way' }), 'container_name:"gate\\"way"');
  assert.equal(baseFilter({}), '*');
});

test('VictoriaLogs: hourly usage, one request per day, error texts from the same traces', async () => {
  const calls = [];
  const r = await fetchVictoriaLogs(fake(calls), { service: 'gateway', days: 2, hourly: true, errors: true, now: NOW });
  assert.deepEqual(r.fields, { methodField: 'request.method', pathField: 'request.uri', statusField: 'response.status', traceField: 'trace_id' });
  const usageQ = calls.filter((c) => c.path.endsWith('/query') && c.query.includes('count() calls'));
  assert.equal(usageQ.length, 3); // 2 full days back, aligned to UTC midnight, + today
  assert.match(usageQ[0].query, /^container_name:"gateway" request\.method:\* request\.uri:\* response\.status:\* \| replace_regexp/);
  assert.match(usageQ[0].query, /stats by \(_time:1h, request\.method, request\.uri, response\.status\) count\(\) calls/);
  const pay = r.rows.find((x) => x.method === 'POST');
  assert.equal(pay.hour, '2026-03-10T09');
  assert.equal(pay.status, '500:40');
  // error texts: bad trace ids are dropped, service filter is not applied (the app writes the error), digits masked and merged
  const errQ = calls.find((c) => c.query.includes('trace_id:in('));
  assert.equal(errQ.query.startsWith('trace_id:in("t1","t2")'), true);
  assert.equal(errQ.query.includes('container_name'), false);
  const ep = r.errors.endpoints[0];
  assert.equal(ep.errors5xx, 40);
  assert.equal(ep.traces, 2);
  assert.deepEqual(ep.messages, [{ text: 'db timeout after {n} ms for order {n}', count: 35, firstSeen: '2026-03-10T08:59:00Z', trace: 't1' }]);
});

test('VictoriaLogs: a clear error when the gateway fields are not there', async () => {
  const req = async (path) => (path.endsWith('field_names') ? JSON.stringify({ values: [{ value: 'msg', hits: 5 }, { value: 'level', hits: 5 }] }) : '');
  await assert.rejects(fetchVictoriaLogs(req, { now: NOW }), /could not find the method field\. Fields seen: msg, level/);
  const none = async () => JSON.stringify({ values: [] });
  await assert.rejects(fetchVictoriaLogs(none, { service: 'x', now: NOW }), /no records/);
});

test('VictoriaLogs: a day over --max-rows is cut and reported', async () => {
  const req = async (path, p) => (path.endsWith('field_names') ? JSON.stringify(FIELDS)
    : [1, 2, 3].map((i) => JSON.stringify({ 'request.method': 'GET', 'request.uri': `/a${i}`, 'response.status': '200', calls: 1 })).join('\n'));
  const r = await fetchVictoriaLogs(req, { days: 1, maxRows: 2, now: NOW });
  assert.equal(r.truncated.length, 2);
  assert.equal(r.rows.length, 4);
});

test('VictoriaLogs: CLI end to end against a local HTTP server (auth and tenant headers)', async () => {
  const f = fake([], new Date().toISOString().slice(0, 10));
  const seen = [];
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, auth: req.headers.authorization, acc: req.headers.accountid });
    const params = Object.fromEntries(new URLSearchParams(body));
    res.end(await f(req.url, { ...params, start: params.start }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'ade-vl-'));
  try {
    const bin = new URL('../bin/api-dead-ends.mjs', import.meta.url).pathname;
    const { stderr } = await promisify(execFile)(process.execPath, [bin, 'fetch', 'victorialogs', '--url', `http://127.0.0.1:${port}/`, '--days', '1', '--hourly', '--tenant', '3:0',
      '--errors', join(dir, 'errors.json'), '-o', join(dir, 'usage.csv')], { env: { ...process.env, VL_AUTH: 'Bearer test' } });
    assert.match(stderr, /Fields: method=request\.method path=request\.uri status=response\.status trace=trace_id/);
    const csv = await readFile(join(dir, 'usage.csv'), 'utf8');
    assert.match(csv.split('\n')[0], /hour/);
    assert.match(csv, /POST,\/api\/orders\/\{id\}\/pay,40/);
    const errors = JSON.parse(await readFile(join(dir, 'errors.json'), 'utf8'));
    assert.equal(errors.endpoints[0].messages[0].count > 0, true);
    assert.equal(seen[0].auth, 'Bearer test');
    assert.equal(seen[0].acc, '3');
  } finally { srv.close(); }
});

test('VictoriaLogs: only http(s) URLs', () => {
  assert.throws(() => httpRequest('file:///etc/passwd'), /http/);
});
