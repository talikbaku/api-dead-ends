// @ts-check
// Time windows over a per-day usage table: the whole period, the last 7, 3 and 1 days.
// A window is "the last N days that have data" (ending at the latest day in the table, not today).

import { classify, sumStatus } from './classify.mjs';
import { addRow } from './usage.mjs';
import { matchOp } from './spec.mjs';

export const WINDOWS = [null, 7, 3, 1];

/**
 * @param {import('./usage.mjs').UsageRow[]} rows  rows with a `day` (rows without one belong to every window)
 * @param {Parameters<typeof classify>[1]} spec
 * @param {Parameters<typeof classify>[2]} [opt]
 */
export function computeWindows(rows, spec, opt = {}) {
  const days = [...new Set(rows.map((r) => r.day).filter(Boolean))].sort();
  if (!days.length) return null;
  const last = days.at(-1);
  const total = days.length;
  /** @type {Record<string, ReturnType<typeof classify>>} */
  const windows = {};
  for (const n of WINDOWS) {
    if (n !== null && n >= total) continue; // the whole period already covers it
    const from = n === null ? days[0] : shiftDay(/** @type {string} */ (last), -(n - 1));
    const acc = new Map();
    for (const r of rows) if (!r.day || r.day >= from) addRow(acc, { ...r, day: undefined }, { template: false });
    windows[n === null ? 'all' : String(n)] = classify([...acc.values()], spec, { ...opt, days: n === null ? (opt.days ?? total) : n });
  }
  // Per-day series per operation (calls and 5xx), for sparklines.
  /** @type {Record<string, { calls: number[], e5: number[] }>} */
  const series = {};
  const all = windows.all;
  const idx = new Map(days.map((d, i) => [d, i]));
  for (const r of rows) {
    if (!r.day) continue;
    const op = matchOp(spec.ops, r.method, r.path);
    const k = op ? `${op.method} ${op.path}` : `${r.method} ${r.path}`;
    const s = (series[k] ||= { calls: Array(days.length).fill(0), e5: Array(days.length).fill(0) });
    const i = /** @type {number} */ (idx.get(r.day));
    s.calls[i] += r.calls;
    s.e5[i] += sumStatus(r.status, (c) => c >= 500);
  }
  // Recent spikes: over the error threshold in a short window but not over the whole period.
  const spikes = [];
  for (const n of ['3', '1', '7']) {
    const w = windows[n];
    if (!w) continue;
    for (const e of w.serverErrors) {
      if (all.serverErrors.some((x) => x.method === e.method && x.path === e.path)) continue;
      if (spikes.some((x) => x.method === e.method && x.path === e.path)) continue;
      const whole = all.endpoints.find((x) => x.method === e.method && x.path === e.path);
      spikes.push({ method: e.method, path: e.path, window: Number(n), calls: e.calls, errors5xx: e.errors5xx,
        share: e.errors5xx / e.calls, wholeShare: whole && whole.calls ? whole.errors5xx / whole.calls : 0 });
    }
  }
  return { days, windows, series, spikes };
}

/** @param {string} day @param {number} n */
function shiftDay(day, n) {
  return new Date(Date.parse(day + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
}
