// report.html accessibility guards: colour contrast (WCAG AA 4.5:1) of the theme tokens in light and dark mode,
// and the ARIA structure the page script relies on. A full check (axe-core + keyboard, Playwright) was run by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from '../src/html.mjs';
import { classify } from '../src/classify.mjs';
import { computeWindows } from '../src/windows.mjs';
import { toMarkdown, toJson } from '../src/report.mjs';
import { loadSpec } from '../src/spec.mjs';

const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const tokens = (css) => Object.fromEntries([...css.matchAll(/--([\w-]+):#([0-9a-f]{3,6})\b/g)].map((m) => [m[1], '#' + (m[2].length === 3 ? [...m[2]].map((c) => c + c).join('') : m[2])]));

test('report.html: text colours meet WCAG AA (4.5:1) in light and dark mode', () => {
  const html = toHtml(classify([], { title: 't', version: '1', ops: [] }), {});
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  const light = tokens(css.split('@media')[0]), dark = { ...light, ...tokens(css.split('@media')[1]) };
  const pairs = [['ink', 'panel'], ['ink', 'bg'], ['muted', 'panel'], ['muted', 'bg'], ['muted', 'gray-s'], ['faint', 'panel'], ['faint', 'bg'],
    ['bad', 'bad-s'], ['warn', 'warn-s'], ['bad', 'panel'], ['warn', 'panel'], ['acc', 'panel']];
  for (const [name, t] of [['light', light], ['dark', dark]]) for (const [f, b] of pairs) {
    assert.ok(ratio(t[f], t[b]) >= 4.5, `${name}: --${f} on --${b} is ${ratio(t[f], t[b]).toFixed(2)}:1`);
  }
});

test('report.html: tabs, panel, window selector and focus style are in place', () => {
  const html = toHtml(classify([], { title: 't', version: '1', ops: [] }), {});
  for (const s of ['lang="en"', 'role="tablist"', 'role="tabpanel"', 'aria-label="Time window"', 'aria-live="polite"', '<main>', ':focus-visible', "role: 'tab'", "'aria-selected'", "'aria-pressed'", "setAttribute('role', 'img')", "'ArrowRight'", "scope: 'col'"]) assert.ok(html.includes(s), s);
  assert.equal(/<div[^>]*onclick/.test(html), false);
});

test('report.html: 5xx over/below threshold is said in words, sparklines get a short summary', () => {
  const html = toHtml(classify([], { title: 't', version: '1', ops: [] }), {});
  for (const s of ['"over":"over threshold"', '"below":"below threshold"', 'S.over : S.below', '"total":"total"', '"peak":"peak"', '"last":"last"', "': ' + S.total + ' '", "', ' + S.peak + ' '", "', ' + S.last + ' '"]) assert.ok(html.includes(s), s);
  assert.equal(html.includes("arr.map((v, i) => (D.days[i]"), false, 'the label no longer lists every day');
});

test('report.html: font sizes in rem (follow the browser font size), forced-colors styles present', () => {
  const html = toHtml(classify([], { title: 't', version: '1', ops: [] }), {});
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.equal(/font(-size)?:[^;}]*\d(\.\d+)?px/.test(css), false, 'no px font sizes');
  const fc = css.slice(css.indexOf('@media (forced-colors:active)'));
  assert.ok(fc.startsWith('@media (forced-colors:active)'), 'forced-colors block');
  for (const s of ['.seg button.on', '.tabs button.on', 'outline:2px solid CanvasText', '.badge', 'border:1px solid', 'rect.out', 'GrayText', 'Highlight']) assert.ok(fc.includes(s), s);
});

test('report.md and report.json: per-day numbers for endpoints with 5xx', () => {
  const spec = loadSpec({ paths: { '/a': { get: {} }, '/b': { get: {} } } });
  const days = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'];
  const rows = days.flatMap((day, i) => [
    { method: 'GET', path: '/a', calls: 100, status: new Map(i === 4 ? [['200', 60], ['500', 40]] : [['200', 100]]), day },
    { method: 'GET', path: '/b', calls: 50, status: new Map([['200', 50]]), day },
  ]);
  const win = computeWindows(rows, spec, { now: Date.parse('2026-03-10') });
  const r = win.windows.all;
  const md = toMarkdown(r, { spikes: win.spikes });
  assert.match(md, /## Per day: endpoints with 5xx/);
  assert.match(md, /### GET `\/a`\n\n\| Date \| Calls \| 5xx \|/);
  assert.match(md, /\| 2026-03-05 \| 100 \| 40 \|/);
  assert.match(md, /\| 2026-03-01 \| 100 \| 0 \|/);
  assert.equal(md.includes('### GET `/b`'), false, 'no table for endpoints without 5xx');
  const j = JSON.parse(toJson(r, { spikes: win.spikes }));
  assert.equal(j.schemaVersion, 1);
  assert.deepEqual(j.perDay.days, days);
  assert.deepEqual(j.perDay.endpoints['GET /a'].errors5xx, [0, 0, 0, 0, 40]);
  assert.deepEqual(j.perDay.endpoints['GET /b'].calls, [50, 50, 50, 50, 50]);
  // tables without dates: no per-day section, no field
  const plain = classify(rows.map((x) => ({ ...x, day: undefined })), spec, { days: 5 });
  assert.equal(toMarkdown(plain).includes('Per day'), false);
  assert.equal('perDay' in JSON.parse(toJson(plain)), false);
});
