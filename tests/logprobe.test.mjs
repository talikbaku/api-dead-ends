import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { loadSpec } from '../src/spec.mjs';
import {
  sendProbes, planProbes, scanStream, verdicts, verdictsToMarkdown, markerOf, checkTarget, searchHints,
  looksLikeStaging, stagingGate, specBasePath, parseHeader, planToText, httpRequest, nodeHasBrotliBug,
} from '../src/logprobe.mjs';

const BIN = new URL('../bin/api-dead-ends.mjs', import.meta.url).pathname;
const exec = promisify(execFile);
// Always in a temp folder: `send` without -o writes probe-run-<run>.json into the current folder.
const CWD = mkdtempSync(join(tmpdir(), 'ade-lp-cwd-'));
const run = (...args) => {
  const opts = typeof args.at(-1) === 'object' ? args.pop() : {};
  return exec(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: CWD, ...opts }).then((r) => ({ status: 0, ...r }), (e) => ({ status: e.code, stdout: e.stdout, stderr: e.stderr }));
};

// 12 GET operations (so marker 1 vs 10/11/12 is exercised), plus writes and an OPTIONS.
const paths = {};
for (let i = 1; i <= 11; i++) paths[`/items${i}`] = { get: {} };
paths['/users/{id}'] = { get: {}, delete: {} };
paths['/orders'] = { post: {}, options: {} };
paths['/boom'] = { get: {} };
const DOC = { openapi: '3.0.0', info: { title: 't', version: '1' }, servers: [{ url: 'https://api.example.com/v1' }], paths };

async function staging(handler) {
  const hits = [];
  const srv = createServer((req, res) => {
    const t = Date.now();
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ t, method: req.method, url: req.url, host: req.headers.host, ua: req.headers['user-agent'], probe: req.headers['x-ade-probe'], ct: req.headers['content-type'], auth: req.headers.authorization, body });
      if (handler && handler(req, res)) return;
      if (req.url.startsWith('/v1/boom')) { req.socket.destroy(); return; } // request fails → "not reached"
      if (req.url.startsWith('/v1/items11')) { res.writeHead(302, { location: 'https://elsewhere.example/x' }); return res.end(); }
      res.setHeader('content-type', 'application/json');
      res.end('{"secret":"never stored"}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, hits, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); return new Promise((r) => srv.close(r)); } };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'ade-lp-'));
const manifestOf = (run, probes, extra = {}) => ({ kind: 'api-dead-ends/logging-probe-run', run, prefix: `ade-${run}`, target: 'http://x', started: 'a', finished: 'b', probes, notSent: [], ...extra });

test('logging-probe: plan — GET/HEAD only by default, placeholder params, base path not doubled, cap', () => {
  const spec = loadSpec(DOC);
  const { plan, notSent } = planProbes(spec, { basePath: '' });
  assert.ok(plan.every((p) => p.send === 'GET'));
  assert.ok(plan.find((p) => p.urlPath === '/v1/users/ade-probe'));
  assert.deepEqual(notSent.map((s) => s.method).sort(), ['DELETE', 'OPTIONS', 'POST']);
  assert.ok(planProbes(spec, { basePath: '/v1' }).plan.every((p) => p.urlPath.startsWith('/v1/') && !p.urlPath.startsWith('/v1/v1')));
  const capped = planProbes(spec, { maxOps: 3 });
  assert.equal(capped.plan.length, 3);
  assert.ok(capped.notSent.some((s) => /max-ops/.test(s.reason)));
  const w = planProbes(spec, { includeWrites: true });
  assert.ok(w.plan.find((p) => p.send === 'DELETE') && w.plan.find((p) => p.send === 'POST'));
  assert.ok(!w.plan.find((p) => p.send === 'OPTIONS'));
});

test('logging-probe: only http(s), no credentials in the URL', async () => {
  for (const u of ['file:///etc/passwd', 'ftp://x/', 'javascript:alert(1)', 'not a url']) assert.throws(() => checkTarget(u));
  assert.throws(() => checkTarget('http://user:pw@127.0.0.1/'), /credentials/);
  await assert.rejects(sendProbes({ url: 'file:///etc/passwd', spec: loadSpec(DOC) }), /http/);
});

test('logging-probe: a spec base path or spec path can never move a probe to another host or port', async () => {
  const target = 'http://local.test:8080';
  const evil = [
    { swagger: '2.0', info: { title: 't', version: '1' }, basePath: 'host:18089', paths: { '/users/{id}': { get: {} } } },
    { swagger: '2.0', info: { title: 't', version: '1' }, basePath: '//evil.example:18089', paths: { '/a': { get: {} } } },
    { swagger: '2.0', info: { title: 't', version: '1' }, basePath: '/\\evil.example', paths: { '/a': { get: {} } } },
    { openapi: '3.0.0', info: { title: 't', version: '1' }, servers: [{ url: '//evil.example:1/x' }], paths: { '/a': { get: {} } } },
    { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '//evil.example/a': { get: {} }, '/\\evil.example/b': { get: {} }, '/q?x=1#f': { get: {} }, 'http://evil.example/c': { get: {} } } },
  ];
  for (const doc of evil) {
    const urls = [];
    await sendProbes({ url: target, spec: loadSpec(doc), specBase: specBasePath(doc), rate: 50, run: 'abc123ef', requestImpl: async (u) => { urls.push(u); return { status: 200, location: '' }; } });
    assert.ok(urls.length > 0);
    for (const u of urls) assert.equal(new URL(u).origin, target, `${u} left the target`);
  }
  // The exact repro: basePath "host:18089" stays a path on the target.
  const p = planProbes(loadSpec(evil[0]), { specBase: specBasePath(evil[0]), origin: target });
  assert.equal(p.plan[0].url, `${target}/host:18089/users/ade-probe`);
  // "?" and "#" from a spec path are encoded, never a query or fragment.
  const q = planProbes(loadSpec(evil[4]), { specBase: '', origin: target }).plan.find((x) => x.path === '/q?x=1#f');
  assert.equal(new URL(q.url).search, '');
  assert.equal(new URL(q.url).hash, '');
});

test('logging-probe: servers[0].url variables use their defaults; templated segments without a default are dropped; --base-path overrides', () => {
  const doc = {
    openapi: '3.0.0', info: { title: 't', version: '1' },
    servers: [{ url: 'https://{region}.api.example.com/{basePath}', variables: { basePath: { default: 'v2' } } }],
    paths: { '/items/{id}': { get: {} }, '/files/{name}.{ext}': { head: {} } },
  };
  assert.equal(specBasePath(doc), '/v2');
  const spec = loadSpec(doc);
  const urls = planProbes(spec, { specBase: specBasePath(doc) }).plan.map((p) => p.urlPath).sort();
  assert.deepEqual(urls, ['/v2/files/ade-probe.ade-probe', '/v2/items/ade-probe']);
  // --url already ends with the base: not doubled
  assert.ok(planProbes(spec, { basePath: '/v2', specBase: '/v2' }).plan.every((p) => !p.urlPath.startsWith('/v2/v2')));
  // /api/{version} without a default and --url …/api/v3: /api is already in the URL path
  const doc2 = { openapi: '3.0.0', info: { title: 't', version: '1' }, servers: [{ url: '/api/{version}' }], paths: { '/items': { get: {} } } };
  assert.equal(specBasePath(doc2), '/api');
  assert.equal(planProbes(loadSpec(doc2), { basePath: '/api/v3', specBase: specBasePath(doc2) }).plan[0].urlPath, '/api/v3/items');
  // overrides: '' = none, '/v9' = exactly that
  assert.equal(planProbes(loadSpec(doc2), { baseOverride: '' }).plan[0].urlPath, '/items');
  assert.equal(planProbes(loadSpec(doc2), { basePath: '/gw', baseOverride: '/v9/' }).plan[0].urlPath, '/gw/v9/items');
  assert.equal(specBasePath({ swagger: '2.0', basePath: '/../v1/./' }), '/v1');
  assert.equal(specBasePath({ openapi: '3.0.0', servers: [{ url: 'https://api.example.com' }] }), '');
});

test('logging-probe: staging heuristic and gate', () => {
  for (const u of ['http://localhost:3000', 'http://127.0.0.1', 'http://10.1.2.3', 'http://192.168.0.5', 'http://172.20.0.1', 'http://[::1]:8080', 'https://staging.shop.com', 'https://api-stg.shop.com', 'https://qa2.shop.com', 'https://api.dev.shop.com', 'https://sandbox.shop.com']) assert.ok(looksLikeStaging(u), u);
  for (const u of ['https://api.shop.com', 'https://prod-test-results.company.com', 'https://staging.prod.company.com', 'https://demo.company.com', 'https://int.company.com', 'https://preprod.company.com', 'http://172.32.0.1', 'http://localhost.evil.com']) assert.ok(!looksLikeStaging(u), u);
  assert.equal(stagingGate({ origin: 'http://127.0.0.1' }).action, 'go');
  assert.equal(stagingGate({ origin: 'https://api.shop.com' }).action, 'refuse');
  assert.equal(stagingGate({ origin: 'https://api.shop.com', tty: true }).action, 'ask');
  assert.equal(stagingGate({ origin: 'https://api.shop.com', targetIsStaging: true }).action, 'go');
  const w = stagingGate({ origin: 'https://api.shop.com', targetIsStaging: true, includeWrites: true, tty: true });
  assert.equal(w.action, 'refuse');
  assert.match(w.reason, /always refused/);
  assert.equal(stagingGate({ origin: 'https://staging.shop.com', includeWrites: true }).action, 'go');
});

test('logging-probe: --header parsing (env values, reserved names)', () => {
  assert.deepEqual(parseHeader('Authorization: Bearer abc'), ['Authorization', 'Bearer abc']);
  assert.deepEqual(parseHeader('Authorization: $TOK', { TOK: 'Bearer env' }), ['Authorization', 'Bearer env']);
  assert.deepEqual(parseHeader('X-Api-Key: ${K}', { K: 'k1' }), ['X-Api-Key', 'k1']);
  assert.throws(() => parseHeader('Authorization: $MISSING', {}), /MISSING is not set/);
  assert.throws(() => parseHeader('no colon'), /Name: value/);
  assert.throws(() => parseHeader('User-Agent: x'), /cannot be replaced/);
  assert.throws(() => parseHeader('X-ADE-Probe: x'), /cannot be replaced/);
});

test('logging-probe send: markers in header, User-Agent and query; GET only; rate limit; no bodies kept; redirects not followed', async () => {
  const s = await staging();
  try {
    const calls = [];
    const logs = [];
    const m = await sendProbes({ url: s.url, spec: loadSpec(DOC), rate: 20, timeoutMs: 2000, version: '9.9.9', run: 'abc123ef', log: (x) => logs.push(x), requestImpl: (u, o) => { calls.push(Date.now()); return httpRequest(u, o); } });
    assert.equal(m.probes.length, 13);
    assert.ok(s.hits.every((h) => h.method === 'GET'), 'GET only by default');
    for (const h of s.hits) {
      const id = h.probe;
      assert.match(id, /^ade-abc123ef-\d{4}$/);
      assert.equal(h.ua, `api-dead-ends-logging-probe/9.9.9 ${id}`);
      assert.equal(new URL(h.url, 'http://x').searchParams.get('ade_probe'), id);
    }
    assert.ok(!s.hits.some((h) => h.url.includes('elsewhere')), 'redirect not followed');
    // 20/s → each request starts ≥ 50 ms after the previous one (measured where the limiter acts, not at the server).
    const gaps = calls.slice(1).map((t, k) => t - calls[k]);
    assert.ok(Math.min(...gaps) >= 48, `rate limit: gap ${Math.min(...gaps)} ms at 20/s`);
    const redirect = m.probes.find((p) => p.path === '/items11');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.redirect, 'other host (not followed)');
    const boom = m.probes.find((p) => p.path === '/boom');
    assert.equal(boom.status, 0);
    assert.ok(boom.error);
    assert.ok(!JSON.stringify(m).includes('never stored'), 'response bodies are not stored');
    assert.ok(m.started <= m.finished);
    assert.ok(logs.some((l) => / → 200 \(\d+ ms\)/.test(l)));
    const hints = searchHints(m, 'run.json');
    assert.match(hints, /\|= "ade-abc123ef"/);
    assert.match(hints, /<your-service>/);
    assert.match(hints, /grep -h 'ade-abc123ef' app\.log > logs\.txt/);
    assert.doesNotMatch(hints, /nginx\/access/);
    assert.match(hints, /logging-probe verify --run run\.json/);
  } finally { await s.close(); }
});

test('logging-probe send: control characters in spec paths are not printed raw', async () => {
  const doc = { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/users/\u001b]0;PWNED\u0007': { get: {} }, '/c1/\u009b2J': { get: {} } } };
  const logs = [];
  await sendProbes({ url: 'http://127.0.0.1:9', spec: loadSpec(doc), rate: 50, run: 'abc123ef', log: (x) => logs.push(x), requestImpl: async () => ({ status: 200, location: '' }) });
  for (const l of logs) assert.doesNotMatch(l, /[\u0000-\u001f\u007f-\u009f]/);
  assert.match(logs[0], /PWNED\?/);
  assert.doesNotMatch(planToText(planProbes(loadSpec(doc), {})), /[\u001b\u0007\u009b]/);
});

test('logging-probe send: writes are a deliberately invalid {} JSON request', async () => {
  const s = await staging();
  try {
    await sendProbes({ url: s.url, spec: loadSpec(DOC), rate: 50, includeWrites: true, run: 'abc123ef' });
    const writes = s.hits.filter((h) => h.method !== 'GET');
    assert.deepEqual(writes.map((h) => h.method).sort(), ['DELETE', 'POST']);
    for (const h of writes) { assert.equal(h.ct, 'application/json'); assert.equal(h.body, '{}'); }
    assert.ok(!s.hits.some((h) => h.method === 'OPTIONS'));
  } finally { await s.close(); }
});

test('logging-probe verify: markers split across chunks, prefix-safe; logged / NOT logged / gateway / not reached', async () => {
  const run = 'abc123ef';
  const status = { 1: 200, 2: 200, 3: 0, 4: 401, 5: 302, 6: 404, 10: 200, 11: 200 };
  const probes = Object.keys(status).map(Number).map((n) => ({ n, marker: markerOf(run, n), method: 'GET', path: `/p${n}`, status: status[n], error: status[n] ? '' : 'timeout' }));
  const manifest = manifestOf(run, probes);
  // ade-abc123ef-0010 is logged; 0001 must NOT be taken from it. 0011 is cut in the middle of a chunk boundary.
  const text = `{"ua":"api-dead-ends-logging-probe/1 ${markerOf(run, 10)}"} ade-other99-0001 ${markerOf(run, 2)} ${markerOf(run, 2)}\nxx ${markerOf(run, 11)}\n`;
  const cut = text.indexOf(markerOf(run, 11)) + 9;
  const hits = new Map();
  const st = await scanStream(Readable.from([Buffer.from(text.slice(0, cut)), Buffer.from(text.slice(cut))]), run, hits);
  assert.equal(st.lines, 2);
  const r = verdicts(manifest, hits, { perFile: [{ file: 'app.log', hits }] });
  const v = Object.fromEntries(r.rows.map((x) => [x.path, x.verdict]));
  assert.deepEqual(v, { '/p1': 'not logged', '/p2': 'logged', '/p3': 'not reached', '/p4': 'gateway', '/p5': 'gateway', '/p6': 'gateway', '/p10': 'logged', '/p11': 'logged' });
  assert.equal(r.rows.find((x) => x.path === '/p2').hits, 2);
  assert.deepEqual(r.rows.find((x) => x.path === '/p2').foundIn, [{ file: 'app.log', hits: 2 }]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.totals.gateway, 3);
  const md = verdictsToMarkdown(r);
  assert.match(md, /\*\*NOT logged\*\*/);
  assert.match(md, /answered by gateway\/auth \(handler maybe not reached\)/);
  assert.match(md, /\| Found in \|/);
  assert.match(md, /`app\.log` \(2\)/);
  // nothing found at all → "unknown (check the export)", not NOT logged; gateway and not reached stay
  const none = verdicts(manifest, new Map());
  assert.equal(none.found, false);
  assert.match(none.warnings[0], /wrong export/);
  assert.equal(none.totals.notLogged, 0);
  assert.equal(none.rows.find((x) => x.path === '/p1').verdict, 'unknown');
  assert.equal(none.rows.find((x) => x.path === '/p4').verdict, 'gateway');
  assert.match(verdictsToMarkdown(none), /unknown \(check the export\)/);
  assert.throws(() => verdicts({ kind: 'x' }, new Map()), /manifest/);
});

test('logging-probe verify: access-log-like file names get a warning', () => {
  const run = 'abc123ef';
  const m = manifestOf(run, [{ n: 1, marker: markerOf(run, 1), method: 'GET', path: '/a', status: 200 }]);
  const h = new Map([[1, 1]]);
  for (const f of ['/var/log/nginx/access.log', 'ingress-export.json', 'gateway.jsonl.gz']) assert.equal(verdicts(m, h, { files: [f] }).warnings.length, 1, f);
  assert.equal(verdicts(m, h, { files: ['app.log', '-'] }).warnings.length, 0);
});

test('logging-probe CLI: send → manifest + hints, verify (.gz and plain, repeated --logs) → markdown/json; flags gate writes', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(DOC));
  const s = await staging();
  try {
    const one = await run('logging-probe', 'send', '--url', s.url, '--spec', join(dir, 'spec.json'), '--include-writes');
    assert.equal(one.status, 2);
    assert.match(one.stderr, /both --include-writes and --i-understand-this-is-staging/);
    const other = await run('logging-probe', 'send', '--url', s.url, '--spec', join(dir, 'spec.json'), '--i-understand-this-is-staging');
    assert.equal(other.status, 2);
    assert.equal(s.hits.length, 0, 'nothing sent when the gate fails');
    const bad = await run('logging-probe', 'send', '--url', 'file:///etc/passwd', '--spec', join(dir, 'spec.json'));
    assert.equal(bad.status, 2);

    const r = await run('logging-probe', 'send', '--url', s.url, '--spec', join(dir, 'spec.json'), '--rate', '50', '--timeout', '2', '-o', join(dir, 'run.json'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /never on production/);
    assert.match(r.stderr, /LogsQL/);
    assert.match(r.stderr, /CloudWatch/);
    assert.match(r.stderr, /→ 200/);
    const m = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    assert.equal(m.probes.length, 13);
    assert.ok(s.hits.every((h) => h.method === 'GET'));

    // Synthetic logs: the app logged items1..items5 (in UA or query), not the rest.
    const lines = m.probes.filter((p) => /^\/items[1-5]$/.test(p.path)).map((p, i) => (i % 2 ? `{"msg":"request","url":"${p.urlPath}?ade_probe=${p.marker}"}` : `127.0.0.1 - - "GET ${p.urlPath} HTTP/1.1" 200 2 "-" "api-dead-ends-logging-probe/1 ${p.marker}"`));
    writeFileSync(join(dir, 'a.log'), lines.slice(0, 3).join('\n') + '\n');
    writeFileSync(join(dir, 'b.log.gz'), gzipSync(lines.slice(3).join('\n') + '\n'));
    writeFileSync(join(dir, 'empty.log'), 'nothing here\n');
    const vj = await run('logging-probe', 'verify', '--run', join(dir, 'run.json'), '--logs', join(dir, 'a.log'), join(dir, 'b.log.gz'), '--json');
    assert.equal(vj.status, 0, vj.stderr);
    const j = JSON.parse(vj.stdout);
    assert.equal(j.totals.logged, 5);
    assert.equal(j.totals.notReached, 1); // /boom
    assert.equal(j.totals.gateway, 1); // /items11 → 302
    assert.equal(j.totals.notLogged, 6);
    assert.equal(j.totals.notSent, 3);
    assert.equal(j.rows.find((x) => x.path === '/boom').verdict, 'not reached');
    assert.deepEqual(j.rows.find((x) => x.path === '/items1').foundIn.map((f) => f.file), [join(dir, 'a.log')]);
    // --logs given more than once: every file is read
    const rep = await run('logging-probe', 'verify', '--run', join(dir, 'run.json'), '--logs', join(dir, 'a.log'), '--logs', join(dir, 'empty.log'), '--logs', join(dir, 'b.log.gz'), '--json');
    assert.equal(rep.status, 0, rep.stderr);
    assert.equal(JSON.parse(rep.stdout).totals.logged, 5);
    assert.equal(JSON.parse(rep.stdout).source.files.length, 3);
    // -o: a folder, a .md file, a .json file
    const vo = await run('logging-probe', 'verify', '--run', join(dir, 'run.json'), '--logs', join(dir, 'a.log'), '-o', join(dir, 'out'));
    assert.equal(vo.status, 0, vo.stderr);
    assert.match(readFileSync(join(dir, 'out', 'logging-probe.md'), 'utf8'), /logging-check/);
    assert.ok(existsSync(join(dir, 'out', 'logging-probe.json')));
    assert.equal(vo.stdout, '');
    const vmd = await run('logging-probe', 'verify', '--run', join(dir, 'run.json'), '--logs', join(dir, 'a.log'), '-o', join(dir, 'result.md'));
    assert.equal(vmd.status, 0, vmd.stderr);
    assert.match(readFileSync(join(dir, 'result.md'), 'utf8'), /^# api-dead-ends: logging probe/);
    const vjs = await run('logging-probe', 'verify', '--run', join(dir, 'run.json'), '--logs', join(dir, 'a.log'), '-o', join(dir, 'result.json'));
    assert.equal(vjs.status, 0, vjs.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')).totals.logged, 3);
    // zero markers → unknown, exit 1
    const z = await run('logging-probe', 'verify', '--run', join(dir, 'run.json'), '--logs', join(dir, 'empty.log'), '--json');
    assert.equal(z.status, 1);
    const zj = JSON.parse(z.stdout);
    assert.equal(zj.totals.notLogged, 0);
    assert.ok(zj.totals.unknown > 0);
    assert.match(z.stderr, /wrong export/);
    // access-log-like name → warning
    writeFileSync(join(dir, 'nginx-access.log'), readFileSync(join(dir, 'a.log')));
    const acc = await run('logging-probe', 'verify', '--run', join(dir, 'run.json'), '--logs', join(dir, 'nginx-access.log'), '--json');
    assert.match(acc.stderr, /looks like an access/);

    const notManifest = await run('logging-probe', 'verify', '--run', join(dir, 'spec.json'), '--logs', join(dir, 'a.log'));
    assert.equal(notManifest.status, 2);
    const help = await run('logging-probe', '--help');
    assert.match(help.stdout, /NEVER point it at production/);
    assert.match(help.stdout, /--dry-run/);
    assert.equal((await run('logging-probe')).status, 2);
  } finally { await s.close(); }
});

test('logging-probe CLI: --dry-run sends and writes nothing; unused flags are refused', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(DOC));
  const s = await staging();
  try {
    const before = readdirSync(CWD).length;
    const d = await run('logging-probe', 'send', '--url', s.url, '--spec', join(dir, 'spec.json'), '--dry-run', '-o', join(dir, 'never.json'));
    assert.equal(d.status, 0, d.stderr);
    assert.equal(s.hits.length, 0, 'dry run sends nothing');
    assert.ok(!existsSync(join(dir, 'never.json')), 'dry run writes nothing');
    assert.equal(readdirSync(CWD).length, before);
    assert.match(d.stdout, /13 request\(s\) would be sent/);
    assert.match(d.stdout, new RegExp(`${s.url}/v1/users/ade-probe`));
    assert.match(d.stdout, /not sent/);
    // dry run on a host that does not look like staging: says a real run would be refused
    const d2 = await run('logging-probe', 'send', '--url', 'https://api.shop.invalid', '--spec', join(dir, 'spec.json'), '--dry-run');
    assert.equal(d2.status, 0);
    assert.match(d2.stdout, /would be refused/);
    for (const f of ['--yes', '--json', '--force']) {
      const x = await run('logging-probe', 'send', '--url', s.url, '--spec', join(dir, 'spec.json'), f);
      assert.equal(x.status, 2, f);
      assert.match(x.stderr, /does not take/);
    }
    const y = await run('logging-probe', 'verify', '--run', 'x.json', '--logs', 'a.log', '--dry-run');
    assert.equal(y.status, 2);
    assert.match(y.stderr, /does not take --dry-run/);
    assert.equal(s.hits.length, 0);
  } finally { await s.close(); }
});

test('logging-probe CLI: a host that does not look like staging is refused without --target-is-staging; writes always', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(DOC));
  const r = await run('logging-probe', 'send', '--url', 'https://api.shop.invalid', '--spec', join(dir, 'spec.json'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Refused: .*--target-is-staging/);
  assert.doesNotMatch(r.stderr, /→/, 'nothing sent');
  const w = await run('logging-probe', 'send', '--url', 'https://prod-test.shop.invalid', '--spec', join(dir, 'spec.json'), '--target-is-staging', '--include-writes', '--i-understand-this-is-staging');
  assert.equal(w.status, 2);
  assert.match(w.stderr, /always refused/);
});

test('logging-probe CLI: all requests failed → "No request reached the target", no export hints, exit 1; default manifest file in the current folder', async () => {
  const dir = tmp();
  const cwd = tmp();
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/a': { get: {} } } }));
  // port 9 on localhost: connection refused
  const r = await run('logging-probe', 'send', '--url', 'http://127.0.0.1:9', '--spec', join(dir, 'spec.json'), '--rate', '50', '--timeout', '2', { cwd });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /No request reached the target/);
  assert.doesNotMatch(r.stderr, /Time window to export/);
  const files = readdirSync(cwd);
  assert.equal(files.length, 1);
  assert.match(files[0], /^probe-run-[a-z0-9]+\.json$/);
  assert.equal(r.stdout, '', 'manifest goes to a file, not stdout');
});

test('logging-probe CLI: --header values reach the server but never the manifest or the output; gateway verdict', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/a': { get: {} }, '/b': { get: {} } } }));
  const SECRET = 'Bearer s3cr3t-token-value';
  const s = await staging((req, res) => { res.writeHead(req.headers.authorization === SECRET && req.url.startsWith('/a') ? 200 : 401); res.end(); return true; });
  try {
    const env = { ...process.env, STAGING_TOKEN: SECRET };
    const r = await run('logging-probe', 'send', '--url', s.url, '--spec', join(dir, 'spec.json'), '--header', 'Authorization: $STAGING_TOKEN', '--header', 'X-Tenant: t1', '--rate', '50', '-o', join(dir, 'run.json'), { env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(s.hits.every((h) => h.auth === SECRET));
    const man = readFileSync(join(dir, 'run.json'), 'utf8');
    for (const out of [man, r.stdout, r.stderr]) assert.ok(!out.includes('s3cr3t'), 'header value leaked');
    assert.deepEqual(JSON.parse(man).headerNames, ['Authorization', 'X-Tenant']);
    const dry = await run('logging-probe', 'send', '--url', s.url, '--spec', join(dir, 'spec.json'), '--header', 'Authorization: $STAGING_TOKEN', '--dry-run', { env });
    assert.ok(!dry.stdout.includes('s3cr3t') && !dry.stderr.includes('s3cr3t'));
    assert.match(dry.stdout, /Authorization \(values hidden\)/);
    const unset = await run('logging-probe', 'send', '--url', s.url, '--spec', join(dir, 'spec.json'), '--header', 'Authorization: $NO_SUCH_VAR_ADE');
    assert.equal(unset.status, 2);
    assert.match(unset.stderr, /NO_SUCH_VAR_ADE is not set/);
    // /a logged (200), /b: 401 and not logged → answered by gateway/auth, not NOT logged
    const m = JSON.parse(man);
    writeFileSync(join(dir, 'app.log'), `GET /a ${m.probes.find((p) => p.path === '/a').marker}\n`);
    const v = await run('logging-probe', 'verify', '--run', join(dir, 'run.json'), '--logs', join(dir, 'app.log'));
    assert.equal(v.status, 0, v.stderr);
    assert.match(v.stdout, /\| answered by gateway\/auth \(handler maybe not reached\) \| GET \| `\/b` \| 401 \|/);
    assert.match(v.stderr, /1 logged · 0 NOT logged · 1 answered by gateway\/auth/);
  } finally { await s.close(); }
});

test('logging-check: refuses a missing folder, active-check flags, and suggests logging-probe for send/verify', async () => {
  const a = await run('logging-check', 'send', '--url', 'http://x', '--spec', 'spec.yaml');
  assert.equal(a.status, 2);
  assert.match(a.stderr, /did you mean: api-dead-ends logging-probe send/i);
  const b = await run('logging-check', 'verify');
  assert.match(b.stderr, /logging-probe verify/);
  assert.equal((await run('logging-check', join(tmpdir(), 'ade-no-such-folder-xyz'))).status, 2);
  const c = await run('logging-check', tmp(), '--run', 'x.json');
  assert.equal(c.status, 2);
  assert.match(c.stderr, /does not take --run/);
  assert.equal((await run('logging-check', tmp())).status, 0);
});

test('init: --logs still works as one string, and repeated --logs become a file list', async () => {
  const cwd = tmp();
  const one = await run('init', '--yes', '--dry-run', '--json', '--source', 'accesslog', '--logs', '/var/log/app/a.log', { cwd });
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /convert accesslog \/var\/log\/app\/a\.log /);
  const two = await run('init', '--yes', '--dry-run', '--json', '--source', 'accesslog', '--logs', 'a.log', '--logs', 'b.log', { cwd });
  assert.equal(two.status, 0, two.stderr);
  assert.match(two.stdout, /convert accesslog a\.log b\.log /);
});

test('logging-probe send: uses node:http, never decompresses a Brotli body; Node versions with the Brotli bug are flagged', async () => {
  const junk = Buffer.alloc(1 << 20, 0xff); // not valid Brotli
  const s = await staging((req, res) => { res.writeHead(200, { 'content-encoding': 'br', 'content-type': 'text/plain' }); res.end(junk); return true; });
  try {
    const t0 = Date.now();
    const m = await sendProbes({ url: s.url, spec: loadSpec({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/a': { get: {} } } }), rate: 50, timeoutMs: 2000, run: 'abc123ef' });
    assert.equal(m.probes[0].status, 200);
    assert.equal(m.probes[0].error, '');
    assert.ok(Date.now() - t0 < 1500);
    const r = await httpRequest(`${s.url}/x`, { method: 'GET', headers: {}, timeoutMs: 2000 });
    assert.equal(r.status, 200);
  } finally { await s.close(); }
  // a server that never answers → timeout
  const hang = createServer(() => {});
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const m = await sendProbes({ url: `http://127.0.0.1:${hang.address().port}`, spec: loadSpec({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/a': { get: {} } } }), rate: 50, timeoutMs: 200, run: 'abc123ef' });
    assert.equal(m.probes[0].error, 'timeout');
  } finally { hang.closeAllConnections(); await new Promise((r) => hang.close(r)); }
  for (const v of ['20.19.0', '22.23.4', '22.11.0', '24.22.2', '23.1.0']) assert.ok(nodeHasBrotliBug(v), v);
  for (const v of ['22.23.5', '22.24.0', '24.22.3', '24.23.0', '26.0.0']) assert.ok(!nodeHasBrotliBug(v), v);
});

test('check-logging (the mirror name) is not a command: points to logging-probe', async () => {
  const r = await run('check-logging', 'send', '--url', 'http://x', '--spec', 'y.json');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Did you mean: api-dead-ends logging-probe send/);
});

test("logging-probe CLI: --base-path '' survives argument parsing", async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(DOC));
  const r = await run('logging-probe', 'send', '--url', 'http://127.0.0.1:9', '--spec', join(dir, 'spec.json'), '--base-path', '', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /http:\/\/127\.0\.0\.1:9\/items1\n/);
  assert.doesNotMatch(r.stdout, /\/v1\//);
});
