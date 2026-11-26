import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = new URL('../bin/api-dead-ends.mjs', import.meta.url).pathname;
const FX = new URL('./fixtures/', import.meta.url).pathname;
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('cli: no args → help, exit 2; unknown source → exit 2', () => {
  assert.equal(run().status, 2);
  assert.equal(run('query', 'nosuch').status, 2);
  assert.match(run('--help', 'x').stdout, /Exit codes/);
});

test('cli: query prints runnable text for every source', () => {
  for (const s of ['elasticsearch', 'opensearch', 'datadog', 'datadog-apm', 'prometheus', 'loki', 'victorialogs', 'appinsights', 'azure-apim', 'cloudwatch', 'athena', 'bigquery', 'newrelic', 'dynatrace', 'splunk', 'csv', 'accesslog']) {
    const r = run('query', s, '--service', 'svc', '--days', '7');
    assert.equal(r.status, 0, s);
    assert.ok(r.stdout.length > 50, s);
  }
});

test('cli: convert + report + baseline end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-'));
  const resp = { aggregations: { ep: { buckets: [
    { key: { method: 'GET', path: '/v1/users/7' }, doc_count: 500, status: { buckets: [{ key: 200, doc_count: 500 }] } },
    { key: { method: 'GET', path: '/v1/hidden' }, doc_count: 9, status: { buckets: [{ key: 200, doc_count: 9 }] } },
  ] } } };
  writeFileSync(join(dir, 'es.json'), JSON.stringify(resp));
  const c = run('convert', 'elasticsearch', join(dir, 'es.json'), '-o', join(dir, 'usage.csv'));
  assert.equal(c.status, 0, c.stderr);
  assert.match(readFileSync(join(dir, 'usage.csv'), 'utf8'), /GET,\/v1\/users\/\{id\},500/);

  const r = run('report', '--usage', join(dir, 'usage.csv'), '--spec', join(FX, 'shop.openapi.json'), '--out', join(dir, 'rep'), '--write-baseline', join(dir, 'base.json'));
  assert.equal(r.status, 0, r.stderr);
  const md = readFileSync(join(dir, 'rep', 'report.md'), 'utf8');
  assert.match(md, /`\/v1\/hidden`/);

  // same traffic vs the baseline → ok; empty baseline → new shadow → exit 1
  assert.equal(run('report', '--usage', join(dir, 'usage.csv'), '--spec', join(FX, 'shop.openapi.json'), '--out', join(dir, 'rep'), '--baseline', join(dir, 'base.json')).status, 0);
  writeFileSync(join(dir, 'empty.json'), '{"shadow":[]}');
  const f = run('report', '--usage', join(dir, 'usage.csv'), '--spec', join(FX, 'shop.openapi.json'), '--out', join(dir, 'rep'), '--baseline', join(dir, 'empty.json'));
  assert.equal(f.status, 1);
  assert.match(f.stderr, /NEW SHADOW: GET \/v1\/hidden/);
});

test('cli: bad spec → exit 2 with message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-'));
  writeFileSync(join(dir, 'bad.json'), '{}');
  const r = run('report', '--usage', join(FX, 'shop.usage.csv'), '--spec', join(dir, 'bad.json'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /paths/);
});
