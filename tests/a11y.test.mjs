// report.html accessibility guards: colour contrast (WCAG AA 4.5:1) of the theme tokens in light and dark mode,
// and the ARIA structure the page script relies on. A full check (axe-core + keyboard, Playwright) was run by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHtml } from '../src/html.mjs';
import { classify } from '../src/classify.mjs';

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
