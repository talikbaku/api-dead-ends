import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { templatePath, stripUrl, isIdSegment } from '../src/template.mjs';
import { parseUsage, toCsv, parseStatus } from '../src/usage.mjs';
import { loadSpec, matchOp, basePrefix } from '../src/spec.mjs';
import { classify } from '../src/classify.mjs';
import { toMarkdown, toJson } from '../src/report.mjs';
import { makeBaseline, compareBaseline } from '../src/baseline.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const spec = loadSpec(JSON.parse(fx('shop.openapi.json')));
const rows = parseUsage(fx('shop.usage.csv'));
const r = classify(rows, spec);
const ep = (m, p) => r.endpoints.find((e) => e.method === m && e.path === p);

test('template: host, query, slashes, ids', () => {
  assert.equal(stripUrl('https://h.example/a//b/?q=1#x'), '/a/b');
  assert.equal(templatePath('/orders/123'), '/orders/{id}');
  assert.equal(templatePath('/users/550e8400-e29b-41d4-a716-446655440000'), '/users/{id}');
  assert.equal(templatePath('/api/v1/orders/checkout'), '/api/v1/orders/checkout');
  assert.equal(templatePath('/u/a%40b.com'), '/u/{id}');
  assert.equal(isIdSegment('v2'), false);
  assert.equal(isIdSegment('ord_8f3k2a9'), true);
  assert.equal(isIdSegment('01ARZ3NDEKTSV4RRFFQ69G5FAV'), true);
  assert.equal(isIdSegment('me'), false);
});

test('usage: CSV merges rows after templating, status parsed', () => {
  const u = parseUsage('method,path,calls,status\nget,/a/1,2,200:2\nGET,/a/2,3,200:2|500:1\n');
  assert.equal(u.length, 1);
  assert.equal(u[0].calls, 5);
  assert.deepEqual([...u[0].status], [['200', 4], ['500', 1]]);
  assert.match(toCsv(u), /GET,\/a\/\{id\},5/);
  assert.deepEqual([...parseStatus('a:b|200:x|404:3')], [['404', 3]]);
});

test('usage: JSON and JSONL inputs', () => {
  assert.equal(parseUsage('[{"method":"GET","path":"/x","calls":1}]')[0].calls, 1);
  assert.equal(parseUsage('{"method":"GET","path":"/x","calls":1}\n{"method":"GET","path":"/x","calls":2}')[0].calls, 3);
  assert.throws(() => parseUsage('method,calls\nGET,1'), /path/);
});

test('spec: servers prefix is optional, literal beats param', () => {
  assert.equal(spec.base, '/v1');
  assert.equal(basePrefix({ basePath: '/' }), '');
  assert.equal(matchOp(spec.ops, 'GET', '/v1/users/me').path, '/users/me');
  assert.equal(matchOp(spec.ops, 'GET', '/users/me').path, '/users/me');
  assert.equal(matchOp(spec.ops, 'GET', '/v1/users/{id}').path, '/users/{id}');
  assert.equal(matchOp(spec.ops, 'DELETE', '/v1/users/{id}'), null);
  assert.throws(() => loadSpec({}), /paths/);
});

test('classify: used / rare / not_seen / deprecated_in_use', () => {
  assert.equal(ep('GET', '/users/me').class, 'used');
  assert.equal(ep('GET', '/users/me').calls, 5000);
  assert.equal(ep('GET', '/users/{id}').calls, 4000);
  assert.equal(ep('PATCH', '/users/{id}').class, 'not_seen');
  assert.equal(ep('GET', '/orders/{orderId}').class, 'rare');
  assert.equal(ep('POST', '/orders/{orderId}/cancel').class, 'not_seen');
  assert.equal(ep('GET', '/legacy/items').class, 'deprecated_in_use');
  assert.equal(ep('GET', '/legacy/old').class, 'not_seen');
  assert.equal(ep('GET', '/reports/monthly').periodicHint, true);
  assert.equal(ep('GET', '/orders').periodicHint, false);
});

test('classify: shadow vs noise', () => {
  const sh = r.shadow.map((s) => `${s.kind} ${s.method} ${s.path}`).sort();
  assert.deepEqual(sh, ['method_not_in_spec DELETE /v1/users/{id}', 'path_not_in_spec POST /v1/orders/{id}/refund']);
  const kinds = Object.fromEntries(r.noise.map((n) => [`${n.method} ${n.path}`, n.kind]));
  assert.equal(kinds['OPTIONS /v1/orders'], 'preflight');
  assert.equal(kinds['GET /wp-login.php'], 'probe');
  assert.equal(kinds['GET /.env'], 'probe');
  assert.equal(kinds['GET /v1/orderz'], 'not_found_only');
});

test('classify: server errors and window', () => {
  assert.deepEqual(r.serverErrors.map((e) => `${e.method} ${e.path}`), ['POST /orders']);
  assert.equal(r.window.days, 30);
  assert.equal(r.window.confidence, 'low');
  assert.equal(classify(rows, spec, { days: 120 }).window.confidence, 'high');
  assert.equal(r.totals.requests, rows.reduce((s, x) => s + x.calls, 0));
});

test('report: markdown wording and json shape', () => {
  const md = toMarkdown(r);
  assert.match(md, /Not called in 30 days/);
  assert.match(md, /not "dead"/);
  assert.doesNotMatch(md, /\bdead endpoints?\b/i);
  assert.match(md, /looks periodic/);
  const j = JSON.parse(toJson(r));
  assert.equal(j.schemaVersion, 1);
  assert.equal(typeof j.endpoints[0].status, 'object');
});

test('report: markdown escapes pipes and backticks from traffic', () => {
  const evil = parseUsage('method,path,calls,status\nGET,/x|y`z,5,200:5\n');
  const md = toMarkdown(classify(evil, spec));
  assert.match(md, /`\/x\\\|y'z`/);
});

test('baseline: CI fails only on new shadow', () => {
  const base = makeBaseline(r);
  assert.equal(compareBaseline(r, base).fail, false);
  const more = parseUsage(`${fx('shop.usage.csv')}GET,/v1/secret/admin,5,,,200:5\n`);
  const r2 = classify(more, spec);
  const cmp = compareBaseline(r2, base);
  assert.equal(cmp.fail, true);
  assert.deepEqual(cmp.newShadow.map((s) => s.path), ['/v1/secret/admin']);
  // not_seen never fails CI
  assert.equal(compareBaseline(classify([], spec), { shadow: [] }).fail, false);
});

test('spec first: literal segments that look like ids are not folded (oauth2, 2024)', async () => {
  const { literalSegments } = await import('../src/spec.mjs');
  const { isIdSegment } = await import('../src/template.mjs');
  const s = loadSpec({ paths: { '/oauth2/token': { post: {} }, '/reports/2024/summary': { get: {} }, '/items/{id}': { get: {} } } });
  const keep = literalSegments(s, isIdSegment);
  assert.deepEqual([...keep].sort(), ['2024', 'oauth2']);
  assert.equal(templatePath('/oauth2/token'), '/{id}/token'); // without a spec — the trap
  assert.equal(templatePath('/oauth2/token', { keep }), '/oauth2/token');
  const u = parseUsage('method,path,calls\nPOST,/oauth2/token,500\nGET,/reports/2024/summary,3\nGET,/items/123456,9\n', { keep });
  const rr = classify(u, s);
  assert.equal(rr.endpoints.find((e) => e.path === '/oauth2/token').class, 'used');
  assert.equal(rr.endpoints.find((e) => e.path === '/reports/2024/summary').class, 'rare');
  assert.equal(rr.shadow.length, 0);
});
