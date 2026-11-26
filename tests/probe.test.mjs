// Runs only when Playwright is available (API_DEAD_ENDS_PLAYWRIGHT or an installed `playwright`); CI skips it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadPlaywright, probe, probeToMarkdown } from '../src/probe.mjs';
import { loadSpec } from '../src/spec.mjs';

const pw = await loadPlaywright();

test('probe: duplicates per page load, broken and slow calls, spec coverage; logout links never followed', { skip: !pw && 'Playwright not installed' }, async () => {
  const hits = [];
  const page = (body) => `<!doctype html><html><body>${body}</body></html>`;
  const srv = createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') return res.end(page(`<a href="/orders">orders</a><a href="/logout">out</a><a href="https://elsewhere.example/">ext</a>
      <script>fetch('/api/me');fetch('/api/me');fetch('/api/me');fetch('/api/products?limit=5');</script>`));
    if (u.pathname === '/orders') return res.end(page(`<script>fetch('/api/orders/12345');fetch('/api/promo/apply',{method:'POST'});fetch('/api/slow');</script>`));
    if (u.pathname === '/logout') { hits.push('LOGOUT'); return res.end(page('bye')); }
    if (u.pathname === '/api/promo/apply') { res.statusCode = 500; return res.end('{}'); }
    if (u.pathname === '/api/slow') return setTimeout(() => res.end('{}'), 400);
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const spec = loadSpec({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { '/api/me': { get: {} }, '/api/orders/{id}': { get: {} }, '/api/admin': { get: {} } } });
  try {
    const p = await probe({ url: base, pages: 5, slowMs: 300, spec });
    const row = (path) => p.rows.find((r) => r.path === path);
    assert.equal(p.pages, 2);
    assert.equal(row('/api/me').perLoad, 3);
    assert.equal(row('/api/me').problem, 'duplicate');
    assert.equal(row('/api/promo/apply').problem, 'server error');
    assert.equal(row('/api/slow').problem, 'slow');
    assert.equal(row('/api/orders/{id}').status, 200, 'IDs are templated');
    assert.ok(!hits.includes('LOGOUT'), 'logout link not followed');
    assert.deepEqual(p.notCalledByFrontend.map((x) => x.path), ['/api/admin']);
    assert.match(probeToMarkdown(p), /api\/promo\/apply/);
    assert.doesNotMatch(JSON.stringify(p), /12345|limit=5/, 'no raw IDs or query strings in the output');
  } finally {
    srv.close();
  }
});
