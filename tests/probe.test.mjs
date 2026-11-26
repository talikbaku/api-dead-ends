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

test('fetch kibana: logs in through the browser session, detects fields, pulls windows via the Dev Tools proxy', { skip: !pw && 'Playwright not installed' }, async () => {
  const { fetchKibana } = await import('../src/adapters/kibana.mjs');
  let searches = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/data_views/data_view/dv-12345678')) return res.end(JSON.stringify({ data_view: { title: 'logs-*', timeFieldName: '@timestamp',
        fields: { a: { name: 'http.request.method', aggregatable: true }, b: { name: 'url.original', aggregatable: true }, c: { name: 'http.response.status_code', aggregatable: true } } } }));
      if (req.url.startsWith('/api/console/proxy')) {
        searches++;
        const q = JSON.parse(body);
        if (q.aggs?.has) return res.end(JSON.stringify({ aggregations: { has: { buckets: { 'http.request.method': { doc_count: 10 }, 'url.original': { doc_count: 10 }, 'http.response.status_code': { doc_count: 10 } } } } }));
        return res.end(JSON.stringify({ aggregations: { ep: { buckets: [{ key: { method: 'GET', path: '/api/products' }, doc_count: 5, status: { buckets: [{ key: 200, doc_count: 5 }] } }] } } }));
      }
      res.setHeader('content-type', 'text/html'); res.end('<html><body>Kibana</body></html>');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/app/discover#/?_a=(dataSource:(dataViewId:'dv-12345678',type:dataView))`;
  try {
    const { rows, skipped } = await fetchKibana({ url, service: 'shop', days: 1, daily: true });
    assert.equal(skipped.length, 0);
    assert.ok(rows.length >= 8, 'one row per 3-hour window');
    assert.ok(rows.every((r) => r.path === '/api/products' && r.day));
    assert.ok(searches >= 9, 'one probe + one search per 3-hour window');
  } finally { srv.close(); }
});
