import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
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

test('cli: -o - writes to stdout and never creates a file named "-"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-'));
  const runIn = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dir });
  const resp = { aggregations: { ep: { buckets: [{ key: { method: 'GET', path: '/v1/users/7' }, doc_count: 5, status: { buckets: [{ key: 200, doc_count: 5 }] } }] } } };
  writeFileSync(join(dir, 'es.json'), JSON.stringify(resp));
  writeFileSync(join(dir, 'routes.txt'), 'GET /v1/users/:id\n');
  const c = runIn('convert', 'elasticsearch', 'es.json', '-o', '-');
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /GET,\/v1\/users\/\{id\},5/);
  const s = runIn('spec', 'from-routes', 'routes.txt', '-o', '-');
  assert.equal(s.status, 0, s.stderr);
  assert.equal(JSON.parse(s.stdout).openapi.slice(0, 1), '3');
  const r = runIn('report', '--usage', join(FX, 'shop.usage.csv'), '--spec', join(FX, 'shop.openapi.json'), '-o', '-');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.length > 100);
  assert.ok(!existsSync(join(dir, '-')));
});

test('cli: -o pointing at a directory or a symlink fails with the full path and the reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-'));
  const resp = { aggregations: { ep: { buckets: [{ key: { method: 'GET', path: '/a' }, doc_count: 1, status: { buckets: [{ key: 200, doc_count: 1 }] } }] } } };
  writeFileSync(join(dir, 'es.json'), JSON.stringify(resp));
  mkdirSync(join(dir, 'out'));
  const d = run('convert', 'elasticsearch', join(dir, 'es.json'), '-o', join(dir, 'out'));
  assert.equal(d.status, 2);
  assert.ok(d.stderr.includes(`${join(dir, 'out')} is a directory`), d.stderr);
  writeFileSync(join(dir, 'victim.txt'), 'keep');
  symlinkSync(join(dir, 'victim.txt'), join(dir, 'link.csv'));
  const l = run('convert', 'elasticsearch', join(dir, 'es.json'), '-o', join(dir, 'link.csv'));
  assert.equal(l.status, 2);
  assert.ok(l.stderr.includes(`${join(dir, 'link.csv')} is a symlink`), l.stderr);
  assert.equal(readFileSync(join(dir, 'victim.txt'), 'utf8'), 'keep');
});

test('cli: --write-baseline and --duplicates refuse symlinks; "-" goes to stdout or is refused, never a file named -', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-'));
  const runIn = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dir });
  writeFileSync(join(dir, 'victim.txt'), 'keep');
  const usage = join(FX, 'shop.usage.csv'), spec = join(FX, 'shop.openapi.json');

  symlinkSync(join(dir, 'victim.txt'), join(dir, 'base-link.json'));
  const b = runIn('report', '--usage', usage, '--spec', spec, '--out', 'rep', '--write-baseline', 'base-link.json');
  assert.equal(b.status, 2);
  assert.ok(b.stderr.includes(`${join(dir, 'base-link.json')} is a symlink`), b.stderr);
  assert.equal(readFileSync(join(dir, 'victim.txt'), 'utf8'), 'keep');
  const bOut = runIn('report', '--usage', usage, '--spec', spec, '--out', 'rep', '--write-baseline', '-');
  assert.equal(bOut.status, 0, bOut.stderr);
  assert.ok(Array.isArray(JSON.parse(bOut.stdout).shadow), bOut.stdout.slice(0, 200));
  const bMix = runIn('report', '--usage', usage, '--spec', spec, '--write-baseline', '-');
  assert.equal(bMix.status, 2);
  assert.match(bMix.stderr, /--write-baseline - would mix/);

  const L = (t, m) => `198.51.100.1 - - [10/Nov/2026:10:00:0${t} +0000] "${m} /orders HTTP/1.1" 201 1 "-" "app/1.0"`;
  writeFileSync(join(dir, 'a.log'), [L(0, 'POST'), L(1, 'POST')].join('\n') + '\n');
  symlinkSync(join(dir, 'victim.txt'), join(dir, 'dup-link.json'));
  const d = runIn('convert', 'accesslog', 'a.log', '-o', 'u.csv', '--duplicates', 'dup-link.json');
  assert.equal(d.status, 2);
  assert.ok(d.stderr.includes(`${join(dir, 'dup-link.json')} is a symlink`), d.stderr);
  assert.equal(readFileSync(join(dir, 'victim.txt'), 'utf8'), 'keep');
  const dOut = runIn('convert', 'accesslog', 'a.log', '-o', 'u.csv', '--duplicates', '-');
  assert.equal(dOut.status, 0, dOut.stderr);
  assert.ok(Array.isArray(JSON.parse(dOut.stdout).rows));
  const dMix = runIn('convert', 'accesslog', 'a.log', '--duplicates', '-');
  assert.equal(dMix.status, 2);
  assert.match(dMix.stderr, /--duplicates - would mix/);
  assert.ok(!existsSync(join(dir, '-')));
});

test('cli: a flow-style YAML spec with an error reports the YAML reason and line (not just "not valid JSON")', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ade-flow-'));
  writeFileSync(join(dir, 'flow.yaml'), '{openapi: 3.0.0, info: {title: t, version: "1"},\n paths: {/a: {get: {}}, /a: {get: {}}}}\n');
  writeFileSync(join(dir, 'u.csv'), 'method,path,calls\nGET,/a,1\n');
  const r = run('report', '--usage', join(dir, 'u.csv'), '--spec', join(dir, 'flow.yaml'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /spec is not valid JSON or YAML: duplicate key \(line 2\)/);
});
